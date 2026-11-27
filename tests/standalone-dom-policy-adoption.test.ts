import { expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const identity = { id: 'channel', source: `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}` }
const generation = 'configured-1'
const navigation = 'manager.settings.navigation-items'
const content = 'manager.content'
const record = (pointId: string, policy: 'allow-persistent' | 'deny-persistent' = 'allow-persistent') => {
  const [value] = exactDomPermissionPolicies('default', [{
    id: identity.id,
    entry: '/fixture.js',
    pointIds: [pointId],
  }])
  return { ...value!, key: { ...value!.key, identity: { ...value!.key.identity, source: identity.source } }, policy }
}

function fixture(
  initial = [record(navigation), record(content)],
  prompt?: ConstructorParameters<typeof PermissionBroker>[8],
) {
  const store = new MemoryPermissionPolicyStore([], [], initial)
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
    undefined,
    undefined,
    prompt,
  )
  broker.register(
    identity,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: identity.id,
      capabilities: [],
      services: [],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration: generation },
  )
  return { broker, store }
}

it('adopts a peer denial and revokes only the changed Manager point lease', async () => {
  const { broker, store } = fixture()
  const write = vi.spyOn(store, 'writeV3')
  const initial = [record(navigation), record(content)]
  try {
    expect(broker.domAccess(identity, navigation).authorized).toBe(true)
    expect(broker.domAccess(identity, content).authorized).toBe(true)
    expect(
      await broker.adoptStandaloneDomPolicies({
        requestId: 'request-1',
        origin: false,
        identity,
        moduleGeneration: generation,
        expected: initial,
        updates: [record(content, 'deny-persistent')],
        candidate: [initial[0]!, record(content, 'deny-persistent')],
      }),
    ).toBe(true)
    expect(broker.hasDomLease(identity, navigation)).toBe(true)
    expect(broker.hasDomLease(identity, content)).toBe(false)
    expect(broker.domAccess(identity, content)).toMatchObject({ authorized: false, policy: 'deny' })
    expect(write).not.toHaveBeenCalled()
  } finally {
    broker.dispose()
  }
})

it('adopts an owner-confirmed Manager policy for the native canonical identity', async () => {
  const native = { id: identity.id, source: 'https://example.com/plugins/channel' }
  const convert = (value: ReturnType<typeof record>) => ({
    ...value,
    key: { ...value.key, identity: { ...value.key.identity, source: native.source } },
  })
  const allowed = convert(record(content))
  const denied = convert(record(content, 'deny-persistent'))
  const store = new MemoryPermissionPolicyStore([], [], [allowed])
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
  )
  broker.register(
    native,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: native.id,
      capabilities: [],
      services: [],
    }, native.id),
    { pluginId: native.id, moduleGeneration: generation },
  )
  const transition = {
    requestId: 'request-1',
    origin: false,
    identity: native,
    moduleGeneration: generation,
    expected: [allowed],
    updates: [denied],
    candidate: [denied],
  }
  try {
    expect(await broker.adoptStandaloneDomPolicies(transition)).toBe(false)
    expect(await broker.adoptOwnerManagerPolicies(transition)).toBe(true)
    expect(broker.domAccess(native, content)).toMatchObject({ authorized: false, policy: 'deny' })
    expect(await broker.adoptOwnerManagerPolicies(transition)).toBe(false)
  } finally {
    broker.dispose()
  }
})

it('rejects stale snapshots, other identities and policy fingerprints without changing the renderer', async () => {
  const { broker } = fixture()
  const initial = [record(navigation), record(content)]
  const denied = record(content, 'deny-persistent')
  try {
    for (
      const input of [
        { identity, moduleGeneration: generation, expected: [], candidate: [denied] },
        { identity, moduleGeneration: 'other', expected: initial, candidate: [initial[0]!, denied] },
        {
          identity: { ...identity, source: 'https://example.test/other' },
          moduleGeneration: generation,
          expected: initial,
          candidate: [initial[0]!, denied],
        },
        { identity, moduleGeneration: generation, expected: initial, candidate: [initial[0]!] },
        {
          identity,
          moduleGeneration: generation,
          expected: initial,
          candidate: [initial[0]!, {
            ...denied,
            key: { ...denied.key, securityFingerprint: `sha256:${'b'.repeat(64)}` },
          }],
        },
      ]
    ) {
      expect(
        await broker.adoptStandaloneDomPolicies({
          requestId: 'request-1',
          origin: false,
          updates: [denied],
          ...input,
        }),
      ).toBe(false)
    }
    expect(broker.domAccess(identity, content)).toMatchObject({ authorized: true, policy: 'allow' })
  } finally {
    broker.dispose()
  }
})

it('invalidates a pending one-time review before adopting a peer denial', async () => {
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const answer = new Promise<void>(resolve => {
    finish = resolve
  })
  const cancelV3 = vi.fn()
  const { broker } = fixture([], {
    request: async () => undefined,
    requestV3: async plan => {
      const view = new PermissionAuthorizationViewModel(plan)
      view.select('ui.extension-points.render', 'allow-once')
      const result = view.confirm()
      entered()
      await answer
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
    cancelV3,
  })
  try {
    const pending = broker.requestDomAccess(identity, content)
    await started
    expect(
      await broker.adoptStandaloneDomPolicies({
        requestId: 'request-1',
        origin: false,
        identity,
        moduleGeneration: generation,
        expected: [],
        updates: [record(content, 'deny-persistent')],
        candidate: [record(content, 'deny-persistent')],
      }),
    ).toBe(true)
    expect(cancelV3).toHaveBeenCalledOnce()
    finish()
    expect(await pending).toMatchObject({ authorized: false, reason: 'permission.policy-invalidated' })
    expect(broker.domAccess(identity, content)).toMatchObject({ authorized: false, policy: 'deny' })
  } finally {
    finish()
    broker.dispose()
  }
})

it('waits for a local policy write and rejects an obsolete owner snapshot', async () => {
  const { broker, store } = fixture([])
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const write = new Promise<void>(resolve => {
    finish = resolve
  })
  vi.spyOn(store, 'writeV3').mockImplementation(async () => {
    entered()
    await write
  })
  try {
    const local = broker.setDomPolicy(identity, content, 'allow-persistent')
    await started
    const adoption = broker.adoptStandaloneDomPolicies({
      requestId: 'request-1',
      origin: false,
      identity,
      moduleGeneration: generation,
      expected: [],
      updates: [record(content, 'deny-persistent')],
      candidate: [record(content, 'deny-persistent')],
    })
    finish()
    await local
    expect(await adoption).toBe(false)
    expect(broker.domPolicy(identity, content)).toBe('allow')
  } finally {
    finish()
    broker.dispose()
  }
})

it('does not apply a handoff after its renderer is revoked while a local write settles', async () => {
  const { broker, store } = fixture([])
  const lifetime = new AbortController()
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const write = new Promise<void>(resolve => {
    finish = resolve
  })
  vi.spyOn(store, 'writeV3').mockImplementation(async () => {
    entered()
    await write
  })
  try {
    const local = broker.setDomPolicy(identity, content, 'allow-persistent')
    await started
    const adoption = broker.adoptStandaloneDomPolicies({
      requestId: 'request-1',
      origin: false,
      identity,
      moduleGeneration: generation,
      expected: [record(content)],
      updates: [record(content, 'deny-persistent')],
      candidate: [record(content, 'deny-persistent')],
      signal: lifetime.signal,
    })
    lifetime.abort()
    finish()
    await local
    expect(await adoption).toBe(false)
    expect(broker.domPolicy(identity, content)).toBe('allow')
  } finally {
    finish()
    broker.dispose()
  }
})

async function pendingStandaloneWrite(onUnknown: () => void) {
  let receive!: (value: { requestId: string; records: unknown[] }) => void
  const sent = new Promise<{ requestId: string; records: unknown[] }>(resolve => receive = resolve)
  globalThis.__cordisxPermissionPolicyRequestV1 = text => receive(JSON.parse(text))
  const store = BindingPermissionPolicyStore.connect('standalone-fixture', [], { onUnknown })
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
  )
  broker.register(
    identity,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: identity.id,
      capabilities: [],
      services: [],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration: generation },
  )
  const write = broker.setDomPolicy(identity, content, 'allow-persistent')
  void write.catch(() => {})
  const request = await sent
  return { store, broker, write, request }
}

it('adopts the exact pending writer before its persistence reply without deadlocking', async () => {
  const onUnknown = vi.fn()
  const { store, broker, write, request } = await pendingStandaloneWrite(onUnknown)
  const update = record(content)
  const handoff = {
    requestId: request.requestId,
    origin: true,
    identity,
    moduleGeneration: generation,
    expected: [],
    updates: [update],
    candidate: [update],
    onUnknown,
  }
  try {
    expect(await broker.adoptStandaloneDomPolicies({ ...handoff, requestId: 'another-request' })).toBe(false)
    expect(broker.domPolicy(identity, content)).toBe('inherit')
    let settled = false
    void write.then(() => settled = true, () => settled = true)
    expect(await broker.adoptStandaloneDomPolicies(handoff)).toBe(true)
    expect(await broker.adoptStandaloneDomPolicies(handoff)).toBe(false)
    expect(broker.domPolicy(identity, content)).toBe('allow')
    expect(settled).toBe(false)
    globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
      requestId: request.requestId,
      ok: true,
      value: request.records,
    }))
    await write
    expect(store.readV3()).toEqual([update])
    expect(onUnknown).not.toHaveBeenCalled()
  } finally {
    store.dispose()
    broker.dispose()
    delete globalThis.__cordisxPermissionPolicyRequestV1
    delete globalThis.__cordisxPermissionPolicyReceiveV1
  }
})

it('invalidates the writer if an adopted policy loses its persistence reply', async () => {
  const onUnknown = vi.fn()
  const { store, broker, write, request } = await pendingStandaloneWrite(onUnknown)
  const update = record(content)
  try {
    expect(
      await broker.adoptStandaloneDomPolicies({
        requestId: request.requestId,
        origin: true,
        identity,
        moduleGeneration: generation,
        expected: [],
        updates: [update],
        candidate: [update],
        onUnknown,
      }),
    ).toBe(true)
    globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: false }))
    await expect(write).rejects.toThrow()
    expect(onUnknown).toHaveBeenCalled()
  } finally {
    store.dispose()
    broker.dispose()
    delete globalThis.__cordisxPermissionPolicyRequestV1
    delete globalThis.__cordisxPermissionPolicyReceiveV1
  }
})
