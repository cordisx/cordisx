import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { type ChildProcess, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fixturePids = vi.hoisted(() => new Set<number>())
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options: { encoding: 'utf8' }) => {
      const output = actual.execFileSync(file, args, options)
      // Keep real child argv evidence without depending on unrelated desktop apps.
      return args.includes('pid=,command=')
        ? output.split('\n').filter(line => fixturePids.has(Number(/^\s*(\d+)/u.exec(line)?.[1]))).join('\n')
        : output
    },
  }
})
import { acquireCodexProfileLaunchLease } from '../packages/cli/src/launcher/profile-launch-lease.js'
import { acquireKernelOperationLock } from '../packages/cli/src/launcher/kernel-operation-lock.js'
import {
  liveProcessStartedAt,
  processesUsingUserDataDir,
  recordedProcessStatus,
} from '../packages/cli/src/launcher/process-identity.js'

const NEVER_A_PID = 2_147_483_647

async function writeLock(
  profile: string,
  owner: Partial<{ pid: number; processStartedAt: string; token: string; userDataDir: string }> | undefined,
): Promise<string> {
  const lock = `${await realpath(profile)}.cordisx-launch-lock`
  await mkdir(lock)
  if (owner !== undefined) {
    await writeFile(
      path.join(lock, 'owner.json'),
      `${
        JSON.stringify({
          version: 2,
          pid: NEVER_A_PID,
          processStartedAt: 'gone',
          token: 'stale-token',
          userDataDir: await realpath(profile),
          ...owner,
        })
      }\n`,
    )
  }
  return lock
}

/** A process whose command line carries the profile, like a Host tree that outlived its launcher. */
function spawnProfileHolder(profile: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`], {
    stdio: 'ignore',
  })
  fixturePids.add(child.pid!)
  return child
}

async function waitForHolderVisibility(profile: string, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processesUsingUserDataDir([profile])?.includes(pid)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`process ${pid} never appeared in the process table with ${profile}`)
}

async function stop(child: ChildProcess): Promise<void> {
  fixturePids.delete(child.pid!)
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

describe('Codex profile launch lease', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'shares the canonical operation fence across foreground processes and separate homes',
    async () => {
      const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cordisx-cross-home-lease-')))
      const profile = path.join(directory, 'profile')
      const alias = path.join(directory, 'alias')
      await mkdir(profile)
      await symlink(profile, alias)
      const moduleUrl = new URL('../packages/cli/src/launcher/profile-launch-lease.ts', import.meta.url).href
      const unlock = await acquireKernelOperationLock(`${profile}.cordisx-launch-mutex`)
      const children: ChildProcess[] = []
      try {
        for (const [index, target] of [profile, alias].entries()) {
          const child = spawn(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `import { acquireCodexProfileLaunchLease } from ${JSON.stringify(moduleUrl)};
             try { await acquireCodexProfileLaunchLease(process.argv[1]); process.exitCode = 1 }
             catch (error) { process.stdout.write(error.message) }`,
            target,
          ], {
            env: { ...process.env, CORDISX_HOME: path.join(directory, `home-${index}`) },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          children.push(child)
          let output = ''
          child.stdout!.on('data', chunk => {
            output += String(chunk)
          })
          child.stderr!.on('data', chunk => {
            output += String(chunk)
          })
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', resolve)
          })
          expect(code, output).toBe(0)
          expect(output).toContain('another launch or release operation')
        }
      } finally {
        await unlock()
        for (const child of children) await stop(child)
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('holds an exclusive launch lease without deleting the persistent profile', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-lease-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    await writeFile(path.join(profile, 'sentinel'), 'preserved')
    const first = await acquireCodexProfileLaunchLease(profile)
    try {
      await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow('profile is in use')
      expect(await readFile(path.join(profile, 'sentinel'), 'utf8')).toBe('preserved')
    } finally {
      await first.release()
    }
    const second = await acquireCodexProfileLaunchLease(profile)
    await second.release()
    expect(await readFile(path.join(profile, 'sentinel'), 'utf8')).toBe('preserved')
    await rm(directory, { recursive: true, force: true })
  })

  it('acquires a launch lease beneath an empty root without creating profile contents', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-empty-profile-lease-test-'))
    const profile = path.join(directory, 'apps', 'codex', 'profiles', 'fresh', 'chromium')
    const lease = await acquireCodexProfileLaunchLease(profile)
    try {
      await expect(access(path.dirname(profile))).resolves.toBeUndefined()
      await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${profile}.cordisx-launch-lock/owner.json`)).resolves.toBeUndefined()
    } finally {
      await lease.release()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'shares one launch lease across equivalent symlink parent paths',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-symlink-profile-lease-test-'))
      const actualParent = path.join(directory, 'actual')
      const linkedParent = path.join(directory, 'linked')
      await mkdir(actualParent)
      await symlink(actualParent, linkedParent)
      const first = await acquireCodexProfileLaunchLease(path.join(linkedParent, 'profile'))
      try {
        await expect(acquireCodexProfileLaunchLease(path.join(actualParent, 'profile')))
          .rejects.toThrow('profile is in use')
      } finally {
        await first.release()
      }
      const second = await acquireCodexProfileLaunchLease(path.join(actualParent, 'profile'))
      await second.release()
      await rm(directory, { recursive: true, force: true })
    },
  )

  it('reclaims a stale lock left by a launcher process that no longer exists', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-stale-profile-lease-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    await writeFile(path.join(profile, 'sentinel'), 'preserved')
    const lock = await writeLock(profile, {})
    const reports: string[] = []
    const lease = await acquireCodexProfileLaunchLease(profile, { stdout: line => reports.push(line) })
    try {
      expect(reports).toEqual([
        `[cordisx] reclaimed stale Codex profile launch lock left by exited launcher process ${NEVER_A_PID} (started gone): ${lock}`,
      ])
      const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as { pid: number; token: string }
      expect(owner.pid).toBe(process.pid)
      expect(owner.token).not.toBe('stale-token')
      expect(await readFile(path.join(profile, 'sentinel'), 'utf8')).toBe('preserved')
      expect((await readdir(directory)).filter(name => name.includes('.stale-'))).toEqual([])
      await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow(
        `in use by launcher process ${process.pid}`,
      )
    } finally {
      await lease.release()
    }
    await expect(access(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(directory, { recursive: true, force: true })
  })

  it('treats a reused PID with a different start time as an exited launcher', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-reused-pid-lease-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    await writeLock(profile, { pid: process.pid, processStartedAt: 'not this process' })
    const reports: string[] = []
    const lease = await acquireCodexProfileLaunchLease(profile, { stdout: line => reports.push(line) })
    try {
      expect(reports).toHaveLength(1)
      expect(reports[0]).toContain(`exited launcher process ${process.pid} (started not this process)`)
    } finally {
      await lease.release()
    }
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to reclaim while a live process still uses the profile',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-held-profile-lease-test-'))
      const profile = path.join(directory, 'profile')
      await mkdir(profile)
      const lock = await writeLock(profile, {})
      const holder = spawnProfileHolder(profile)
      try {
        await waitForHolderVisibility(profile, holder.pid!)
        const reports: string[] = []
        await expect(acquireCodexProfileLaunchLease(profile, { stdout: line => reports.push(line) }))
          .rejects.toThrow(
            `Codex profile launch lock owner ${NEVER_A_PID} has exited, but the profile is still used by process ${holder.pid}; stop that Host before launching`,
          )
        expect(reports).toEqual([])
        expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toContain('stale-token')
      } finally {
        await stop(holder)
      }
      const lease = await acquireCodexProfileLaunchLease(profile)
      await lease.release()
      await rm(directory, { recursive: true, force: true })
    },
  )

  it('fails closed for an unrecognized lock instead of reclaiming it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-unrecognized-lease-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    const lock = await writeLock(profile, undefined)
    await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow(
      `unrecognized launch lock; inspect ${lock} before launching`,
    )
    await rm(lock, { recursive: true, force: true })
    await writeLock(profile, { userDataDir: path.join(directory, 'other-profile') })
    await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow('unrecognized launch lock')
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toContain('stale-token')
    await rm(directory, { recursive: true, force: true })
  })

  it('retries release after ownership verification fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-release-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    const lease = await acquireCodexProfileLaunchLease(profile)
    const ownerPath = `${profile}.cordisx-launch-lock/owner.json`
    const owner = await readFile(ownerPath, 'utf8')
    await writeFile(ownerPath, owner.replace(/"token":"[^"]+"/u, '"token":"changed"'))
    await expect(lease.release()).rejects.toThrow('ownership changed')
    await writeFile(ownerPath, owner)
    await expect(Promise.all([lease.release(), lease.release()])).resolves.toEqual([undefined, undefined])
    await rm(directory, { recursive: true, force: true })
  })
})

describe('recorded process identity', () => {
  it('reports a process alive only under its recorded start time', () => {
    const startedAt = liveProcessStartedAt(process.pid)
    expect(startedAt).toBeDefined()
    expect(recordedProcessStatus(process.pid, startedAt!)).toBe('alive')
    expect(recordedProcessStatus(process.pid, 'another start time')).toBe('dead')
    expect(recordedProcessStatus(NEVER_A_PID, startedAt!)).toBe('dead')
  })

  it.skipIf(process.platform === 'win32')(
    'lists only processes launched with an exact user-data-dir argument',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-holder-test-'))
      const profile = path.join(directory, 'profile')
      await mkdir(profile)
      await mkdir(`${profile}-other`)
      const exact = spawnProfileHolder(profile)
      const longer = spawnProfileHolder(`${profile}-other`)
      try {
        await waitForHolderVisibility(profile, exact.pid!)
        await waitForHolderVisibility(`${profile}-other`, longer.pid!)
        const holders = processesUsingUserDataDir([profile])
        expect(holders).toContain(exact.pid)
        expect(holders).not.toContain(longer.pid)
        expect(holders).not.toContain(process.pid)
      } finally {
        await stop(exact)
        await stop(longer)
      }
      await rm(directory, { recursive: true, force: true })
    },
  )
})
