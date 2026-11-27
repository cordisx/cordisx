import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { SharedProfilePermissionFence } from '../packages/cli/src/config/profile-permission-fence.js'
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
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import type { CordisXPluginIdentity } from '../packages/cli/src/platform-contracts.js'
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

async function fixture(input: {
  authority?: ManagerPermissionPolicyAuthority
  allowed?: (candidate: CordisXPluginIdentity, context: ManagerRendererChannelContext) => boolean
  identityProjection?: Parameters<typeof createManagerRendererPermissionChannel>[0]['identityProjection']
} = {}) {
  const configPath = await home()
  const channel = createManagerRendererPermissionChannel({
    profileId: 'work',
    configPath,
    identityAllowed: (candidate, context) =>
      input.allowed?.(candidate, context)
        ?? (candidate.id === identity.id && candidate.source === identity.source),
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    ...(input.identityProjection === undefined ? {} : { identityProjection: input.identityProjection }),
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

it('permits the same proof after the owner rejected it before dispatch, but never after dispatch', async () => {
  const fake = simulatedAuthority()
  const authorize = vi.fn(fake.authority.authorize)
  const test = await fixture({ authority: { ...fake.authority, authorize } })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    const fence = await test.sessions.suspendMutations()
    const request = payload('one', 'allow')
    expect(await test.sessions.call(first, 'permission-policy', request)).toEqual({ status: 'unavailable' })
    expect(authorize).not.toHaveBeenCalled()
    expect(fence.release()).toBe(true)
    expect(await test.sessions.call(first, 'permission-policy', request)).toEqual({
      status: 'ok',
      value: { requestId: 'one', ok: true, value: [record('allow')] },
    })
    expect(authorize).toHaveBeenCalledOnce()
    expect(await test.sessions.call(first, 'permission-policy', request)).toEqual({ status: 'unavailable' })
    expect(authorize).toHaveBeenCalledOnce()
  } finally {
    test.sessions.dispose()
  }
})

it('resolves each renderer alias before a policy write and projects the receipt back', async () => {
  const fake = simulatedAuthority()
  const aliases = new Map<string, string>()
  const mapSource = (records: readonly CordisXPersistedPermissionPolicyRecord[], source: string) =>
    records.map(item => ({
      ...item,
      key: { ...item.key, identity: { ...item.key.identity, source } },
    }))
  const test = await fixture({
    authority: fake.authority,
    allowed: (candidate, context) =>
      candidate.id === identity.id && candidate.source === aliases.get(context.rendererId),
    identityProjection: {
      resolve: (records, context) => {
        if (records.some(item => item.key.identity.source !== aliases.get(context.rendererId))) throw new Error('alias')
        return mapSource(records, identity.source)
      },
      project: (records, context) => mapSource(records, aliases.get(context.rendererId)!),
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    const second = await test.open('c'.repeat(64))
    const firstAlias = 'https://renderer.cordisx.invalid/plugin/' + 'a'.repeat(64)
    const secondAlias = 'https://renderer.cordisx.invalid/plugin/' + 'b'.repeat(64)
    aliases.set(first.handle.rendererId, firstAlias)
    aliases.set(second.handle.rendererId, secondAlias)
    fake.snapshots.set(first.handle.rendererId, [])
    fake.snapshots.set(second.handle.rendererId, [])
    const request = (id: string, alias: string, policy: 'allow' | 'deny') =>
      JSON.stringify({
        requestId: id,
        token: STANDALONE_PERMISSION_BINDING_MARKER,
        records: mapSource([record(policy)], alias),
      })
    const firstResult = await test.sessions.call(first, 'permission-policy', request('first', firstAlias, 'allow'))
    expect(firstResult).toEqual({
      status: 'ok',
      value: { requestId: 'first', ok: true, value: mapSource([record('allow')], firstAlias) },
    })
    expect(JSON.stringify(firstResult)).not.toContain(identity.source)
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
    expect(await test.sessions.call(second, 'permission-policy', request('spoof', firstAlias, 'deny')))
      .toEqual({ status: 'unavailable' })
    expect(await test.sessions.call(second, 'permission-policy', request('second', secondAlias, 'deny')))
      .toEqual({
        status: 'ok',
        value: { requestId: 'second', ok: true, value: mapSource([record('deny')], secondAlias) },
      })
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('deny')])
  } finally {
    test.sessions.dispose()
  }
})

it('fences an already committed policy if its receipt cannot be safely projected', async () => {
  const fake = simulatedAuthority()
  const alias = 'https://renderer.cordisx.invalid/plugin/' + 'a'.repeat(64)
  let projectionCount = 0
  const mapSource = (item: CordisXPersistedPermissionPolicyRecord, source: string) => ({
    ...item,
    key: { ...item.key, identity: { ...item.key.identity, source } },
  })
  const test = await fixture({
    authority: fake.authority,
    allowed: candidate => candidate.id === identity.id && candidate.source === alias,
    identityProjection: {
      resolve: records => records.map(item => mapSource(item, identity.source)),
      // The initial projection is valid, but a later broken projector must not
      // send the owner-private source to a browser after the commit.
      project: records => ++projectionCount === 1 ? records.map(item => mapSource(item, alias)) : records,
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    const request = JSON.stringify({
      requestId: 'one',
      token: STANDALONE_PERMISSION_BINDING_MARKER,
      records: [mapSource(record('allow'), alias)],
    })
    expect(await test.sessions.call(first, 'permission-policy', request)).toEqual({ status: 'unknown' })
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
    expect(fake.fenced).toHaveBeenCalledOnce()
    expect(await test.sessions.call(first, 'permission-policy', request)).toEqual({ status: 'unavailable' })
  } finally {
    test.sessions.dispose()
  }
})

it('rejects an unavailable identity resolver before publishing a policy', async () => {
  const fake = simulatedAuthority()
  const test = await fixture({
    authority: fake.authority,
    identityProjection: {
      resolve: () => undefined as never,
      project: records => records,
    },
  })
  try {
    const first = await test.open('b'.repeat(64))
    fake.snapshots.set(first.handle.rendererId, [])
    expect(await test.sessions.call(first, 'permission-policy', payload('one', 'allow')))
      .toEqual({ status: 'unavailable' })
    expect((await loadHomeConfig(test.configPath)).permissions).toEqual([])
  } finally {
    test.sessions.dispose()
  }
})

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
        run: async action => await action(),
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

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'uses the owner-held profile fence when publishing an authorized two-session policy',
  async () => {
    const snapshots = new Map<string, readonly CordisXPersistedPermissionPolicyRecord[]>()
    let fence!: SharedProfilePermissionFence
    const authority: ManagerPermissionPolicyAuthority = {
      isAdmitted: context => !context.signal.aborted && snapshots.has(context.rendererId),
      snapshot: context => snapshots.get(context.rendererId),
      authorize: () => true,
      acquire: (context, request, expected) => {
        let active = true
        const current = () => active && !context.signal.aborted
        return {
          isCurrent: current,
          run: async action =>
            await fence.runPolicyMutation({ expected, updates: request.records, isCurrent: current }, action),
          complete: policies => {
            for (const id of snapshots.keys()) snapshots.set(id, policies)
            active = false
            return true
          },
          fence: () => {
            active = false
          },
        }
      },
    }
    const test = await fixture({ authority })
    fence = new SharedProfilePermissionFence(test.configPath, 'work')
    try {
      const first = await test.open('b'.repeat(64))
      const second = await test.open('c'.repeat(64))
      snapshots.set(first.handle.rendererId, [])
      snapshots.set(second.handle.rendererId, [])
      const releaseFirst = await fence.acquire()
      const releaseSecond = await fence.acquire()
      expect(await test.sessions.call(first, 'permission-policy', payload('one', 'allow'))).toEqual({
        status: 'ok',
        value: { requestId: 'one', ok: true, value: [record('allow')] },
      })
      expect((await loadHomeConfig(test.configPath)).permissions).toEqual([record('allow')])
      expect(snapshots.get(second.handle.rendererId)).toEqual([record('allow')])
      await expect(persistPermissionPolicies({ configPath: test.configPath }, [record('deny')]))
        .rejects.toThrow('permission policy is in use')
      await releaseFirst()
      await releaseSecond()
    } finally {
      test.sessions.dispose()
      await fence.close()
    }
  },
  30_000,
)

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
    acquire: async (context, request, expected) => {
      const barrier = await acquire(context, request, expected)
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
    const closing = test.sessions.close(first)
    authorized.resolve(true)
    expect((await pending).status).toBe('unknown')
    expect(await closing).toBe(false)
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
      acquire: async (context, request, expected) => {
        const barrier = await acquire(context, request, expected)
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
    const closing = test.sessions.close(first)
    finish.resolve()
    expect((await pending).status).toBe('unknown')
    expect(await closing).toBe(false)
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
      acquire: async (context, request, expected) => {
        const barrier = await acquire(context, request, expected)
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
