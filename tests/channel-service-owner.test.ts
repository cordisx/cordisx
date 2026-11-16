import { readFile } from 'node:fs/promises'
import { Context, getTraceable } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import {
  type ChannelManagerProjectionV1,
  CordisXChannelManagerService,
} from '../packages/cli/src/renderer/channel-manager.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'
import type { RuntimeServiceCapabilityOwner } from '../packages/cli/src/service-capability-ownership.js'
import type { ChannelManagerV4 } from '@cordisx/protocol/channel-manager/v4'
import type { ChannelManagerV5 } from '@cordisx/protocol/channel-manager/v5'
import type { ChannelManagerV6 } from '@cordisx/protocol/channel-manager/v6'
import type { ChannelManagerV10 } from '@cordisx/protocol/channel-manager/v10'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import * as credentialPrompt from '../packages/cli/src/renderer/channel-credential-prompt.js'

const identity = { id: 'channel', source: 'file:///channel-owner-package' }
const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
const names = [
  'channel.accounts.read',
  'channel.accounts.connect',
  'channel.bindings.read',
  'channel.bindings.write',
] as const
const owner: RuntimeServiceCapabilityOwner = {
  source: identity.source,
  pluginId: identity.id,
  serviceId: 'runtime',
  serviceKind: 'channel-adapter',
  serviceGeneration: 'service-one',
  runtimeGeneration: 'runtime',
  moduleGeneration: 'module-one',
  capabilities: names.map(name => ({ name, scope: {} })),
}

async function actualManifest() {
  const file = process.env.CORDISX_CHANNEL_MANIFEST_FIXTURE
    ?? new URL('../packages/cli/dist/bundled-plugins/@cordisx/channel/runtime-manifest.json', import.meta.url)
  return normalizePluginManifest(JSON.parse(await readFile(file, 'utf8')), 'channel')
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
async function fixture(owners: readonly RuntimeServiceCapabilityOwner[] = [owner]) {
  const manifest = await actualManifest()
  const store = new MemoryPermissionPolicyStore()
  const prompt = vi.fn(async () => undefined)
  const broker = new PermissionBroker(
    store,
    { request: prompt },
    () => new Date(),
    100,
    'test',
    'runtime',
    undefined,
    undefined,
    { request: prompt },
    owners,
  )
  const retire = broker.register(identity, manifest, {
    pluginId: identity.id,
    moduleGeneration: owner.moduleGeneration,
  })
  const root = new Context()
  const run = vi.fn(async () => ({ status: 'applied' as const }))
  const fiber = root.plugin(CordisXChannelManagerService, {
    projection: projection(),
    profileId: 'test',
    hostGeneration: 'runtime',
    broker,
    actions: { run },
    document: {} as Document,
  })
  await fiber
  const ctx = root.extend({
    [CORDISX_PLUGIN_ID]: identity.id,
    [CORDISX_PLUGIN_SOURCE]: identity.source,
    [CORDISX_PLUGIN_GENERATION]: owner.moduleGeneration,
  })
  return {
    root,
    ctx,
    fiber,
    run,
    broker,
    store,
    prompt,
    manifest,
    retire,
    cleanup: async () => {
      await fiber.dispose()
      broker.dispose()
    },
  }
}
function ownedManager(ctx: Context) {
  return (ctx.channelManager as ChannelManagerV5).forOwnService()
}
function unbind(manager: ChannelManagerV4) {
  const snapshot = manager.snapshot(), binding = snapshot.bindings[0]!
  return {
    contract: 'cordisx.channel-manager-request/v2' as const,
    schemaVersion: 2 as const,
    requestId: 'own-unbind',
    profileId: snapshot.profileId,
    hostGeneration: snapshot.hostGeneration,
    expectedRevision: snapshot.revision,
    operation: 'binding.unbind' as const,
    target: { kind: 'binding' as const, bindingToken: binding.bindingToken, bindingRevision: binding.bindingRevision },
  }
}

describe('Channel owned management service', () => {
  it('reads actual own-service activity through traced callers and rejects a borrowed or retired facade', async () => {
    const f = await fixture([{
      ...owner,
      capabilities: [...owner.capabilities, { name: 'channel.events.subscribe', scope: {} }],
    }])
    const conversation = { ...ref, conversationId: 'oc_test', kind: 'group' as const }
    const fence = { generation: 'service-one', accountGeneration: 1, revision: 'records-one' }
    try {
      f.run.mockImplementation(async (action: string) =>
        action === 'conversation-page'
          ? {
            status: 'applied',
            conversationPage: {
              ...fence,
              offset: 0,
              total: 1,
              directoryComplete: true,
              conversations: [{
                ref: conversation,
                name: 'Owned group',
                bindingCount: 1,
                activeBindingCount: 1,
                receivedCount: 1,
                sentCount: 0,
              }],
            },
          }
          : {
            status: 'applied',
            conversationActivity: {
              ...fence,
              conversation,
              offset: 0,
              total: 1,
              entries: [{
                conversation,
                id: 'record',
                direction: 'incoming',
                state: 'received',
                occurredAt: '2026-11-16T00:00:00Z',
                text: 'Actual message',
              }],
            },
          } as never
      )
      const own = (f.ctx.channelManager as ChannelManagerV10).forOwnConversationService()!
      const connectionToken = own.snapshot().accounts[0]!.connectionToken
      const page = await own.conversationPage({ connectionToken }, new AbortController().signal)
      const conversationToken = page.conversations[0]!.conversationToken
      await expect(own.conversationActivity({ conversationToken }, new AbortController().signal)).resolves
        .toMatchObject({ entries: [{ text: 'Actual message' }] })
      const borrowed = getTraceable(f.ctx.extend({ [CORDISX_PLUGIN_ID]: 'different' }), own)
      await expect(borrowed.conversationActivity({ conversationToken }, new AbortController().signal)).rejects.toThrow()
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.store.records).toHaveLength(0)
      f.retire()
      await expect(own.conversationActivity({ conversationToken }, new AbortController().signal)).rejects.toThrow()
    } finally {
      await f.cleanup()
    }
  })
  it('publishes the reply-policy successor through actual owned-service tracing and preserves frozen reads', async () => {
    const f = await fixture()
    try {
      f.run.mockResolvedValue({
        status: 'applied',
        conversationPolicy: {
          revision: 4,
          policy: parseChannelConversationPolicy({ replyMode: 'thread' }),
        },
      } as never)
      const manager = (f.ctx.channelManager as ChannelManagerV6).forOwnReplyService()!
      await expect(manager.conversationReplyPolicy(new AbortController().signal)).resolves.toMatchObject({
        contract: 'cordisx.channel-conversation-policy-readback/v2',
        schemaVersion: 2,
        policy: { replyMode: 'thread' },
      })
      const legacy = await manager.conversationPolicy(new AbortController().signal)
      expect(legacy.contract).toBe('cordisx.channel-conversation-policy-readback/v1')
      expect(legacy.policy).not.toHaveProperty('replyMode')
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })
  it('uses actual undelegated manifest, Cordis tracing and management controls without prompts or persisted grants', async () => {
    const f = await fixture()
    try {
      expect(f.manifest.capabilities.some(item => names.includes(item.name as typeof names[number]))).toBe(false)
      const manager = ownedManager(f.ctx)!
      expect(manager).toBeDefined()
      expect(manager.snapshotWithIdentity().accounts).toHaveLength(1)
      await expect(
        manager.bindingPage(
          { connectionToken: manager.snapshot().accounts[0]!.connectionToken },
          new AbortController().signal,
        ),
      )
        .resolves.toMatchObject({ total: 1 })
      await expect(manager.execute(unbind(manager))).resolves.toMatchObject({ status: 'applied' })
      expect(f.run).toHaveBeenCalledWith('unbind', { bindingId: 'one' })
      const authority = f.broker.serviceOwner(identity, owner.moduleGeneration, names[0])!
      for (const name of names) {
        expect(f.broker.authorizeServiceOwner(identity, authority, name, { channelTenant: ref })).toBe(true)
      }
      expect(
        f.broker.snapshots().filter(item => item.authorizationOrigin === 'service-owner').map(item => item.capability),
      ).toEqual(names)
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.store.records).toHaveLength(0)
      expect(f.broker.runtimeExactExplanations()).toEqual([])
    } finally {
      await f.cleanup()
    }
  })

  it('keeps the inherited delegated path denied even for an owner who declares no delegated capability', async () => {
    const f = await fixture()
    try {
      const request = unbind(ownedManager(f.ctx)!)
      await expect(f.ctx.channelManager.execute(request)).resolves.toMatchObject({
        status: 'rejected',
        code: 'PERMISSION_DENIED',
      })
      expect(f.run).not.toHaveBeenCalled()
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('keeps owner scopes and opaque target/revision checks without granting foreign capabilities', async () => {
    const f = await fixture([{
      ...owner,
      capabilities: names.map(name => ({ name, scope: { channelTenants: [ref] } })),
    }])
    try {
      const authority = f.broker.serviceOwner(identity, owner.moduleGeneration, 'channel.accounts.read')!
      expect(f.broker.authorizeServiceOwner(identity, authority, 'channel.accounts.connect', {
        channelTenant: { ...ref, tenantId: 'another' },
      })).toBe(false)
      expect(f.broker.authorizeServiceOwner(identity, authority, 'channel.messages.send', { channelTenant: ref })).toBe(
        false,
      )
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
    const normal = await fixture()
    try {
      const own = ownedManager(normal.ctx)!, request = unbind(own)
      await expect(own.execute({ ...request, expectedRevision: request.expectedRevision + 1 })).resolves.toMatchObject({
        status: 'conflict',
      })
      await expect(own.execute({ ...request, target: { ...request.target, bindingToken: 'foreign' } })).resolves
        .toMatchObject({ status: 'rejected' })
      expect(normal.run).not.toHaveBeenCalled()
      expect(normal.prompt).not.toHaveBeenCalled()
    } finally {
      await normal.cleanup()
    }
  })

  it('authorizes Host credential capture and connection commit internally without prompting itself', async () => {
    const f = await fixture()
    await f.fiber.dispose()
    const request = vi.fn(async (input: Record<string, unknown>) =>
      input.operation === 'capture'
        ? {
          status: 'applied' as const,
          code: 'APPLIED',
          ref,
          draftId: 'private-fixture',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : { status: 'applied' as const, code: 'APPLIED' }
    )
    const prompt = vi.spyOn(credentialPrompt, 'captureChannelCredential')
      .mockImplementation(async input => input.submit(ref, 'fixture-secret', input.signal))
    const fiber = f.root.plugin(CordisXChannelManagerService, {
      projection: projection(),
      profileId: 'test',
      hostGeneration: 'runtime',
      broker: f.broker,
      document: {} as Document,
      credentialRequest: request,
    })
    await fiber
    try {
      const manager = ownedManager(f.ctx)!
      const fence = () => ({
        requestId: 'credential-owner',
        profileId: 'test',
        hostGeneration: 'runtime',
        expectedRevision: manager.snapshot().revision,
      })
      const issue = await manager.issue({
        ...fence(),
        contract: 'cordisx.channel-manager-target-request/v1',
        schemaVersion: 1,
        operation: 'target.credential.capture.create',
        purpose: 'create',
        adapterKind: 'feishu',
        target: { kind: 'root' },
      })
      expect(issue.status).toBe('applied')
      if (issue.status !== 'applied') throw new Error('Fixture target missing')
      const captured = await manager.execute({
        ...fence(),
        contract: 'cordisx.channel-manager-request/v2',
        schemaVersion: 2,
        operation: 'credential.capture',
        target: issue.target as { kind: 'credential-capture'; captureToken: string },
      })
      expect(captured.status).toBe('applied')
      if (captured.status !== 'applied' || captured.operation !== 'credential.capture') {
        throw new Error('Fixture capture missing')
      }
      const created = await manager.issue({
        ...fence(),
        contract: 'cordisx.channel-manager-target-request/v1',
        schemaVersion: 1,
        operation: 'target.connection.create',
        target: { kind: 'credential-draft', credentialDraftToken: captured.credentialDraftToken },
      })
      expect(created.status).toBe('applied')
      if (created.status !== 'applied') throw new Error('Fixture draft missing')
      await expect(manager.execute({
        ...fence(),
        contract: 'cordisx.channel-manager-request/v2',
        schemaVersion: 2,
        operation: 'connection.create',
        target: created.target as { kind: 'connection-draft'; connectionDraftToken: string },
        draft: { displayName: 'Fixture', selectors: ['direct'] },
      })).resolves.toMatchObject({ status: 'applied' })
      expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['capture', 'commit'])
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.store.records).toHaveLength(0)
    } finally {
      prompt.mockRestore()
      await fiber.dispose()
      await f.cleanup()
    }
  })

  it.each([
    { source: 'file:///different-source' },
    { pluginId: 'other' },
    { serviceId: 'different' },
    { serviceKind: 'different' },
    { moduleGeneration: 'different' },
    { runtimeGeneration: 'different' },
    { serviceGeneration: '' },
  ])('rejects incorrect active owner metadata %j', async mismatch => {
    const f = await fixture([{ ...owner, ...mismatch }])
    try {
      expect(ownedManager(f.ctx)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  })

  it('rejects a facade traced into another source or module before reads, subscriptions or actions', async () => {
    const f = await fixture()
    try {
      const own = ownedManager(f.ctx)!, request = unbind(own)
      for (
        const mismatch of [
          { [CORDISX_PLUGIN_ID]: 'other' },
          { [CORDISX_PLUGIN_SOURCE]: 'file:///another' },
          { [CORDISX_PLUGIN_GENERATION]: 'module-two' },
        ]
      ) {
        const caller = f.ctx.extend(mismatch), borrowed = getTraceable(caller, own)
        expect(ownedManager(caller)).toBeUndefined()
        expect(() => borrowed.snapshot()).toThrow('PERMISSION_DENIED')
        expect(() => borrowed.snapshotWithIdentity()).toThrow('PERMISSION_DENIED')
        expect(() => borrowed.subscribe(() => {})).toThrow('PERMISSION_DENIED')
        await expect(borrowed.refreshIdentity(new AbortController().signal)).rejects.toThrow('PERMISSION_DENIED')
        await expect(borrowed.execute(request)).resolves.toMatchObject({
          status: 'rejected',
          code: 'PERMISSION_DENIED',
        })
      }
      expect(f.run).not.toHaveBeenCalled()
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('fences a retired facade even if an identical source/module is registered again', async () => {
    const f = await fixture()
    try {
      const own = ownedManager(f.ctx)!, request = unbind(own), listener = vi.fn()
      const subscription = own.subscribe(listener)
      f.retire()
      f.broker.register(identity, f.manifest, { pluginId: identity.id, moduleGeneration: owner.moduleGeneration })
      expect(() => own.snapshot()).toThrow('PERMISSION_DENIED')
      await expect(own.execute(request)).resolves.toMatchObject({ status: 'rejected' })
      const replacement = ownedManager(f.ctx)!
      await expect(replacement.execute(unbind(replacement))).resolves.toMatchObject({ status: 'applied' })
      expect(listener).not.toHaveBeenCalled()
      subscription.dispose()
      expect(ownedManager(f.ctx)).toBeDefined()
      await f.fiber.dispose()
      expect(() => replacement.snapshot()).toThrow('PERMISSION_DENIED')
    } finally {
      await f.cleanup()
    }
  })
})
