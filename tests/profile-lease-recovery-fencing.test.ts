import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const hooks = vi.hoisted(() => ({
  rename: undefined as undefined | (() => Promise<void>),
  remove: undefined as undefined | (() => Promise<void>),
  publish: undefined as undefined | (() => Promise<void>),
  commands: '',
  failCommands: false,
  failIdentityAfter: 0,
  identityCalls: 0,
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await hooks.rename?.()
      return actual.rename(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await hooks.remove?.()
      return actual.rm(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await hooks.publish?.()
      return actual.writeFile(...args)
    },
  }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (_file: string, args: string[]) => {
      if (args.includes('pid=,command=')) {
        if (hooks.failCommands) throw new Error('fixture ps unavailable')
        return hooks.commands
      }
      if (hooks.failIdentityAfter && ++hooks.identityCalls > hooks.failIdentityAfter) {
        throw new Error('fixture ps unavailable')
      }
      return `${process.pid} 1 Wed Sep 23 01:00:00 2026\n`
    },
  }
})
import { acquireCodexProfileLaunchLease } from '../packages/cli/src/launcher/profile-launch-lease.js'
import { processesUsingUserDataDir } from '../packages/cli/src/launcher/process-identity.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const roots: string[] = []
async function fixture(version = 2) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cordisx-recovery-fence-')))
  roots.push(root)
  const profile = path.join(root, 'profile')
  await mkdir(profile)
  const lock = `${profile}.cordisx-launch-lock`
  await mkdir(lock)
  await writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({
      version,
      pid: 2147483647,
      processStartedAt: 'gone',
      token: 'stale',
      userDataDir: profile,
    }),
  )
  return { root, profile, lock }
}

afterEach(async () => {
  hooks.rename = undefined
  hooks.remove = undefined
  hooks.publish = undefined
  hooks.commands = ''
  hooks.failCommands = false
  hooks.failIdentityAfter = 0
  hooks.identityCalls = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('profile recovery fencing', () => {
  it('prevents delayed reclaimers from moving a replacement lease', async () => {
    const f = await fixture()
    const inspecting = gate()
    const proceed = gate()
    let moves = 0
    hooks.rename = async () => {
      moves += 1
      inspecting.resolve()
      await proceed.promise
    }
    const pending = acquireCodexProfileLaunchLease(f.profile)
    await inspecting.promise
    try {
      await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('another launch or release operation')
      expect(moves).toBe(1)
    } finally {
      proceed.resolve()
    }
    const lease = await pending
    hooks.rename = undefined
    try {
      const owner = await readFile(path.join(f.lock, 'owner.json'), 'utf8')
      await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('in use by launcher process')
      expect(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).toBe(owner)
    } finally {
      await lease.release()
    }
  })

  it.each(['publication', 'release', 'failed publication cleanup'])(
    'fences %s against a second acquisition',
    async phase => {
      const f = await fixture()
      await rm(f.lock, { recursive: true })
      const entered = gate()
      const proceed = gate()
      const pause = async () => {
        entered.resolve()
        await proceed.promise
      }
      let lease: Awaited<ReturnType<typeof acquireCodexProfileLaunchLease>> | undefined
      if (phase === 'release') {
        lease = await acquireCodexProfileLaunchLease(f.profile)
        hooks.remove = pause
      } else if (phase === 'publication') hooks.publish = pause
      else {
        hooks.publish = async () => {
          throw new Error('fixture write failure')
        }
        hooks.remove = pause
      }
      const operation = (phase === 'release' ? lease!.release() : acquireCodexProfileLaunchLease(f.profile))
        .then(result => ({ result }), error => ({ error }))
      await entered.promise
      try {
        await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('another launch or release operation')
      } finally {
        proceed.resolve()
      }
      const outcome = await operation
      hooks.publish = undefined
      hooks.remove = undefined
      if (phase === 'failed publication cleanup') {
        expect(outcome).toMatchObject({ error: { message: 'fixture write failure' } })
      } else {
        expect('error' in outcome).toBe(false)
        if ('result' in outcome && outcome.result) await outcome.result.release()
      }
      const next = await acquireCodexProfileLaunchLease(f.profile)
      await next.release()
    },
  )

  it('never migrates a v1 lock that an older unfenced reclaimer could already have inspected', async () => {
    const f = await fixture(1)
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('Legacy v1 locks require manual cleanup')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
  })

  it('preserves stale records when process identity or holder enumeration is unavailable', async () => {
    const f = await fixture()
    hooks.failIdentityAfter = 1
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('could not be verified')
    hooks.failIdentityAfter = 0
    hooks.failCommands = true
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('could not be enumerated')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
  })

  it('recognizes a surviving Host through a different symlink and permits a known unrelated profile', async () => {
    const f = await fixture()
    const alias = path.join(f.root, 'alias')
    await symlink(f.profile, alias)
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${alias}\n`
    expect(processesUsingUserDataDir([f.profile])).toEqual([4343])
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
    const other = path.join(f.root, 'other')
    await mkdir(other)
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${other}\n`
    const lease = await acquireCodexProfileLaunchLease(f.profile)
    await lease.release()
  })

  it.each(['quoted', 'spaces', 'relative', 'missing', 'trailing arguments', 'duplicate'])(
    'fails closed for %s process arguments',
    async kind => {
      const f = await fixture()
      const args = {
        quoted: `--user-data-dir="${f.profile}"`,
        spaces: `--user-data-dir=${f.profile} with spaces`,
        relative: '--user-data-dir=relative',
        missing: `--user-data-dir=${f.profile}/absent`,
        'trailing arguments': `--user-data-dir=${f.profile} --inspect`,
        duplicate: `--user-data-dir=${f.profile} --user-data-dir=${f.profile}`,
      }[kind]
      hooks.commands = `4343 /Applications/Codex ${args}\n`
      await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('could not be enumerated')
      expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
    },
  )
})
