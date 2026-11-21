import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  PermissionPolicyConflictError,
  persistPermissionPolicies,
  persistPermissionPoliciesIfUnchanged,
} from '../packages/cli/src/launcher/permission-rpc.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../packages/cli/src/permission-persistence.js'
import {
  createManagerRendererPermissionChannel,
  type ManagerPermissionPolicyAuthority,
} from '../packages/cli/src/cli/manager-renderer-permission.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'

const temporary = new Set<string>()
const identity = { source: 'file:///plugins/demo.js', id: 'demo' }
const gateway = { pid: 123, processStartedAt: 'fixture', instanceToken: 'a'.repeat(64) }
const record = (policy: 'allow' | 'deny') =>
  createPermissionPolicyRecord({
    profileId: 'work',
    identity,
    capability: 'models.read',
    scope: { providers: ['codex'] },
    policy,
  })
const payload = (requestId: string, policy: 'allow' | 'deny', marker = STANDALONE_PERMISSION_BINDING_MARKER) =>
  JSON.stringify({ requestId, token: marker, records: [record(policy)] })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

async function home() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-owner-permission-'))
  temporary.add(directory)
  const configPath = path.join(directory, '.cordisx', 'config.json')
  await ensureHomeConfig(configPath)
  return configPath
}

afterEach(async () => {
  delete globalThis.__cordisxPermissionPolicyRequestV1
  delete globalThis.__cordisxPermissionPolicyReceiveV1
  await Promise.all([...temporary].map(async directory => await rm(directory, { recursive: true, force: true })))
  temporary.clear()
})

async function fixture(input: { authority?: ManagerPermissionPolicyAuthority; allowed?: () => boolean } = {}) {
  const configPath = await home()
  const channel = createManagerRendererPermissionChannel({
    profileId: 'work',
    configPath,
    identityAllowed: candidate =>
      (input.allowed?.() ?? true) && candidate.id === identity.id
      && candidate.source === identity.source,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  })
  const sessions = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async proof => proof.instanceToken === gateway.instanceToken,
    channels: new Map([['permission-policy', channel]]),
  })
  const open = async (browserSessionId: string) => ({
    gateway,
    browserSessionId,
    handle: (await sessions.open(gateway, browserSessionId))!,
  })
  return { configPath, sessions, open }
}

function simulatedAuthority() {
  const snapshots = new Map<string, readonly CordisXPersistedPermissionPolicyRecord[]>()
  let tail = Promise.resolve()
  const completed = vi.fn()
  const fenced = vi.fn()
  const authority: ManagerPermissionPolicyAuthority = {
    isAdmitted: context => !context.signal.aborted && snapshots.has(context.rendererId),
    snapshot: context => snapshots.get(context.rendererId),
    authorize: () => true,
    acquire: async context => {
      const previous = tail
      const release = deferred<void>()
      tail = release.promise
      await previous
      let finished = false
      return {
        isCurrent: () => !finished && !context.signal.aborted,
        complete: policies => {
          completed(policies)
          for (const id of snapshots.keys()) snapshots.set(id, policies)
          finished = true
          release.resolve()
          return true
        },
        fence: () => {
          fenced()
          finished = true
          release.resolve()
        },
      }
    },
  }
  return { authority, snapshots, completed, fenced }
}

it('keeps writes unavailable without an owner authority and rejects the real owner token', async () => {
  const fake = simulatedAuthority()
  const absent = await fixture()
  const present = await fixture({ authority: fake.authority })
  try {
    const first = await absent.open('b'.repeat(64))
    const second = await present.open('c'.repeat(64))
    fake.snapshots.set(second.handle.rendererId, [])
    expect(await absent.sessions.call(first, 'permission-policy', payload('one', 'allow'))).toEqual({
      status: 'unavailable',
    })
    expect(await present.sessions.call(second, 'permission-policy', payload('two', 'allow', 'private-owner-token')))
      .toEqual({ status: 'unavailable' })
    expect((await loadHomeConfig(absent.configPath)).permissions).toEqual([])
    expect((await loadHomeConfig(present.configPath)).permissions).toEqual([])
  } finally {
    absent.sessions.dispose()
    present.sessions.dispose()
  }
})

it('requires the session-bound admission and owner-authorized action before persisting', async () => {
  const fake = simulatedAuthority()
  const authorize = vi.fn<ManagerPermissionPolicyAuthority['authorize']>(() => false)
  const test = await fixture({ authority: { ...fake.authority, authorize } })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    expect(await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).toEqual({ status: 'unknown' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize.mock.calls[0]?.[2]).toEqual([])
    expect(fake.fenced).not.toHaveBeenCalled()
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([])
  } finally {
    test.sessions.dispose()
  }
})

it('does not dispatch an action from a session that has not been admitted', async () => {
  const fake = simulatedAuthority()
  const acquire = vi.fn(fake.authority.acquire)
  const test = await fixture({ authority: { ...fake.authority, isAdmitted: () => false, acquire } })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    expect((await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).status).toBe('unknown')
    expect(acquire).not.toHaveBeenCalled()
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([])
  } finally {
    test.sessions.dispose()
  }
})

it('persists through the shared ledger only after a simulated owner synchronizes both clients', async () => {
  const fake = simulatedAuthority()
  const test = await fixture({ authority: fake.authority })
  try {
    const first = await test.open('b'.repeat(64))
    const second = await test.open('c'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    fake.snapshots.set(second.handle.rendererId, [])
    expect(await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).toEqual({
      status: 'ok',
      value: { requestId: 'one', ok: true, value: [record('allow')] },
    })
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
    expect(fake.snapshots.get(first.handle.rendererId)).toEqual([record('allow')])
    expect(fake.snapshots.get(second.handle.rendererId)).toEqual([record('allow')])
    expect(await test.sessions.call({ ...first, handle: second.handle }, 'permission-policy', payload('two', 'deny')))
      .toEqual({ status: 'unavailable' })
    expect(await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).toEqual({
      status: 'unavailable',
    })
    expect(fake.completed).toHaveBeenCalledOnce()
  } finally {
    test.sessions.dispose()
  }
})

it('uses the existing BindingPermissionPolicyStore over the admitted owner channel', async () => {
  const fake = simulatedAuthority()
  const test = await fixture({ authority: fake.authority })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    let sent = ''
    globalThis.__cordisxPermissionPolicyRequestV1 = text => {
      sent = text
      void test.sessions.call(first, 'permission-policy', text).then(result => {
        if (result.status === 'ok') globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify(result.value))
      })
    }
    const store = BindingPermissionPolicyStore.connect(STANDALONE_PERMISSION_BINDING_MARKER, [])
    try {
      await store.write([record('allow')])
      expect(store.read()).toEqual([record('allow')])
      expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
      expect(sent).not.toContain(first.handle.grant)
      expect(sent).not.toContain(gateway.instanceToken)
    } finally {
      store.dispose()
    }
  } finally {
    test.sessions.dispose()
  }
})

it('performs compare-and-write under the config lock so concurrent stale snapshots cannot overwrite', async () => {
  const configPath = await home()
  const write = async (policy: 'allow' | 'deny') =>
    await persistPermissionPoliciesIfUnchanged({
      configPath,
      profileId: 'work',
      expected: [],
      assertCurrent: () => {},
    }, [record(policy)])
  const results = await Promise.allSettled([write('allow'), write('deny')])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect(rejected.reason).toBeInstanceOf(PermissionPolicyConflictError)
  const saved = (await loadHomeConfig(configPath)).permissions
  expect(saved).toHaveLength(1)
})

it('rejects a stale pending client action even if another client finishes synchronization first', async () => {
  const fake = simulatedAuthority()
  const gate = deferred<void>()
  const entered = deferred<void>()
  let calls = 0
  const acquire = fake.authority.acquire
  const authority: ManagerPermissionPolicyAuthority = {
    ...fake.authority,
    acquire: async context => {
      const barrier = await acquire(context)
      if (!barrier) return undefined
      if (++calls !== 1) return barrier
      return {
        ...barrier,
        complete: async policies => {
          entered.resolve()
          await gate.promise
          return await barrier.complete(policies)
        },
      }
    },
  }
  const snapshot = vi.fn(authority.snapshot)
  const test = await fixture({ authority: { ...authority, snapshot } })
  try {
    const first = await test.open('b'.repeat(64))
    const second = await test.open('c'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    fake.snapshots.set(second.handle.rendererId, [])
    const one = test.sessions.call(first, 'permission-policy', payload('one', 'allow'))
    await entered.promise
    const two = test.sessions.call(second, 'permission-policy', payload('two', 'deny'))
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    gate.resolve()
    expect((await one).status).toBe('ok')
    expect((await two).status).toBe('unknown')
    expect(fake.fenced).toHaveBeenCalledOnce()
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
  } finally {
    gate.resolve()
    test.sessions.dispose()
  }
})

it('rejects a snapshot invalidated by another config writer', async () => {
  const fake = simulatedAuthority()
  const test = await fixture({ authority: fake.authority })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    await persistPermissionPolicies({ configPath: test.configPath }, [record('deny')])
    expect((await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).status).toBe('unknown')
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('deny')])
    expect(fake.fenced).toHaveBeenCalledOnce()
  } finally {
    test.sessions.dispose()
  }
})

it('aborts before commit when the user session is revoked during authorization', async () => {
  const fake = simulatedAuthority()
  const started = deferred<void>()
  const authorized = deferred<boolean>()
  const test = await fixture({
    authority: {
      ...fake.authority,
      authorize: async () => {
        started.resolve()
        return await authorized.promise
      },
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    const pending = test.sessions.call(first, 'permission-policy', payload('one', 'allow'))
    await started.promise
    await test.sessions.close(first)
    authorized.resolve(true)
    expect((await pending).status).toBe('unknown')
    expect(fake.fenced).not.toHaveBeenCalled()
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([])
  } finally {
    authorized.resolve(false)
    test.sessions.dispose()
  }
})

it('rechecks the package identity after waiting for the authorized action', async () => {
  const fake = simulatedAuthority()
  const started = deferred<void>()
  const authorized = deferred<boolean>()
  let current = true
  const test = await fixture({
    allowed: () => current,
    authority: {
      ...fake.authority,
      authorize: async () => {
        started.resolve()
        return await authorized.promise
      },
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    const pending = test.sessions.call(first, 'permission-policy', payload('one', 'allow'))
    await started.promise
    current = false
    authorized.resolve(true)
    expect((await pending).status).toBe('unknown')
    expect(fake.fenced).toHaveBeenCalledOnce()
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([])
  } finally {
    authorized.resolve(false)
    test.sessions.dispose()
  }
})

it('reports unknown and fences consumers if the session ends after the durable commit', async () => {
  const fake = simulatedAuthority()
  const entered = deferred<void>()
  const finish = deferred<void>()
  const acquire = fake.authority.acquire
  const test = await fixture({
    authority: {
      ...fake.authority,
      acquire: async context => {
        const barrier = await acquire(context)
        return barrier && {
          ...barrier,
          complete: async policies => {
            entered.resolve()
            await finish.promise
            return await barrier.complete(policies)
          },
        }
      },
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    const pending = test.sessions.call(first, 'permission-policy', payload('one', 'allow'))
    await entered.promise
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
    await test.sessions.close(first)
    finish.resolve()
    expect((await pending).status).toBe('unknown')
    expect(fake.fenced).toHaveBeenCalledOnce()
  } finally {
    finish.resolve()
    test.sessions.dispose()
  }
})

it('fences all consumers and reports unknown when the reply cannot be synchronized', async () => {
  const fake = simulatedAuthority()
  const acquire = fake.authority.acquire
  const test = await fixture({
    authority: {
      ...fake.authority,
      acquire: async context => {
        const barrier = await acquire(context)
        return barrier && { ...barrier, complete: async () => false }
      },
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    expect((await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).status).toBe('unknown')
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
    expect(fake.fenced).toHaveBeenCalledOnce()
    expect(await test.sessions.call(first, 'permission-policy', payload('two', 'deny'))).toEqual({
      status: 'unavailable',
    })
  } finally {
    test.sessions.dispose()
  }
})
