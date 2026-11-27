import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { startChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-continuation.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { projectDiagnostic } from '../packages/cli/src/diagnostics/journal.js'

it('keeps the recovery stage code in the structured service journal', () => {
  expect(
    projectDiagnostic({ event: 'service-channel-error', errorCode: 'CHANNEL_PROVIDER_RECOVERY_PREFLIGHT_AUTHORITY' }),
  )
    .toEqual({ event: 'service-channel-error', errorCode: 'CHANNEL_PROVIDER_RECOVERY_PREFLIGHT_AUTHORITY' })
})

it.each(['effort', 'history', 'authority'] as const)(
  'reports a fixed preflight stage for %s failure without exposing underlying errors',
  async failed => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-recovery-diagnostic-'))
    const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
    const channel = {
      adapterId: 'test',
      accountId: 'account',
      tenantId: 'tenant',
      conversationId: 'chat',
      threadId: 'chat',
      kind: 'direct' as const,
      semantics: 'conversation' as const,
    }
    const event = { ...channel, eventId: 'event', actor: { ...channel, userId: 'user' } }
    const selection = { providerId: 'source', model: 'model', effort: 'low', fast: false }
    const config = {
      providerId: 'source',
      model: 'model',
      cwd: '/workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      execution: {
        workMode: 'default',
        execution: 'read-only',
        approval: 'on-request',
        effort: failed === 'effort' ? 'high' : 'low',
      },
      sandbox: { type: 'readOnly' },
      permissionProfile: null,
    }
    const diagnostic = vi.fn()
    const create = vi.fn()
    try {
      await store.mutate(state => {
        state.policy = parseChannelConversationPolicy({
          enabled: true,
          rules: [
            { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
            { id: 'commands', action: 'command', effect: 'allow', userIds: ['user'] },
          ],
        })
        state.taskConfig = parseChannelTaskConfig({
          permissions: failed === 'authority'
            ? []
            : [{ id: 'models', effect: 'allow', fields: ['providerId', 'model'], userIds: ['user'] }],
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
      const native = {
        idle: async () => true,
        modelOperation: async () => ({ providers: [{ providerId: 'target', models: [{ id: 'model' }] }] }),
        taskSelection: async () => selection,
        continuationConfiguration: async () => config,
        supportsCrossProviderFork: async () => true,
        logicalSourceVersion: async () => {
          throw new Error('private fixture detail')
        },
        createLogicalDestination: create,
      }
      const result = await startChannelLogicalContinuation({
        store,
        native: native as never,
        fence: new ChannelNativeSourceFence(() => false),
        claims: new Set(),
        appId: 'codex',
        profileId: 'profile',
        event,
        request: {
          contract: 'cordisx.conversation-continuation-request/v1',
          operationId: 'operation',
          logicalConversationId: 'logical',
          source: { hostId: 'local', appId: 'codex', profileId: 'profile', sessionId: 'source' },
          expectedRevision: 0,
          target: { providerId: 'target', model: 'model' },
          mode: 'fork',
          historyConsent: 'inherit',
        },
        automatic: { selection, admitted: () => true, consume: () => true, diagnostic },
      })
      expect(result).toMatchObject({ state: 'rejected', code: 'PREFLIGHT_UNAVAILABLE' })
      expect(diagnostic).toHaveBeenCalledWith(
        failed === 'effort'
          ? 'PREFLIGHT_EFFORT_MISMATCH'
          : failed === 'authority'
          ? 'PREFLIGHT_TASK_CHANGE_NOT_ALLOWED'
          : 'PREFLIGHT_HISTORY_ERROR',
      )
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private fixture detail')
      expect(create).not.toHaveBeenCalled()
      expect(store.snapshot().logicalContinuations?.intents ?? {}).toEqual({})
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
