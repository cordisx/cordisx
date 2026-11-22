import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { channelLogicalCommand } from '../packages/cli/src/launcher/channel-logical-command.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'
import { createDesktopLogicalHistory } from '../packages/cli/src/launcher/desktop-logical-history.js'
import { createChannelLogicalHistory } from '../packages/cli/src/launcher/channel-logical-history.js'

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

it.each(['success', 'revoked', 'binding-changed', 'linked'] as const)(
  'guards a direct binding and queued job when authorization is %s',
  async scenario => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-channel-grant-'))
    const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
    const owner = profileLogicalConversationOwner(store)
    const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true })
    try {
      h.server.bindLogicalFenceOwner(owner)
      h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
      await h.read()
      const started = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
        thread: { id: string }
      }
      const source = started.thread.id
      await store.mutate(state => {
        state.policy = parseChannelConversationPolicy({
          enabled: true,
          rules: [
            { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
            { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
          ],
        })
        state.taskConfig = parseChannelTaskConfig({
          permissions: [
            { id: 'target', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] },
          ],
        })
        state.bindings.b = {
          id: 'b',
          channel,
          sessionId: source,
          hostId: 'local',
          profileId: 'profile',
          createdAt: '',
          fromSequence: 0,
          mode: 'deliver',
          autoReply: false,
          state: 'active',
        }
        state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
        state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: source }
      })
      const config = {
        providerId: 'old',
        model: 'old',
        cwd: '/workspace',
        serviceTier: null,
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly' },
        permissionProfile: null,
        execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
      }
      let nativeIdentity = 'desktop:fixture'
      let activeEvent = event
      let changeIdentityOnRead = false
      const native = {
        continuationConfiguration: async () => config,
        taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
        logicalSourceVersion: async () => 'version',
        logicalOwnerIdentity: async () => nativeIdentity,
        logicalJointSourceRoot: async () => true,
        logicalTurnActive: async () => true,
        logicalContextTokens: () => [],
        sourceFor: () => activeEvent,
        sourceForLogicalTurn: async () => activeEvent,
        logicalHistoryPage: async (sourceRef: { sessionId: string }) => {
          if (changeIdentityOnRead) nativeIdentity = 'desktop:other'
          return { items: [{ type: 'agentMessage', text: 'joint-source:' + sourceRef.sessionId }] }
        },
        supportsLogicalFork: () => true,
        createLogicalDestination: vi.fn(
          async (
            request: { source: { sessionId: string } },
            _evidence: unknown,
            fence: typeof owner.fence,
            _available: unknown,
            send: (method: 'thread/start', params: {}) => Promise<unknown>,
          ) => {
            const created = await send('thread/start', { modelProvider: 'openai' }) as { thread: { id: string } }
            if (scenario === 'revoked') {
              await store.mutate(state => {
                state.policy.enabled = false
              })
            }
            if (scenario === 'binding-changed') {
              await store.mutate(state => {
                state.bindings.b = { ...state.bindings.b!, state: 'archived' }
              })
            }
            return {
              state: 'created' as const,
              confirmed: true,
              destination: { ...request.source, sessionId: created.thread.id },
              releaseTarget: fence.beginMigration(created.thread.id)!,
            }
          },
        ),
      }
      const migration = desktopLogicalMigration({
        owner,
        control: h.server,
        native: () => native as never,
        profileId: 'profile',
        identity: async () => 'desktop:fixture',
        targetAllowed: async () => true,
        historyReady: () => true,
      })
      const scope = { targetId: 'window', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: source }
      const target = { providerId: 'new', model: 'model' }
      const suggestion = await migration.suggest(scope, target)
      expect(suggestion).toMatchObject({
        channelBound: true,
        forkAvailable: false,
        linkedAvailable: true,
      })
      const code = suggestion?.channelChallenge
      expect(code).toBeDefined()
      const command = {
        store,
        native: native as never,
        fence: owner.fence,
        claims: new Set<string>(),
        appId: 'codex',
        profileId: 'profile',
        event,
        recordId: 'grant',
        desktopGrants: owner.desktopChannelGrants,
        argument: 'authorize-desktop linked new model --history=user-assistant --no-checkpoint --challenge=' + code,
      }
      const denied = await channelLogicalCommand({
        ...command,
        event: { ...event, actor: { ...event.actor, userId: 'other' } },
      })
      expect(denied).not.toContain('已授权')
      await store.mutate(state => {
        state.inputs.r = {
          recordId: 'r',
          input: { source: { event: { ...event, actor: { ...event.actor, userId: 'other' } } } },
          accepted: true,
        } as never
      })
      expect(await channelLogicalCommand(command)).not.toContain('已授权')
      await store.mutate(state => {
        state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
      })
      expect(await channelLogicalCommand(command)).toContain('已授权')
      expect(
        await migration.continue({
          scope,
          target,
          operationId: 'no-grant',
          mode: 'linked',
          current: () => true,
          configOverrides: {},
        }),
      )
        .toMatchObject({ state: 'rejected', code: 'CHANNEL_GRANT_REQUIRED' })
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      const result = await migration.continue({
        scope,
        target,
        operationId: 'operation',
        mode: 'linked',
        channelCode: code,
        current: () => true,
        configOverrides: {},
      })
      const state = store.snapshot()
      if (scenario === 'success' || scenario === 'linked') {
        expect(result).toMatchObject({ state: 'applied', navigationReady: true })
        if (result?.state !== 'applied') throw new Error('MIGRATION_UNAVAILABLE')
        expect(state.bindings.b?.sessionId).toBe(result.destination.sessionId)
        expect(state.jobs.j?.sessionId).toBe(result.destination.sessionId)
        expect(state.logicalContinuations?.relations.operation).toMatchObject({
          mode: 'linked',
          historyAccess: 'on-demand',
        })
        if (scenario === 'linked') {
          const desktop = createDesktopLogicalHistory({
            owner,
            native: native as never,
            appId: 'codex',
            profileId: 'profile',
            activeIdentity: async () => 'desktop:fixture',
          })
          const channelHistory = createChannelLogicalHistory({
            store,
            native: () => native as never,
            appId: 'codex',
            profileId: 'profile',
          })
          let call = {
            threadId: result.destination.sessionId,
            turnId: 'turn',
            callId: 'call',
            tool: 'cordisx_continuation_history',
            arguments: {},
          }
          expect(JSON.stringify(await desktop(call))).toContain('joint-source')
          expect(JSON.stringify(await channelHistory(call))).toContain('joint-source')
          const nextScope = { ...scope, threadId: result.destination.sessionId }
          const nextTarget = { providerId: 'third', model: 'another' }
          const next = await migration.suggest(nextScope, nextTarget)
          expect(next?.linkedAvailable).toBe(true)
          const nextCode = next?.channelChallenge
          expect(
            await channelLogicalCommand({
              ...command,
              argument: 'authorize-desktop linked third another --history=user-assistant --no-checkpoint --challenge='
                + nextCode,
            }),
          ).toContain('已授权')
          const second = await migration.continue({
            scope: nextScope,
            target: nextTarget,
            operationId: 'second-operation',
            mode: 'linked',
            channelCode: nextCode,
            current: () => true,
            configOverrides: {},
          })
          expect(second).toMatchObject({ state: 'applied', navigationReady: true })
          if (second?.state !== 'applied') throw new Error('SECOND_MIGRATION_UNAVAILABLE')
          call = { ...call, threadId: second.destination.sessionId }
          const firstPage = await channelHistory(call)
          expect(firstPage.success).toBe(true)
          expect(JSON.stringify(firstPage)).toContain(result.destination.sessionId)
          const cursor = JSON.parse(firstPage.contentItems[0]!.text).nextCursor
          expect(typeof cursor).toBe('string')
          const priorPage = await channelHistory({ ...call, arguments: { cursor } })
          expect(JSON.stringify(priorPage)).toContain(source)
          activeEvent = { ...event, actor: { ...event.actor, userId: 'other' } }
          expect((await channelHistory(call)).success).toBe(false)
          activeEvent = event
          await store.mutate(state => {
            state.policy.enabled = false
          })
          expect((await desktop(call)).success).toBe(false)
          expect((await channelHistory(call)).success).toBe(false)
          await store.mutate(state => {
            state.policy.enabled = true
          })
          nativeIdentity = 'desktop:other'
          expect((await desktop(call)).success).toBe(false)
          expect((await channelHistory(call)).success).toBe(false)
          nativeIdentity = 'desktop:fixture'
          changeIdentityOnRead = true
          expect((await channelHistory(call)).success).toBe(false)
          await store.close()
          const reopened = await ChannelConversationStore.open(path.join(dir, 'state.json'))
          try {
            expect(reopened.snapshot().logicalContinuations?.intents.operation?.channelHistoryActor).toEqual({
              principal: 'user',
              scope: JSON.stringify([
                channel.adapterId,
                channel.accountId,
                channel.tenantId,
                channel.conversationId,
                channel.threadId,
                channel.kind,
                channel.semantics,
              ]),
            })
          } finally {
            await reopened.close()
          }
        }
      } else {
        expect(result).toMatchObject({ state: 'unknown' })
        expect(state.bindings.b?.sessionId).toBe(source)
        expect(state.jobs.j?.sessionId).toBe(source)
        expect(state.logicalContinuations?.relations.operation).toBeUndefined()
      }
      expect(JSON.stringify(state)).not.toContain(code)
      expect(owner.desktopChannelGrants.consume(code!, source, target, 'linked'))
        .toBeUndefined()
    } finally {
      await store.close()
      await h.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
