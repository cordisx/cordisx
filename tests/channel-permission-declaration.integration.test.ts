import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as credentialPrompt from '../packages/cli/src/renderer/channel-credential-prompt.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { normalizePluginManifestV16 } from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  type CordisXPermissionAuthorizationPlanV2,
} from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'
import { createRuntimeSetPermissionPolicy } from '../packages/cli/src/renderer/runtime-manager-actions.js'
import type { RuntimeClosureScope } from '../packages/cli/src/renderer/runtime-closure-scope.js'
import type { PluginController } from '../packages/cli/src/renderer/runtime-shared.js'
import {
  type ChannelManagerProjectionV1,
  CordisXChannelManagerService,
} from '../packages/cli/src/renderer/channel-manager.js'

const identity = { source: 'file:///channel-test-artifact', id: 'channel' }
const ref = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test' }
// Preserve the frozen delegated consumer. The current Channel consumer uses
// a separate owned-service facade and deliberately omits these declarations.
const manifestFile = process.env.CORDISX_CHANNEL_DELEGATED_MANIFEST_FIXTURE
  ?? new URL('./fixtures/channel-runtime-manifest-v16.json', import.meta.url)
async function actualManifest() {
  return JSON.parse(await readFile(manifestFile, 'utf8'))
}
function decide(
  plan: CordisXPermissionAuthorizationPlanV2,
  choice: 'allow-once' | 'deny-once' | 'allow-persistent' = 'allow-once',
) {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2 as const,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: choice,
    })),
  }
}
function brokerFixture(
  request: (
    plan: CordisXPermissionAuthorizationPlanV2,
  ) => ReturnType<typeof decide> | undefined | Promise<ReturnType<typeof decide> | undefined>,
) {
  const store = new MemoryPermissionPolicyStore()
  const prompt = vi.fn(request)
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    100,
    'test',
    'runtime',
    undefined,
    undefined,
    { request: prompt },
  )
  return { store, broker, prompt }
}
function projection(): ChannelManagerProjectionV1 {
  return {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: 'implemented',
    service: {
      configurationKind: 'host',
      configApplies: 'service-restart',
      revision: 1,
      lastGoodRevision: 1,
      writable: true,
    },
    connections: [{ ref, adapterKind: 'feishu', enabled: true, transportMode: 'websocket', secretState: 'ready' }],
    accounts: [],
    routes: [],
    diagnostics: [],
    bindings: [{
      bindingId: 'one',
      channel: { ...ref, conversationId: 'oc_test', threadId: 'oc_test' },
      session: { providerId: 'codex', remoteSessionId: 'own-test-chat' },
      routeId: 'route',
      state: 'active',
    }],
  }
}

describe('frozen delegated Channel manifest through Host admission and broker', () => {
  it('loads its exact-write declarations and explains them without fabricating activation grants', async () => {
    const source = await actualManifest()
    expect(normalizePluginManifestV16(source, 'channel').schemaVersion).toBe(16)
    const manifest = normalizePluginManifest(source, 'channel')
    const f = brokerFixture(plan => decide(plan))
    try {
      f.broker.register(identity, manifest)
      expect(f.broker.runtimeExactExplanations().map(item => item.capability)).toEqual([
        'channel.accounts.connect',
        'channel.bindings.write',
      ])
      expect(f.broker.authorizationPlanV2(identity).declarations.map(item => item.capability)).not.toContain(
        'channel.accounts.connect',
      )
      expect(f.broker.authorizationPlanV2(identity).declarations.map(item => item.capability)).not.toContain(
        'channel.bindings.write',
      )
      expect(await f.broker.authorizeChannel(identity, 'channel.accounts.connect', {})).toBe(false)
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.store.records).toHaveLength(0)
      const old = { ...source, $schema: source.$schema.replace('v16', 'v8'), schemaVersion: 8 }
      expect(() => normalizePluginManifest(old, 'channel')).toThrow()
    } finally {
      f.broker.dispose()
    }
  })

  it('recovers the actual v16 plugin through the Manager policy action without treating Channel as a legacy capability', async () => {
    const manifest = normalizePluginManifest(await actualManifest(), 'channel')
    const f = brokerFixture(plan => decide(plan))
    f.broker.register(identity, manifest)
    const controller = {
      identity,
      manifest,
      status: 'permission-blocked',
      item: { id: 'channel', enabled: true, module: { apply() {} } },
    } as unknown as PluginController
    const mount = vi.fn(async (value: PluginController) => {
      value.status = 'active'
    })
    const dispose = vi.fn(async () => {})
    const scope = {
      operation: Promise.resolve(),
      disposed: false,
      activeController: () => (id: string) => id === 'channel' ? controller : undefined,
      broker: () => f.broker,
      requiredBlockReason: () => () =>
        f.broker.requiredDenied(identity).length ? 'Required Channel permission' : undefined,
      disposeControllerFiber: () => dispose,
      blockedPlugins: () => new Set<string>(),
      mountPlugin: () => mount,
      notify: () => () => {},
    } as unknown as RuntimeClosureScope
    try {
      await createRuntimeSetPermissionPolicy(scope, 'channel', 'channel.accounts.read', 'allow', {})
      expect(controller.status).toBe('active')
      expect(mount).toHaveBeenCalledTimes(1)
      expect(f.store.readV2()).toMatchObject([{
        key: { identity: { pluginId: 'channel' }, capability: 'channel.accounts.read', scope: {} },
        policy: 'allow-persistent',
      }])
      expect(await f.broker.authorizeChannel(identity, 'channel.accounts.read', {})).toBe(true)
      await createRuntimeSetPermissionPolicy(scope, 'channel', 'channel.accounts.read', 'deny', {})
      expect(controller.status).toBe('permission-blocked')
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(await f.broker.authorizeChannel(identity, 'channel.accounts.read', {})).toBe(false)
      await createRuntimeSetPermissionPolicy(scope, 'channel', 'channel.accounts.read', 'allow', {})
      expect(controller.status).toBe('active')
      expect(mount).toHaveBeenCalledTimes(2)
      await expect(createRuntimeSetPermissionPolicy(scope, 'channel', 'channel.accounts.connect', 'allow', {}))
        .rejects.toThrow('does not declare channel.accounts.connect')
      expect(f.store.records.some(item => JSON.stringify(item).includes('exact-request'))).toBe(false)
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      f.broker.dispose()
    }
  })

  it('keys a connect grant to the actual account and checks every high-risk binding write', async () => {
    const f = brokerFixture(plan =>
      decide(plan, plan.declarations[0]!.capability === 'channel.accounts.connect' ? 'allow-persistent' : 'allow-once')
    )
    try {
      f.broker.register(identity, normalizePluginManifest(await actualManifest(), 'channel'))
      expect(await f.broker.authorizeChannel(identity, 'channel.accounts.connect', { channelAccount: ref })).toBe(true)
      expect(await f.broker.authorizeChannel(identity, 'channel.accounts.connect', { channelAccount: ref })).toBe(true)
      expect(f.prompt).toHaveBeenCalledTimes(1)
      const first = f.prompt.mock.calls[0]![0].declarations[0]!
      expect(first.scope).toEqual({ channelAccounts: [{ adapterId: ref.adapterId, accountId: ref.accountId }] })
      expect(
        await f.broker.authorizeChannel(identity, 'channel.accounts.connect', {
          channelAccount: { ...ref, accountId: 'cli_other' },
        }),
      ).toBe(true)
      expect(f.prompt).toHaveBeenCalledTimes(2)
      expect(f.prompt.mock.calls[1]![0].declarations[0]!.securityFingerprint).not.toBe(first.securityFingerprint)
      expect(await f.broker.authorizeChannel(identity, 'channel.bindings.write', { channelTenant: ref })).toBe(true)
      expect(await f.broker.authorizeChannel(identity, 'channel.bindings.write', { channelTenant: ref })).toBe(true)
      expect(f.prompt).toHaveBeenCalledTimes(4)
      expect(f.prompt.mock.calls[3]![0].declarations[0]!.scope).toEqual({ channelTenants: [ref] })
      expect(f.store.records.some(item => JSON.stringify(item).includes('exact-request'))).toBe(false)
    } finally {
      f.broker.dispose()
    }
  })

  it('retiring a generation while the permission is open prevents a late decision from authorizing dispatch', async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const f = brokerFixture(async plan => {
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
      return decide(plan)
    })
    try {
      const retire = f.broker.register(identity, normalizePluginManifest(await actualManifest(), 'channel'), {
        pluginId: 'channel',
        moduleGeneration: 'one',
      })
      const result = f.broker.authorizeChannel(identity, 'channel.accounts.connect', { channelAccount: ref })
      await started
      retire()
      release()
      expect(await result).toBe(false)
      expect(f.store.records).toHaveLength(0)
    } finally {
      f.broker.dispose()
    }
  })

  it('resolves real opaque binding targets before permission and rechecks denial without dispatch', async () => {
    let allow = true
    const f = brokerFixture(plan => decide(plan, allow ? 'allow-once' : 'deny-once'))
    const context = new Context()
    f.broker.register(identity, normalizePluginManifest(await actualManifest(), 'channel'))
    const run = vi.fn(async () => ({ status: 'applied' as const }))
    const fiber = context.plugin(CordisXChannelManagerService, {
      projection: projection(),
      profileId: 'test',
      hostGeneration: 'runtime',
      broker: f.broker,
      actions: { run },
    })
    await fiber
    const plugin = context.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    try {
      const snapshot = plugin.channelManager.snapshot(), binding = snapshot.bindings[0]!
      const request = {
        contract: 'cordisx.channel-manager-request/v2' as const,
        schemaVersion: 2 as const,
        requestId: 'own-bind-write',
        profileId: 'test',
        hostGeneration: 'runtime',
        expectedRevision: snapshot.revision,
        operation: 'binding.unbind' as const,
        target: {
          kind: 'binding' as const,
          bindingToken: binding.bindingToken,
          bindingRevision: binding.bindingRevision,
        },
      }
      expect(await plugin.channelManager.execute(request)).toMatchObject({ status: 'applied' })
      expect(run).toHaveBeenCalledWith('unbind', { bindingId: 'one' })
      expect(f.prompt.mock.calls[0]![0].declarations[0]!.scope).toEqual({ channelTenants: [ref] })
      allow = false
      expect(
        await plugin.channelManager.execute({
          ...request,
          expectedRevision: plugin.channelManager.snapshot().revision,
        }),
      ).toMatchObject({ status: 'rejected', code: 'PERMISSION_DENIED' })
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
      f.broker.dispose()
    }
  })

  it('keeps the calling plugin identity for credential capture and rechecks it before commit', async () => {
    let allowConnect = false
    const f = brokerFixture(plan => decide(plan, allowConnect ? 'allow-once' : 'deny-once'))
    f.broker.register(identity, normalizePluginManifest(await actualManifest(), 'channel'))
    await f.broker.setPolicyV2(identity, 'channel.accounts.read', 'allow-persistent')
    const newAccount = { ...ref, accountId: 'cli_new_fixture' }
    const request = vi.fn(async (input: Record<string, unknown>) =>
      input.operation === 'capture'
        ? {
          status: 'applied' as const,
          code: 'APPLIED',
          ref: newAccount,
          draftId: 'private-fixture',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : { status: 'applied' as const, code: 'APPLIED' }
    )
    const prompt = vi.spyOn(credentialPrompt, 'captureChannelCredential')
      .mockImplementation(async input => input.submit(newAccount, 'fixture-secret', input.signal))
    const context = new Context()
    const fiber = context.plugin(CordisXChannelManagerService, {
      projection: projection(),
      profileId: 'test',
      hostGeneration: 'runtime',
      broker: f.broker,
      document: {} as Document,
      credentialRequest: request,
    })
    await fiber
    const plugin = context.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    const fence = () => ({
      profileId: 'test',
      hostGeneration: 'runtime',
      requestId: 'own-credential-write',
      expectedRevision: plugin.channelManager.snapshot().revision,
    })
    const issue = () =>
      plugin.channelManager.issue({
        ...fence(),
        contract: 'cordisx.channel-manager-target-request/v1',
        schemaVersion: 1,
        operation: 'target.credential.capture.create',
        adapterKind: 'feishu',
        purpose: 'create',
        target: { kind: 'root' },
      })
    try {
      const denied = await issue()
      expect(
        await plugin.channelManager.execute({
          ...fence(),
          contract: 'cordisx.channel-manager-request/v2',
          schemaVersion: 2,
          operation: 'credential.capture',
          target: denied.target!,
        }),
      ).toMatchObject({ status: 'rejected', code: 'CAPTURE_CANCELLED' })
      expect(request).not.toHaveBeenCalled()
      expect(f.prompt).toHaveBeenCalledTimes(1)
      expect(f.prompt.mock.calls[0]![0]).toMatchObject({
        identity: { pluginId: identity.id, source: identity.source },
        declarations: [{
          capability: 'channel.accounts.connect',
          scope: {
            channelAccounts: [{ adapterId: newAccount.adapterId, accountId: newAccount.accountId }],
          },
        }],
      })
      allowConnect = true
      const issued = await issue()
      const captured = await plugin.channelManager.execute({
        ...fence(),
        contract: 'cordisx.channel-manager-request/v2',
        schemaVersion: 2,
        operation: 'credential.capture',
        target: issued.target!,
      })
      expect(captured.status).toBe('applied')
      const connection = await plugin.channelManager.issue({
        ...fence(),
        contract: 'cordisx.channel-manager-target-request/v1',
        schemaVersion: 1,
        operation: 'target.connection.create',
        target: {
          kind: 'credential-draft',
          credentialDraftToken: captured.credentialDraftToken!,
        },
      })
      const commit = () =>
        plugin.channelManager.execute({
          ...fence(),
          contract: 'cordisx.channel-manager-request/v2',
          schemaVersion: 2,
          operation: 'connection.create',
          target: connection.target!,
          draft: { displayName: 'Fixture', selectors: ['direct'] },
        })
      allowConnect = false
      expect(await commit()).toMatchObject({ status: 'rejected', code: 'PERMISSION_DENIED' })
      expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['capture'])
      allowConnect = true
      expect(await commit()).toMatchObject({ status: 'applied' })
      expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['capture', 'commit'])
      expect(f.prompt).toHaveBeenCalledTimes(4)
    } finally {
      await fiber.dispose()
      f.broker.dispose()
      prompt.mockRestore()
    }
  })
})
