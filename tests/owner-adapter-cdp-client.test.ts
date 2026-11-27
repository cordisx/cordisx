import { expect, it, vi } from 'vitest'
import { OwnerAdapterCdpClient } from '../packages/cli/src/cli/owner-adapter-cdp-client.js'
import { createOwnerPolicySigner } from '../packages/cli/src/cli/owner-policy-signature.js'
import type { ManagerRendererCommand } from '../packages/cli/src/cli/manager-renderer-peer.js'
import {
  CdpPluginLifecycleRuntime,
  type CdpSharedAdmission,
} from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const previous: CordisXPluginActivationRecordV1 = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1,
  recordKind: 'active',
  profileId: 'default',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}
const candidate: CordisXPluginActivationRecordV1 = {
  ...previous,
  recordKind: 'candidate',
  transactionId: 'tx',
  revision: 1,
}
const mutation: PluginRuntimeMutation = {
  transactionId: 'tx',
  transactionEpoch: 'tx:epoch',
  expectedRegistryEpoch: 3,
  afterRegistryEpoch: 4,
  operation: 'install',
  targetId: 'one',
  affectedPluginIds: ['one', 'dependent'],
  previous,
  candidate,
}
const snapshot = { active: previous, registryEpoch: 3 }
const frame = (method: ManagerRendererCommand['method'], payload: unknown): ManagerRendererCommand => ({
  id: 'a'.repeat(64),
  sequence: 1,
  method,
  payload,
})

it('seeds a newly launched native fleet with the existing service epoch exactly once', () => {
  const runtime = new CdpPluginLifecycleRuntime()
  runtime.initializeOwnerRegistryEpoch(7)
  expect(runtime.currentRegistryEpoch()).toBe(7)
  expect(() => runtime.initializeOwnerRegistryEpoch(7)).toThrow('native adapter registry epoch is unavailable')
})

it('coordinates one owner transaction through the native CDP fleet', async () => {
  const admission = {
    readSnapshot: vi.fn(async () => snapshot),
    prepareBrowserGraph: vi.fn(async () => {}),
    stage: vi.fn(async () => ({
      transactionId: 'tx',
      transactionEpoch: 'tx:epoch',
      expectedRegistryEpoch: 3,
      afterRegistryEpoch: 4,
      observation: candidate,
      affectedPluginIds: ['dependent', 'one'],
    })),
    publish: vi.fn(async () => ({ published: true })),
    complete: vi.fn(async () => ({ completed: true })),
    finalize: vi.fn(async () => {}),
    release: vi.fn(),
  } as unknown as CdpSharedAdmission
  const terminal = vi.fn()
  const client = new OwnerAdapterCdpClient({
    cdp: { beginSharedAdmission: () => admission, terminal, refreshBrowserGraphBootstrap: async () => {} },
    loadMutation: async () => mutation,
  })
  expect(await client.handle(frame('synchronize', snapshot))).toEqual({ ok: true, value: snapshot })
  expect(
    await client.handle(frame('prepare', {
      transactionId: 'tx',
      transactionEpoch: 'tx:epoch',
      expectedRegistryEpoch: 3,
    })),
  ).toEqual({
    ok: true,
    value: { transactionId: 'tx', transactionEpoch: 'tx:epoch', expectedRegistryEpoch: 3 },
  })
  const staged = await client.handle(frame('stage', { transactionId: 'tx' }))
  expect(staged).toMatchObject({ ok: true, value: { affectedPluginIds: ['one', 'dependent'] } })
  expect(await client.handle(frame('publish', { transactionId: 'tx' }))).toEqual({
    ok: true,
    value: { published: true },
  })
  expect(await client.handle(frame('complete', { transactionId: 'tx' }))).toEqual({
    ok: true,
    value: { completed: true },
  })
  expect(await client.handle(frame('finalize', { transactionId: 'tx' }))).toEqual({
    ok: true,
    value: { transactionId: 'tx' },
  })
  expect(admission.release).toHaveBeenCalledTimes(2)
  expect(terminal).not.toHaveBeenCalled()
})

it('fences the native runtime if the owner disconnects during a transaction', async () => {
  const admission = {
    readSnapshot: vi.fn(async () => snapshot),
    prepareBrowserGraph: vi.fn(async () => {}),
    release: vi.fn(),
  } as unknown as CdpSharedAdmission
  const terminal = vi.fn()
  const client = new OwnerAdapterCdpClient({
    cdp: { beginSharedAdmission: () => admission, terminal, refreshBrowserGraphBootstrap: async () => {} },
    loadMutation: async () => mutation,
  })
  expect(
    (await client.handle(frame('prepare', {
      transactionId: 'tx',
      transactionEpoch: 'tx:epoch',
      expectedRegistryEpoch: 3,
    }))).ok,
  ).toBe(true)
  client.close()
  expect(terminal).toHaveBeenCalledOnce()
  expect(await client.handle(frame('stage', { transactionId: 'tx' }))).toEqual({ ok: false })
  expect(admission.release).not.toHaveBeenCalled()
})

it('adopts an owner policy in every native seat and refreshes future document bootstraps before acknowledging', async () => {
  const signer = createOwnerPolicySigner()
  const policyScope = { profileId: 'default', generation: 'owner-1', rendererId: 'c'.repeat(64) }
  const transition = {
    profileId: policyScope.profileId,
    ownerGeneration: policyScope.generation,
    rendererId: policyScope.rendererId,
    handoffId: 'b'.repeat(64),
    requestId: 'policy-1',
    origin: false as const,
    identity: { id: 'one', source: 'https://example.com/one' },
    moduleGeneration: 'module-1',
    expected: [],
    updates: [{}],
    candidate: [{}],
  }
  const packet = signer.sign(transition)
  const admission = {
    readSnapshot: vi.fn(async () => snapshot),
    adoptOwnerManagerPolicy: vi.fn(async () => {}),
    release: vi.fn(),
  } as unknown as CdpSharedAdmission
  const refresh = vi.fn(async () => {})
  const adopted = vi.fn(async () => {})
  const terminal = vi.fn()
  const client = new OwnerAdapterCdpClient({
    cdp: { beginSharedAdmission: () => admission, terminal, refreshBrowserGraphBootstrap: refresh },
    policyScope,
    onPolicyAdopted: adopted,
    loadMutation: async () => mutation,
  })
  expect(await client.handle(frame('permission-policy', packet))).toEqual({
    ok: true,
    value: {
      rendererId: transition.rendererId,
      ownerGeneration: transition.ownerGeneration,
      handoffId: transition.handoffId,
      requestId: transition.requestId,
      moduleGeneration: transition.moduleGeneration,
      adopted: true,
    },
  })
  expect(admission.adoptOwnerManagerPolicy).toHaveBeenCalledWith(packet)
  expect(refresh).toHaveBeenCalledWith(previous)
  expect(adopted).toHaveBeenCalledExactlyOnceWith(transition)
  expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(adopted.mock.invocationCallOrder[0]!)
  expect(admission.release).toHaveBeenCalledOnce()
  expect(terminal).not.toHaveBeenCalled()
})
