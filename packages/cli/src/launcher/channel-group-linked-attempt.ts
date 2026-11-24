import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type {
  ChannelConversationJob,
  ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ChannelIdlePriorityGrant } from './channel-idle-priority-grant.js'
import { captureChannelGroupHistory, channelGroupProjectionVersion } from './channel-group-history-projection.js'
import { channelIdlePriorityOperation } from './channel-idle-priority-status.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'
import { startChannelLogicalContinuation } from './channel-logical-continuation.js'

/** A linked target receives only this exact group's bounded transport projection, never native raw history. */
export async function attemptChannelGroupLinked(input: {
  store: ChannelConversationStore
  native: ChannelNativeSessions
  access: () => ChannelConversationAccess | undefined
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId: string
  profileId: string
  event: ChannelEventRef
  job: ChannelConversationJob
  grant: ChannelIdlePriorityGrant
  target: ChannelIdlePriorityGrant['target']
  sequence: number
  admitted(state: ChannelConversationState): boolean
}): Promise<void> {
  const { store, native, grant, target, job, event } = input
  if (!native.logicalMigrationLease || !grant.groupLinked) return
  const capture = () =>
    captureChannelGroupHistory({
      state: store.snapshot(),
      access: input.access(),
      bindingId: grant.bindingId,
      beforeSequence: input.sequence,
      authorizer: grant.actor,
      expiresAt: grant.expiresAt,
      target,
      selection: grant.selection,
    })
  const projection = capture()
  if (!projection) {
    await store.mutate(state => {
      const current = state.jobs[job.id]
      if (current?.state === 'queued' && input.admitted(state)) {
        current.state = 'failed'
        current.code = 'GROUP_HISTORY_UNAVAILABLE'
        current.failureNotice ??= 'pending'
      }
    })
    return
  }
  if (!input.admitted(store.snapshot())) return
  const version = channelGroupProjectionVersion(projection)
  const operationId = channelIdlePriorityOperation(job.id)
  const revision = store.snapshot().logicalContinuations?.revision ?? 0
  let invoked = false
  try {
    input.claims.delete(grant.source.sessionId)
    invoked = true
    const result = await startChannelLogicalContinuation({
      ...input,
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId,
        logicalConversationId: grant.logicalId,
        source: grant.source,
        expectedRevision: revision,
        target,
        mode: 'linked',
        historyConsent: 'on-demand',
        historyCategories: ['user-text', 'assistant-text'],
        handoffConsent: 'none',
      },
      automatic: {
        selection: grant.selection,
        admitted: input.admitted,
        group: {
          sourceVersion: async () => {
            const next = capture()
            return next && isDeepStrictEqual(next, projection) && input.admitted(store.snapshot()) ? version : undefined
          },
        },
        consume: state => {
          const logical = state.logicalContinuations, current = logical?.idlePriorityGrants?.[grant.bindingId]
          const intent = logical?.intents[operationId], destination = state.bindings[grant.bindingId]?.sessionId
          if (!logical || !intent || !destination || !isDeepStrictEqual(current, grant)) return false
          intent.groupProjection = structuredClone(projection)
          const candidates = [grant.target, ...(grant.fallbackTargets ?? [])]
          const remaining = candidates.slice(candidates.findIndex(row => isDeepStrictEqual(row, target)) + 1)
          if (!remaining.length) removeChannelIdlePriorityGrant(logical, grant.bindingId)
          else {logical.idlePriorityGrants![grant.bindingId] = {
              ...grant,
              source: { ...grant.source, sessionId: destination },
              selection: { ...grant.selection, ...target },
              target: remaining[0]!,
              fallbackTargets: remaining.slice(1),
            }}
          return true
        },
      },
    })
    if (
      result.state === 'unknown'
      || result.state === 'applied' && 'navigationReady' in result && result.navigationReady === false
      || result.state === 'rejected' && result.code === 'SOURCE_FENCE_UNAVAILABLE'
    ) {
      await store.mutate(state => {
        const current = state.jobs[job.id]
        if (current?.state === 'queued') {
          current.state = 'reconciliation-required'
          current.code = 'IDLE_PRIORITY_MIGRATION_UNCERTAIN'
          current.failureNotice ??= 'pending'
        }
      })
    } else if (result.state === 'rejected' && result.code !== 'SOURCE_BUSY') {
      await store.mutate(state => {
        const current = state.jobs[job.id]
        if (current?.state === 'queued' && input.admitted(state)) {
          current.state = 'failed'
          current.code = 'MODEL_PRIORITY_UNAVAILABLE'
          current.failureNotice ??= 'pending'
        }
      })
    }
  } catch {
    if (invoked) {
      await store.mutate(state => {
        const current = state.jobs[job.id]
        if (current?.state === 'queued') {
          current.state = 'reconciliation-required'
          current.code = 'IDLE_PRIORITY_MIGRATION_UNCERTAIN'
          current.failureNotice ??= 'pending'
        }
      }).catch(() => {})
    }
  }
}
