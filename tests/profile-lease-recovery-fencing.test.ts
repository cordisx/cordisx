import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
import {
  inspectProcessesUsingUserDataDir,
  processesUsingUserDataDir,
} from '../packages/cli/src/launcher/process-identity.js'

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
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${alias} --inspect=127.0.0.1:9229\n`
    expect(processesUsingUserDataDir([f.profile])).toEqual([4343])
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
    const other = path.join(f.root, 'other')
    await mkdir(other)
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${other}\n`
    const lease = await acquireCodexProfileLaunchLease(f.profile)
    await lease.release()
  })

  it('preserves a live holder using an unquoted symlink alias with spaces', async () => {
    const f = await fixture()
    const alias = path.join(f.root, 'alias with spaces')
    await symlink(f.profile, alias)
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${alias} --inspect\n`
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
  })

  it.each(['https://example.invalid', '-psn_0_1'])(
    'preserves a spaced symlink holder before trailing argument %s',
    async trailing => {
      const f = await fixture()
      const alias = path.join(f.root, 'alias with spaces')
      await symlink(f.profile, alias)
      hooks.commands = `4343 /Applications/Codex --user-data-dir=${alias} ${trailing}\n`
      await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
      expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
    },
  )

  it('preserves a live holder using an unquoted target profile containing spaces', async () => {
    const f = await fixture()
    const profile = path.join(f.root, 'profile with spaces')
    const lock = `${profile}.cordisx-launch-lock`
    await rename(f.profile, profile)
    await rename(f.lock, lock)
    const ownerPath = path.join(lock, 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
    await writeFile(ownerPath, JSON.stringify({ ...owner, userDataDir: profile }))
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${profile}\n`
    await expect(acquireCodexProfileLaunchLease(profile)).rejects.toThrow('still used by process 4343')
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).token).toBe('stale')
  })

  it.each(['quoted target', 'target before trailing arguments', 'duplicate target'])(
    'recognizes a live holder with %s',
    async kind => {
      const f = await fixture()
      const args = {
        'quoted target': `--user-data-dir="${f.profile}"`,
        'target before trailing arguments': `--user-data-dir=${f.profile} --inspect`,
        'duplicate target': `--user-data-dir=${f.profile} --user-data-dir=${f.profile}`,
      }[kind]
      hooks.commands = `4343 /Applications/Codex ${args}\n`
      await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
      expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
    },
  )

  it('fails closed when a quoted target value is followed without an argument boundary', async () => {
    const f = await fixture()
    hooks.commands = `4343 /Applications/Codex --user-data-dir="${f.profile}"suffix\n`
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('could not be enumerated')
    expect(JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).token).toBe('stale')
  })

  it('ignores unrelated absolute profile arguments', async () => {
    const f = await fixture()
    hooks.commands = [
      '4343 /Applications/Codex --user-data-dir=/tmp/unrelated-missing --inspect',
      '4344 /Applications/Codex --user-data-dir="/tmp/unrelated quoted" --inspect',
      '4345 /Applications/Codex --user-data-dir=relative --inspect',
    ].join('\n')
    const lease = await acquireCodexProfileLaunchLease(f.profile)
    await lease.release()
  })

  it('ignores an overlong speculative suffix after an absent unrelated profile', async () => {
    const f = await fixture()
    hooks.commands = `4343 /Applications/Codex --user-data-dir=/tmp/unrelated-missing ${'x'.repeat(2048)}\n`
    expect(inspectProcessesUsingUserDataDir([f.profile], () => hooks.commands)).toMatchObject({
      availability: 'available',
      holders: [],
      processCount: 1,
      relevantProcessCount: 1,
      candidateCount: 2,
      skippedOverlongCandidateCount: 1,
    })
    const lease = await acquireCodexProfileLaunchLease(f.profile)
    await lease.release()
  })

  it('recognizes an exact holder before the bounded candidate limit', async () => {
    const f = await fixture()
    hooks.commands = `4343 /Applications/Codex --user-data-dir=${f.profile} ${
      Array.from({ length: 70 }, (_, index) => `arg${index}`).join(' ')
    }\n`
    expect(inspectProcessesUsingUserDataDir([f.profile], () => hooks.commands)).toMatchObject({
      availability: 'available',
      holders: [4343],
      candidateCount: 64,
      skippedOverlongCandidateCount: expect.any(Number),
    })
    await expect(acquireCodexProfileLaunchLease(f.profile)).rejects.toThrow('still used by process 4343')
  })
})
