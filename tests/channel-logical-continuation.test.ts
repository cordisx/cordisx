import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { startChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-continuation.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { createChannelLogicalHistory } from '../packages/cli/src/launcher/channel-logical-history.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { channelLogicalCommand } from '../packages/cli/src/launcher/channel-logical-command.js'
import { claimChannelDispatch } from '../packages/cli/src/launcher/channel-conversation-dispatch.js'
import { abandonChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-abandon.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { ChannelLogicalHandoffPermits } from '../packages/cli/src/launcher/channel-logical-handoff-permits.js'
import { createDesktopLogicalHandoffControl } from '../packages/cli/src/launcher/desktop-logical-handoff-control.js'
import {
  assertChannelLogicalHandoff,
  channelLogicalHandoffForJob,
  confirmChannelLogicalHandoff,
} from '../packages/cli/src/launcher/channel-logical-handoff.js'
import type { LogicalContinuationRequest } from '../packages/cli/src/launcher/logical-continuation-control.js'

const channel = {
  adapterId: 'test',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'chat',
  threadId: 'chat',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const event = {
  ...channel,
  eventId: 'event',
  actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'user' },
}
const request: LogicalContinuationRequest = {
  contract: 'cordisx.conversation-continuation-request/v1',
  operationId: 'op',
  logicalConversationId: 'logical',
  source: { hostId: 'local', appId: 'codex', profileId: 'profile', sessionId: 'source' },
  expectedRevision: 0,
  target: { providerId: 'new', model: 'model' },
  mode: 'linked',
  historyConsent: 'on-demand',
  handoffConsent: 'none',
  historyCategories: ['user-text'],
}
const config = {
  providerId: 'old',
  model: 'old',
  cwd: '/workspace',
  serviceTier: null,
  approvalsReviewer: 'user',
  execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
  sandbox: { type: 'readOnly' },
  permissionProfile: null,
}
describe('Channel logical continuation composition', () => {
  it('uses linked only after its matching explicit consent when a preferred fork is incompatible', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-logical-preferred-'))
    const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
    try {
      await store.mutate(state => {
        state.policy = parseChannelConversationPolicy({
          enabled: true,
          rules: [
            { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
            { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
          ],
        })
        state.taskConfig = parseChannelTaskConfig({
          permissions: [{ id: 'grant', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] }],
        })
        state.bindings.b = {
          id: 'b',
          channel,
          sessionId: 'source',
          hostId: 'local',
          profileId: 'profile',
          createdAt: '',
          fromSequence: 0,
          mode: 'deliver',
          autoReply: false,
          state: 'active',
        }
      })
      const create = vi.fn(async (current: LogicalContinuationRequest) => ({
        state: 'created' as const,
        confirmed: true,
        destination: { ...current.source, sessionId: 'destination' },
      }))
      const native = {
        supportsLogicalFork: () => true,
        continuationConfiguration: async () => config,
        modelOperation: async () => ({ providers: [{ providerId: 'new', models: [{ id: 'model' }] }] }),
        taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
        logicalSourceVersion: async () => 'sha256:fixture',
        createLogicalDestination: create,
      }
      const args = {
        store,
        native: native as never,
        fence: new ChannelNativeSourceFence(() => false),
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        recordId: 'preference',
        argument: 'preference fork',
      }
      await store.bindCommitBarrier(async () => {})
      expect(await channelLogicalCommand({ ...args, argument: 'preference fresh' })).toContain('可选模式')
      expect(await channelLogicalCommand({ ...args, argument: 'fresh new model --history=none --no-checkpoint' }))
        .toContain('用法')
      await channelLogicalTransactionStore(store).mutate(state => {
        const logical = state.logicalContinuations!, scope = { kind: 'profile' as const, id: 'profile' }
        const key = JSON.stringify([scope.kind, scope.id])
        logical.preferences = {
          [key]: { contract: 'cordisx.conversation-continuation-preference/v1', revision: 1, scope, mode: 'fresh' },
        }
        logical.preferenceRevisions = { [key]: 1 }
      })
      expect(await channelLogicalCommand({ ...args, argument: 'suggest new model' })).toContain('请重新选择')
      expect(
        await channelLogicalCommand({
          ...args,
          argument: 'preferred new model --history=user,assistant --no-checkpoint',
        }),
      ).toContain('请重新选择')
      expect(create).not.toHaveBeenCalled()
      const desktop = desktopLogicalMigration({
        owner: profileLogicalConversationOwner(store),
        control: {} as never,
        native: () => native as never,
        profileId: 'profile',
        identity: async () => 'desktop-fixture',
        targetAllowed: async () => true,
        historyReady: () => true,
      })
      expect(
        await desktop.suggest({
          targetId: 'target',
          rendererGeneration: 'renderer',
          navigationGeneration: 1,
          threadId: 'source',
        }, { providerId: 'new', model: 'model' }),
      ).toMatchObject({ recommended: 'linked', legacyFreshPreference: true })
      expect(await channelLogicalCommand(args)).toContain('首选模式：fork')
      expect(
        await channelLogicalCommand({
          ...args,
          recordId: 'switch',
          argument: 'preferred new model --history=user,assistant --no-checkpoint',
        }),
      ).toContain('已切换到新对话')
      expect(create).toHaveBeenCalledOnce()
      expect(create.mock.calls[0]![0]).toMatchObject({ mode: 'linked', historyConsent: 'on-demand' })
      expect(store.snapshot().bindings.b?.sessionId).toBe('destination')
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('commits the native destination, authorized binding and queued job together', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-logical-channel-'))
    const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
    try {
      await store.mutate(state => {
        state.policy = parseChannelConversationPolicy({
          enabled: true,
          rules: [
            { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
            { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
          ],
        })
        state.taskConfig = parseChannelTaskConfig({
          permissions: [{ id: 'grant', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] }],
        })
        state.bindings.b = {
          id: 'b',
          channel,
          sessionId: 'source',
          hostId: 'local',
          profileId: 'profile',
          createdAt: '',
          fromSequence: 0,
          mode: 'deliver',
          autoReply: false,
          state: 'active',
        }
        state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
        state.jobs.j = {
          id: 'j',
          recordId: 'r',
          bindingId: 'b',
          autoCreate: false,
          state: 'queued',
          sessionId: 'source',
        }
        state.continuations.source = {
          checkpoint: {
            threadId: 'source',
            revision: 1,
            goal: 'checkpoint-marker',
            constraints: 'constraints',
            completed: 'done',
            remaining: 'next',
            history: 'background',
            continueAtIdle: false,
          },
        }
      })
      const checkpointRequest = { ...request, handoffConsent: 'checkpoint' as const }
      let sourceVersion = 'sha256:fixture'
      const native = {
        modelOperation: async () => ({ providers: [{ providerId: 'new', models: [{ id: 'model' }] }] }),
        continuationConfiguration: async () => config,
        taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
        supportsLogicalFork: () => true,
        sourceFor: () => event,
        supportsLogicalHandoff: () => true,
        sourceForLogicalTurn: async () => event,
        logicalTurnActive: async () => true,
        logicalHistoryPage: async () => ({
          items: [{ type: 'userMessage', content: [{ type: 'text', text: 'marker' }] }],
        }),
        logicalSourceVersion: async () => sourceVersion,
        logicalContextTokens: () => [],
        createLogicalDestination: vi.fn(async () => ({
          state: 'created',
          confirmed: true,
          destination: { ...request.source, sessionId: 'destination' },
        })),
      }
      const fence = new ChannelNativeSourceFence(() => false)
      const unavailableGuard = await startChannelLogicalContinuation({
        store,
        native: { ...native, supportsLogicalHandoff: () => false } as never,
        fence,
        claims: new Set(),
        appId: 'codex',
        profileId: 'profile',
        event,
        request: checkpointRequest,
      })
      expect(unavailableGuard).toMatchObject({ state: 'rejected', code: 'HANDOFF_GUARD_UNAVAILABLE' })
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      const suggestion = {
        store,
        native: native as never,
        fence,
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        recordId: 'suggest',
        argument: 'suggest old old',
      }
      expect(await channelLogicalCommand(suggestion)).toContain('建议模式：fork')
      expect(
        await channelLogicalCommand({ ...suggestion, event: { ...event, actor: { ...event.actor, userId: 'other' } } }),
      ).toContain('没有设置权限')
      expect(await channelLogicalCommand({ ...suggestion, argument: 'suggest new model' })).toContain(
        '建议模式：linked',
      )
      expect(await channelLogicalCommand({ ...suggestion, argument: 'preference fork' })).toContain('首选模式：fork')
      expect(await channelLogicalCommand({ ...suggestion, argument: 'suggest new model' })).toContain(
        '建议模式：linked',
      )
      expect(
        await channelLogicalCommand({
          ...suggestion,
          recordId: 'mismatched-consent',
          argument: 'preferred new model --history=inherit --no-checkpoint',
        }),
      ).toContain('授权范围与选择的模式不一致')
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      expect(await channelLogicalCommand({ ...suggestion, argument: 'preference inherit' })).toContain('已清除')
      const unavailable = await channelLogicalCommand({
        ...suggestion,
        native: { ...native, continuationConfiguration: async () => undefined } as never,
        recordId: 'missing-mode',
        argument: 'linked new model --history=user,assistant --no-checkpoint',
      })
      expect(unavailable).toContain('/work-mode default')
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      await store.mutate(state => {
        state.taskConfig = parseChannelTaskConfig({})
      })
      const denied = await startChannelLogicalContinuation({
        store,
        native: native as never,
        claims: new Set(),
        fence,
        appId: 'codex',
        profileId: 'profile',
        event,
        request: checkpointRequest,
      })
      expect(denied.state).toBe('rejected')
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      await store.mutate(state => {
        state.taskConfig = parseChannelTaskConfig({
          permissions: [{ id: 'grant', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] }],
        })
      })
      const busyFence = new ChannelNativeSourceFence(() => false)
      const leaseInput = {
        store,
        fence: busyFence,
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        request: checkpointRequest,
      }
      expect(
        await startChannelLogicalContinuation({
          ...leaseInput,
          native: { ...native, logicalMigrationLease: async () => ({ state: 'busy' }) } as never,
        }),
      ).toMatchObject({ state: 'rejected', code: 'SOURCE_BUSY' })
      const releaseBusy = busyFence.beginMigration('source')
      expect(releaseBusy).toBeDefined()
      releaseBusy?.()
      const uncertainFence = new ChannelNativeSourceFence(() => false)
      expect(
        await startChannelLogicalContinuation({
          ...leaseInput,
          fence: uncertainFence,
          native: { ...native, logicalMigrationLease: async () => ({ state: 'unknown' }) } as never,
        }),
      ).toMatchObject({ state: 'rejected', code: 'SOURCE_FENCE_UNAVAILABLE' })
      expect(uncertainFence.beginMigration('source')).toBeUndefined()
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      native.createLogicalDestination.mockResolvedValueOnce(
        { state: 'created', confirmed: false, destination: { ...request.source, sessionId: 'orphan' } } as never,
      )
      const uncertain = await startChannelLogicalContinuation({
        store,
        native: native as never,
        claims: new Set(),
        fence,
        appId: 'codex',
        profileId: 'profile',
        event,
        request: checkpointRequest,
      })
      expect(uncertain).toMatchObject({ state: 'unknown', destination: { sessionId: 'orphan' } })
      expect(ChannelConversationStore.logicalSourceFenced(store.snapshot(), 'source')).toBe(true)
      expect(
        await startChannelLogicalContinuation({
          store,
          native: { ...native, logicalMigrationLease: async () => ({ state: 'busy' }) } as never,
          claims: new Set(),
          fence,
          appId: 'codex',
          profileId: 'profile',
          event,
          request: checkpointRequest,
        }),
      ).toMatchObject({ state: 'unknown', destination: { sessionId: 'orphan' } })
      const recovery = {
        store,
        fence,
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        operationId: 'op',
      }
      expect(
        await abandonChannelLogicalContinuation({
          ...recovery,
          event: { ...event, actor: { ...event.actor, userId: 'other' } },
        }),
      ).toBe(false)
      expect(await abandonChannelLogicalContinuation(recovery)).toBe(true)
      expect(ChannelConversationStore.logicalSourceFenced(store.snapshot(), 'source')).toBe(false)
      expect(store.snapshot().logicalContinuations?.intents.op?.orphanDestination?.sessionId).toBe('orphan')
      const result = await startChannelLogicalContinuation({
        store,
        native: native as never,
        claims: new Set(),
        fence,
        appId: 'codex',
        profileId: 'profile',
        event,
        request: { ...checkpointRequest, operationId: 'op2' },
      })
      expect(result).toMatchObject({ state: 'applied', destination: { sessionId: 'destination' } })
      const state = store.snapshot()
      expect(state.schemaVersion).toBe(2)
      expect(state.bindings.b?.sessionId).toBe('destination')
      expect(state.jobs.j?.sessionId).toBe('destination')
      expect(state.logicalContinuations?.relations.op2).toMatchObject({
        mode: 'linked',
        destination: { sessionId: 'destination' },
      })
      expect(native.createLogicalDestination).toHaveBeenCalledTimes(2)
      const unreserved = store.snapshot()
      expect(() =>
        assertChannelLogicalHandoff(
          unreserved,
          'turn/start',
          { threadId: 'destination', input: [] },
        )
      ).toThrow('HANDOFF_UNAVAILABLE')
      expect(claimChannelDispatch(
        unreserved,
        unreserved.jobs.j!,
        { ...event, actor: { ...event.actor, userId: 'other' } },
        undefined,
      )).toBe(false)
      await store.mutate(current => {
        expect(claimChannelDispatch(current, current.jobs.j!, event, undefined)).toBe(true)
      })
      expect(channelLogicalHandoffForJob(store.snapshot(), 'j', event)).toContain('checkpoint-marker')
      const handoff = channelLogicalHandoffForJob(store.snapshot(), 'j', event) as string
      const permits = new ChannelLogicalHandoffPermits()
      const marker = permits.issue('j', 'destination')!
      const dispatch = { threadId: 'destination', input: [{ type: 'text', text: `${marker}\n${handoff}` }] }
      expect(() => assertChannelLogicalHandoff(store.snapshot(), 'turn/start', dispatch)).toThrow('HANDOFF_UNAVAILABLE')
      expect(() => assertChannelLogicalHandoff(store.snapshot(), 'turn/steer', dispatch, permits))
        .toThrow('HANDOFF_UNAVAILABLE')
      expect(() => assertChannelLogicalHandoff(store.snapshot(), 'turn/start', dispatch, permits)).not.toThrow()
      expect(() => assertChannelLogicalHandoff(store.snapshot(), 'turn/start', dispatch, permits))
        .toThrow('HANDOFF_UNAVAILABLE')
      await store.bindCommitBarrier(async () => {})
      permits.release('j')
      const nextMarker = permits.issue('j', 'destination')!
      const owner = profileLogicalConversationOwner(store)
      const guard = createDesktopLogicalHandoffControl({ owner: () => owner, permits: () => permits })
      try {
        const query = { type: 'logical-handoff-status', threadId: 'destination', method: 'turn/start' }
        const offer = await guard.handle(query, () => true) as { state: string; marker: string; digest: string }
        expect(offer).toMatchObject({ state: 'pending', marker: nextMarker })
        await store.mutate(current => {
          current.policy = { ...current.policy, enabled: false }
        })
        const authorize = {
          ...query,
          type: 'logical-handoff-authorize',
          marker: offer.marker,
          digest: offer.digest,
          guardId: 'b'.repeat(48),
        }
        expect(await guard.handle(authorize, () => true)).toMatchObject({ state: 'blocked' })
        await store.mutate(current => {
          current.policy = { ...current.policy, enabled: true }
        })
        const allowed = await guard.handle(authorize, () => true) as { state: string; lease: string }
        expect(allowed.state).toBe('authorized')
        let revoked = false
        const revoke = store.mutate(current => {
          current.policy = { ...current.policy, enabled: false }
        }).then(() => {
          revoked = true
        })
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(revoked).toBe(false)
        expect(await guard.handle({ type: 'logical-handoff-release', lease: allowed.lease }, () => true)).toBe(true)
        await revoke
        expect(revoked).toBe(true)
        await store.mutate(current => {
          current.policy = { ...current.policy, enabled: true }
        })
        permits.release('j')
        const delayedMarker = permits.issue('j', 'destination')!
        const held = await store.holdCommittedSnapshot(() => true)
        const delayedId = 'c'.repeat(48)
        const delayed = guard.handle({ ...authorize, marker: delayedMarker, guardId: delayedId }, () => true)
        expect(await guard.handle({ type: 'logical-handoff-release', lease: delayedId }, () => true)).toBe(true)
        held.release()
        expect(await delayed).toMatchObject({ state: 'blocked' })
        expect(permits.peek('j', 'destination')).toBe(delayedMarker)
      } finally {
        guard.releaseAll()
      }
      expect(store.snapshot().logicalContinuations?.intents.op2?.handoffJobId).toBe('j')
      const pending = store.snapshot()
      pending.jobs.next = { ...pending.jobs.j!, id: 'next', state: 'queued' }
      expect(claimChannelDispatch(pending, pending.jobs.next, event, undefined)).toBe(false)
      pending.jobs.j!.state = 'reconciliation-required'
      expect(claimChannelDispatch(pending, pending.jobs.next, event, undefined)).toBe(false)
      expect(claimChannelDispatch(
        pending,
        pending.jobs.next,
        { ...event, actor: { ...event.actor, userId: 'other' } },
        undefined,
      )).toBe(false)
      pending.jobs.j!.turnId = 'confirmed-turn'
      expect(claimChannelDispatch(pending, pending.jobs.next, event, undefined)).toBe(false)
      pending.jobs.j!.state = 'dispatching'
      confirmChannelLogicalHandoff(pending, 'j', 'other-destination', 'confirmed-turn')
      expect(claimChannelDispatch(pending, pending.jobs.next, event, undefined)).toBe(false)
      confirmChannelLogicalHandoff(pending, 'j', 'destination', 'confirmed-turn')
      expect(claimChannelDispatch(pending, pending.jobs.next, event, undefined)).toBe(true)
      expect(() =>
        assertChannelLogicalHandoff(
          pending,
          'turn/start',
          { threadId: 'destination', input: [] },
        )
      ).not.toThrow()
      await store.mutate(current => {
        current.continuations.source!.checkpoint = { ...current.continuations.source!.checkpoint!, goal: 'changed' }
      })
      expect(channelLogicalHandoffForJob(store.snapshot(), 'j', event)).toBe(false)
      permits.release('j')
      const renewed = permits.issue('j', 'destination')!
      const stale = { threadId: 'destination', input: [{ type: 'text', text: `${renewed}\n${handoff}` }] }
      expect(() => assertChannelLogicalHandoff(store.snapshot(), 'turn/start', stale, permits))
        .toThrow('HANDOFF_UNAVAILABLE')
      const statusArgs = {
        store,
        native: native as never,
        fence,
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        recordId: 'status',
        argument: 'status op2',
      }
      expect(await channelLogicalCommand(statusArgs)).toContain('切换已完成')
      const heldSource = fence.beginMigration('source')!
      expect(await channelLogicalCommand(statusArgs)).toContain('原生保护尚未解除')
      heldSource()
      expect(
        await channelLogicalCommand({ ...statusArgs, event: { ...event, actor: { ...event.actor, userId: 'other' } } }),
      )
        .toBe('未找到此操作。')
      const history = createChannelLogicalHistory({
        store,
        native: () => native as never,
        appId: 'codex',
        profileId: 'profile',
      })
      const call = {
        threadId: 'destination',
        turnId: 'turn',
        callId: 'call',
        tool: 'cordisx_continuation_history',
        arguments: {},
      }
      const page = await history(call)
      expect(page.success).toBe(true)
      expect(JSON.stringify(page)).toContain('marker')
      sourceVersion = 'sha256:changed'
      expect((await history(call)).success).toBe(false)
      sourceVersion = 'sha256:fixture'
      await store.mutate(current => {
        current.policy = { ...current.policy, enabled: false }
      })
      expect((await history(call)).success).toBe(false)
      await store.close()
      const reopened = await ChannelConversationStore.open(path.join(dir, 'state.json'))
      expect(reopened.snapshot().logicalContinuations?.intents.op?.orphanDestination?.sessionId).toBe('orphan')
      expect(reopened.snapshot().logicalContinuations?.intents.op2?.handoffJobId).toBe('j')
      await reopened.close()
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
