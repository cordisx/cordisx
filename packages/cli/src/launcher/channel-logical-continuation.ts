import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import {
  bindChannelLogicalContinuation,
  channelLogicalDestinationAvailable,
} from './channel-logical-continuation-bind.js'
import { channelLogicalContinuationAdmitted } from './channel-logical-continuation-scope.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { type ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { LogicalContinuationControl, type LogicalContinuationRequest } from './logical-continuation-control.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { channelTaskChangeAllowed, channelTaskFields, type ChannelTaskPatch } from './channel-task-config.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ConversationContinuationPreferenceV1 } from '@cordisx/protocol/conversation-continuation/v1'
import { resolveLogicalContinuationPreference } from './logical-continuation-preferences.js'
import { channelLogicalHandoff } from './channel-logical-handoff.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Event must come from the authenticated Channel transport, never a model argument. */
export async function startChannelLogicalContinuation(input: {
  store: ChannelConversationStore
  native: ChannelNativeSessions
  claims: Set<string>
  fence: ChannelNativeSourceFence
  appId: string
  profileId: string
  event: ChannelEventRef
  request: LogicalContinuationRequest
  preference?: ConversationContinuationPreferenceV1 | null
}) {
  const { store, native, claims, fence, appId, profileId, event, request } = input
  const source = request.source.sessionId
  const actor = channelLogicalActor(event)
  if (request.mode === 'linked' && request.handoffConsent === 'checkpoint' && !native.supportsLogicalHandoff()) {
    return { state: 'rejected' as const, operationId: request.operationId, code: 'HANDOFF_GUARD_UNAVAILABLE' }
  }
  if (claims.has(source)) return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_BUSY' }
  const release = fence.beginMigration(source)
  if (!release) return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_BUSY' }
  claims.add(source)
  let confirmed: string | undefined
  let releaseTarget: (() => void) | undefined
  let handoffDigest: string | undefined
  let observedSelection: ChannelTaskPatch | undefined
  const target = { providerId: request.target.providerId, model: request.target.model }
  const scopeAdmitted = (state: ChannelConversationState) =>
    request.source.hostId === 'local' && request.source.appId === appId && request.source.profileId === profileId
    && channelLogicalContinuationAdmitted(state, event, profileId, source)
  const admitted = (state: ChannelConversationState) =>
    scopeAdmitted(state) && !!observedSelection
    && (request.mode !== 'linked' || request.handoffConsent !== 'checkpoint'
      || native.supportsLogicalHandoff() && !!handoffDigest
        && channelLogicalHandoff(state, request)?.digest === handoffDigest)
    && (input.preference === undefined || isDeepStrictEqual(
      input.preference,
      state.logicalContinuations
        ? resolveLogicalContinuationPreference(state.logicalContinuations, {
          profileId,
          conversationId: request.logicalConversationId,
        }) ?? null
        : null,
    ))
    && !channelTaskFields(target).some(command => channelCommandDenied(state.policy, event, command))
    && channelTaskChangeAllowed(state.taskConfig, state.policy, event, target, { ...observedSelection, ...target })
  const control = new LogicalContinuationControl(channelLogicalTransactionStore(store), {
    state: root => root.logicalContinuations!,
    admitted: (root, caller) => isDeepStrictEqual(caller, actor) && admitted(root),
    bind: (root, caller, _request, destination) =>
      isDeepStrictEqual(caller, actor)
      && bindChannelLogicalContinuation(root, event, profileId, source, destination.sessionId, request.target),
    preflight: async caller => {
      if (!isDeepStrictEqual(caller, actor) || !scopeAdmitted(store.snapshot())) return undefined
      const catalog = object(await native.modelOperation('list', {})).providers
      if (
        !Array.isArray(catalog)
        || !catalog.map(object).some(provider =>
          provider.providerId === request.target.providerId && Array.isArray(provider.models)
          && provider.models.map(object).some(model => model.id === request.target.model)
        )
      ) return undefined
      const selection = await native.taskSelection(source)
      if (observedSelection && !isDeepStrictEqual(observedSelection, selection)) return undefined
      observedSelection ??= selection
      if (request.mode === 'linked' && request.handoffConsent === 'checkpoint') {
        const handoff = channelLogicalHandoff(store.snapshot(), request)
        if (!handoff || handoffDigest && handoffDigest !== handoff.digest) return undefined
        handoffDigest ??= handoff.digest
      }
      if (!admitted(store.snapshot())) return undefined
      const sourceConfiguration = await native.continuationConfiguration(source)
      if (
        !sourceConfiguration || selection.providerId !== sourceConfiguration.providerId
        || selection.model !== sourceConfiguration.model
        || selection.effort !== undefined && selection.effort !== sourceConfiguration.execution.effort
      ) return undefined
      if (
        request.mode === 'fork' && (request.target.providerId !== sourceConfiguration.providerId
          || request.target.model !== sourceConfiguration.model)
      ) return undefined
      if (
        request.mode === 'fork'
        && Object.values(store.snapshot().logicalContinuations?.relations ?? {}).some(parent =>
          parent.mode === 'linked' && isDeepStrictEqual(parent.destination, request.source)
        )
      ) return undefined
      const sourceHistoryVersion = sourceConfiguration && await native.logicalSourceVersion(request.source)
      return sourceConfiguration && sourceHistoryVersion
        ? {
          sourceConfiguration,
          sourceHistoryVersion,
          ...(handoffDigest
            ? { handoff: 'checkpoint' as const, handoffDigest }
            : { handoff: 'none' as const }),
        }
        : undefined
    },
    create: async (current, evidence) => {
      const result = await native.createLogicalDestination(
        current,
        evidence,
        fence,
        destination => channelLogicalDestinationAvailable(store.snapshot(), source, destination),
      )
      if (result.state === 'rejected') return result
      if ('releaseTarget' in result) releaseTarget = result.releaseTarget
      if (result.confirmed) confirmed = result.destination.sessionId
      return { state: 'created' as const, destination: result.destination }
    },
    confirm: async (_request, _evidence, destination) => confirmed === destination.sessionId,
  })
  try {
    return await control.start(actor, request)
  } finally {
    releaseTarget?.()
    claims.delete(source)
    release()
  }
}
