import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  type CordisXPermissionAuthorizationPlanV2,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import { deferValidatedPermissionPlan, noDeferredPermissionDecision } from '../packages/cli/src/permission-deferral.js'
import { bundleDeferredDecision } from '../packages/cli/src/launcher/plugin-bundle-deferred.js'

describe('Channel 0.1.7 optional simulator authority', () => {
  it('asks at actual simulator use and rejects Feishu outside the declared scope', async () => {
    const template = JSON.parse(
      await readFile(new URL('./fixtures/channel-runtime-manifest-v16.json', import.meta.url), 'utf8'),
    )
    const tenant = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
    const conversation = { ...tenant, conversationId: 'direct-alice', kind: 'direct' as const }
    const manifest = normalizePluginManifest({
      ...template,
      capabilities: [
        { name: 'channel.events.receive', required: false, scope: { channelTenants: [tenant] } },
        { name: 'channel.events.subscribe', required: false, scope: { channelTenants: [tenant] } },
        { name: 'channel.messages.send', required: false, scope: { channelConversations: [conversation] } },
        { name: 'channel.attachments.read', required: false, scope: { channelConversations: [conversation] } },
      ],
    }, 'channel')
    const identity = { source: 'file:///channel-test', id: 'channel' }
    const store = new MemoryPermissionPolicyStore()
    const prompt = vi.fn(async (plan: CordisXPermissionAuthorizationPlanV2) => ({
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
        decision: 'allow-once' as const,
      })),
    }))
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
    try {
      broker.register(identity, manifest)
      const review = deferValidatedPermissionPlan(broker.authorizationPlanV4(identity, 'install')!)
      await broker.authorizeActivationV7(identity, noDeferredPermissionDecision(review), 'install')
      expect(prompt).not.toHaveBeenCalled()
      expect(store.readV2()).toEqual([])
      expect(
        await broker.authorizeChannel(identity, 'channel.messages.send', {
          channelConversation: { ...conversation, adapterId: 'feishu' },
        }),
      ).toBe(false)
      expect(prompt).not.toHaveBeenCalled()
      expect(await broker.authorizeChannel(identity, 'channel.messages.send', { channelConversation: conversation }))
        .toBe(true)
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(store.readV2()).toEqual([])
      await broker.setPolicyV2(identity, 'channel.messages.send', 'deny-persistent')
      expect(await broker.authorizeChannel(identity, 'channel.messages.send', { channelConversation: conversation }))
        .toBe(false)
      expect(prompt).toHaveBeenCalledTimes(1)
    } finally {
      broker.dispose()
    }
    const unattendedStore = new MemoryPermissionPolicyStore()
    const unattended = new PermissionBroker(
      unattendedStore,
      { request: async () => 'deny' },
      () => new Date(),
      100,
      'test',
      'runtime',
    )
    try {
      unattended.register(identity, manifest)
      expect(
        await unattended.authorizeChannel(identity, 'channel.messages.send', { channelConversation: conversation }),
      )
        .toBe(false)
      expect(unattendedStore.readV2()).toEqual([])
    } finally {
      unattended.dispose()
    }
    const bundleStore = new MemoryPermissionPolicyStore()
    const bundleBroker = new PermissionBroker(
      bundleStore,
      { request: async () => 'deny' },
      () => new Date(),
      100,
      'test',
      'runtime',
    )
    try {
      bundleBroker.register(identity, manifest)
      const plan = deferValidatedPermissionPlan(bundleBroker.authorizationPlanV4(identity, 'install')!)
      const { decision, selections } = bundleDeferredDecision(
        plan,
        capability => capability === 'channel.messages.send' ? 'allow' : 'ask',
      )
      await expect(bundleBroker.authorizeActivationV7(identity, decision, 'install')).rejects.toThrow()
      await expect(bundleBroker.authorizeActivationV7(identity, decision, 'install', undefined, {
        'channel.messages.send': 'deny',
      })).rejects.toThrow()
      await bundleBroker.authorizeActivationV7(identity, decision, 'install', undefined, selections)
      expect(
        await bundleBroker.authorizeChannel(identity, 'channel.messages.send', { channelConversation: conversation }),
      ).toBe(true)
      expect(bundleStore.readV2().every(record => record.key.capability === 'channel.messages.send')).toBe(true)
    } finally {
      bundleBroker.dispose()
    }
    const deniedStore = new MemoryPermissionPolicyStore()
    const deniedBroker = new PermissionBroker(
      deniedStore,
      { request: async () => 'deny' },
      () => new Date(),
      100,
      'test',
      'runtime',
    )
    try {
      deniedBroker.register(identity, manifest)
      const plan = deferValidatedPermissionPlan(deniedBroker.authorizationPlanV4(identity, 'install')!)
      const { decision, selections } = bundleDeferredDecision(
        plan,
        capability => capability === 'channel.messages.send' ? 'deny' : 'ask',
      )
      await deniedBroker.authorizeActivationV7(identity, decision, 'install', undefined, selections)
      expect(
        await deniedBroker.authorizeChannel(identity, 'channel.messages.send', { channelConversation: conversation }),
      ).toBe(false)
      expect(deniedStore.readV2()).toMatchObject([{
        key: { capability: 'channel.messages.send' },
        policy: 'deny-persistent',
      }])
    } finally {
      deniedBroker.dispose()
    }
  })
})
