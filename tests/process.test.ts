import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireCodexProfileLaunchLease,
  assertLoopbackPortAvailable,
  codexExecutableCandidates,
  codexLaunchArgs,
  defaultIsolatedProfileDir,
  findFreeLoopbackPort,
  hiddenHostPidFromProcessList,
  launchCodex,
  ONLINE_DEVTOOLS_ORIGIN,
  prepareIsolatedCodexProfile,
  projectProfileKey,
  resolveCodexExecutable,
  terminateIsolatedCodex,
} from '../packages/cli/src/launcher/process.js'

describe('isolated Codex process support', () => {
  it('creates a stable project profile without inventing an isolated HOME', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-test-'))
    const profileDir = path.join(directory, 'codex-app-profile')
    try {
      const profile = await prepareIsolatedCodexProfile('/project/example', {
        cordisxHomeDir: path.join(directory, 'home'),
        explicitProfileDir: profileDir,
      })
      expect(profile).toEqual({ userDataDir: profileDir, cleanupOwned: false })
      await expect(access(profile.userDataDir)).resolves.toBeUndefined()
      if (process.platform !== 'win32') expect((await stat(profile.userDataDir)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('derives deterministic and checkout-specific default profile paths', () => {
    const home = path.join(path.sep, 'selected', 'cordisx-home')
    expect(projectProfileKey('/work/alpha')).toBe(projectProfileKey('/work/alpha'))
    expect(projectProfileKey('/work/alpha')).not.toBe(projectProfileKey('/other/alpha'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).toContain(path.join(home, 'projects'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).not.toContain(path.join(os.homedir(), '.cordisx'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).toMatch(/codex-app-profile$/)
  })

  it('puts enforced isolation and loopback arguments after user arguments', async () => {
    const profile = { userDataDir: '/safe/profile', cleanupOwned: true }
    const args = codexLaunchArgs(43123, ['--remote-debugging-port=1', '--user-data-dir=/unsafe'], profile, true)
    expect(args.slice(-4)).toEqual([
      '--user-data-dir=/safe/profile',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=43123',
      `--remote-allow-origins=http://127.0.0.1:43123,${ONLINE_DEVTOOLS_ORIGIN}`,
    ])
  })

  it('allocates a valid ephemeral port', async () => {
    const port = await findFreeLoopbackPort()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('matches hidden Host debug and inspector ports at exact argv boundaries', () => {
    const executable = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
    const processList = [
      `100 ${executable} --remote-debugging-port=60001 --inspect-brk=127.0.0.1:70001`,
      `101 ${executable} --remote-debugging-port=6000 --inspect-brk=127.0.0.1:70001`,
      `102 ${executable} --remote-debugging-port=6000 --inspect-brk=127.0.0.1:7000`,
    ].join('\n')
    expect(hiddenHostPidFromProcessList(processList, executable, 6000, 7000)).toBe(102)
    expect(hiddenHostPidFromProcessList(processList, executable, 600, 700)).toBeUndefined()
  })

  it('does not derive a Windows executable from cwd when LOCALAPPDATA is missing or relative', () => {
    expect(codexExecutableCandidates('win32', {}, 'C:\\Users\\example')).toEqual([])
    expect(codexExecutableCandidates('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\example')).toEqual([])
    expect(codexExecutableCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' }))
      .toEqual([
        'C:\\Users\\example\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        'C:\\Users\\example\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe',
      ])
  })

  it('prefers the newest installed Codex app bundle on macOS', async () => {
    const home = '/Users/example'
    const candidates = codexExecutableCandidates('darwin', {}, home)
    expect(candidates).toEqual([
      '/Applications/Codex.app/Contents/MacOS/ChatGPT',
      '/Applications/Codex.app/Contents/MacOS/Codex',
      '/Users/example/Applications/Codex.app/Contents/MacOS/ChatGPT',
      '/Users/example/Applications/Codex.app/Contents/MacOS/Codex',
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      '/Users/example/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    ])

    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-executable-order-test-'))
    const bundledChatGpt = path.join(directory, 'Codex.app', 'Contents', 'MacOS', 'ChatGPT')
    const standaloneChatGpt = path.join(directory, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT')
    try {
      await mkdir(path.dirname(bundledChatGpt), { recursive: true })
      await mkdir(path.dirname(standaloneChatGpt), { recursive: true })
      await writeFile(bundledChatGpt, '')
      await writeFile(standaloneChatGpt, '')
      await chmod(bundledChatGpt, 0o755)
      await chmod(standaloneChatGpt, 0o755)

      const versions = new Map([
        [bundledChatGpt, [7119n]],
        [standaloneChatGpt, [9275n]],
      ])
      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async executable => versions.get(executable),
        'darwin',
      )).resolves.toBe(standaloneChatGpt)

      versions.set(bundledChatGpt, [9276n])
      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async executable => versions.get(executable),
        'darwin',
      )).resolves.toBe(bundledChatGpt)

      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async () => undefined,
        'darwin',
      )).resolves.toBe(bundledChatGpt)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('rejects a directory passed as an explicit executable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-executable-test-'))
    try {
      await expect(resolveCodexExecutable(directory)).rejects.toThrow('host executable is not a regular file')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('rejects an occupied explicit loopback port', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      await expect(assertLoopbackPortAvailable(address.port)).rejects.toThrow(
        `loopback CDP port is unavailable: ${address.port}`,
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error === undefined ? resolve() : reject(error))
      )
    }
  })

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

  it('fails closed instead of reclaiming a stale profile lock by path', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-stale-profile-lease-test-'))
    const profile = path.join(directory, 'profile')
    await mkdir(profile)
    const canonicalProfile = await realpath(profile)
    const lock = `${canonicalProfile}.cordisx-launch-lock`
    await mkdir(lock)
    await writeFile(
      path.join(lock, 'owner.json'),
      `${
        JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          processStartedAt: 'stale',
          token: 'stale-token',
          userDataDir: canonicalProfile,
        })
      }\n`,
    )
    await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow('stale launch lock')
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

  it('terminates only the exact launched child and leaves a sibling alive', async () => {
    const script = 'setInterval(() => {}, 1000)'
    const launched = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    const sibling = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    try {
      await terminateIsolatedCodex(launched)
      expect(launched.exitCode !== null || launched.signalCode !== null).toBe(true)
      expect(sibling.exitCode).toBeNull()
      expect(sibling.signalCode).toBeNull()
    } finally {
      if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGTERM')
    }
  })

  it.skipIf(process.platform === 'win32')('cleans the full launcher-owned Host process group', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-launch-group-test-'))
    const executable = path.join(directory, 'fake-host')
    const descendantPidPath = path.join(directory, 'descendant.pid')
    const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
    let launched: ReturnType<typeof launchCodex> | undefined
    let descendantPid: number | undefined
    try {
      await writeFile(
        executable,
        `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
if (process.argv.includes('--descendant')) setInterval(() => {}, 1000)
else {
const child = spawn(process.argv[1], ['--descendant', '--database=${profile.userDataDir}/Crashpad'], { stdio: 'ignore', detached: true })
writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))
setInterval(() => {}, 1000)
}
`,
      )
      await chmod(executable, 0o755)
      launched = launchCodex(executable, 43123, [], profile)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        descendantPid = Number(await readFile(descendantPidPath, 'utf8').catch(() => '0'))
        if (Number.isInteger(descendantPid) && descendantPid > 0) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(descendantPid).toBeGreaterThan(0)
      await terminateIsolatedCodex(launched, profile)
      for (let attempt = 0; attempt < 50 && descendantPid !== undefined; attempt += 1) {
        try {
          process.kill(descendantPid, 0)
          await new Promise(resolve => setTimeout(resolve, 20))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          throw error
        }
      }
      expect(() => process.kill(descendantPid!, 0)).toThrow(/ESRCH/)
    } finally {
      if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
        await terminateIsolatedCodex(launched, profile).catch(() => undefined)
      }
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'does not terminate unrelated processes that mention a profile prefix',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owned-process-test-'))
      const executable = path.join(directory, 'fake-host')
      const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `${profile.userDataDir}-other`], {
        stdio: 'ignore',
      })
      let launched: ReturnType<typeof launchCodex> | undefined
      try {
        await writeFile(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n', { mode: 0o755 })
        launched = launchCodex(executable, 43124, [], profile)
        await new Promise(resolve => setTimeout(resolve, 75))
        await terminateIsolatedCodex(launched, profile)
        expect(unrelated.exitCode).toBeNull()
        expect(unrelated.signalCode).toBeNull()
      } finally {
        if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
          await terminateIsolatedCodex(launched, profile).catch(() => undefined)
        }
        if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGTERM')
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'tracks helpers created while the launched Host is shutting down',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-shutdown-child-test-'))
      const executable = path.join(directory, 'fake-host')
      const childPidPath = path.join(directory, 'shutdown-child.pid')
      const readyPath = path.join(directory, 'ready')
      const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
      let launched: ReturnType<typeof launchCodex> | undefined
      let childPid = 0
      try {
        await writeFile(
          executable,
          `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(readyPath)}, 'ready')
process.on('SIGTERM', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
  setTimeout(() => process.exit(0), 500)
})
setInterval(() => {}, 1000)
`,
          { mode: 0o755 },
        )
        launched = launchCodex(executable, 43125, [], profile)
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await readFile(readyPath, 'utf8').then(() => true).catch(() => false)) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await expect(readFile(readyPath, 'utf8')).resolves.toBe('ready')
        await terminateIsolatedCodex(launched, profile)
        childPid = Number(await readFile(childPidPath, 'utf8'))
        expect(childPid).toBeGreaterThan(0)
        expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
      } finally {
        if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
          await terminateIsolatedCodex(launched, profile).catch(() => undefined)
        }
        if (childPid > 0) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
