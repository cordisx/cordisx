import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import {
  bindChannelLogicalContinuation,
  channelLogicalDestinationAvailable,
} from './channel-logical-continuation-bind.js'
import {
  channelLogicalContinuationAdmitted,
  type ChannelTaskContinuationClaim,
} from './channel-logical-continuation-scope.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { type ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { LogicalContinuationControl, type LogicalContinuationRequest } from './logical-continuation-control.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import {
  channelTaskChangeAllowed,
  channelTaskChangeDenied,
  channelTaskFields,
  type ChannelTaskPatch,
} from './channel-task-config.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ConversationContinuationPreferenceV1 } from '@cordisx/protocol/conversation-continuation/v1'
import { resolveLogicalContinuationPreference } from './logical-continuation-preferences.js'
import { channelLogicalHandoff } from './channel-logical-handoff.js'
import type { ContinuationConfiguration } from './channel-continuation-config.js'
import type { acquireChannelLogicalNativeLease } from './channel-logical-native-lease.js'

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
  automatic?: {
    selection: ChannelTaskPatch
    admitted(state: ChannelConversationState): boolean
    consume(state: ChannelConversationState): boolean
    diagnostic?(code: string): void
    /** Only for the exact previously applied selection verified by the recovery owner. */
    confirmedRecovery?: true
    taskClaim?: ChannelTaskContinuationClaim
    destinationConfiguration?(source: ContinuationConfiguration): ContinuationConfiguration
    confirmDestination?(sessionId: string): Promise<boolean>
    group?: { sourceVersion(): Promise<string | undefined> }
  }
}) {
  const { store, native, claims, fence, appId, profileId, event, request } = input
  const source = request.source.sessionId
  const actor = channelLogicalActor(event)
  const previous = store.snapshot().logicalContinuations?.intents[request.operationId]
  if (previous && ['creating', 'unknown'].includes(previous.state)) {
    if (!isDeepStrictEqual(previous.actor, actor) || !isDeepStrictEqual(previous.request, request)) {
      return { state: 'rejected' as const, operationId: request.operationId, code: 'OPERATION_ID_CONFLICT' }
    }
    return {
      state: 'unknown' as const,
      operationId: request.operationId,
      ...(previous.destination ? { destination: previous.destination } : {}),
    }
  }
  if (request.mode === 'linked' && request.handoffConsent === 'checkpoint' && !native.supportsLogicalHandoff()) {
    return { state: 'rejected' as const, operationId: request.operationId, code: 'HANDOFF_GUARD_UNAVAILABLE' }
  }
  if (claims.has(source)) return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_BUSY' }
  const release = fence.beginMigration(source)
  if (!release) return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_BUSY' }
  claims.add(source)
  let confirmed: string | undefined
  let releaseTarget: (() => void) | undefined
  let nativeLease:
    | Extract<Awaited<ReturnType<typeof acquireChannelLogicalNativeLease>>, { state: 'acquired' }>
    | undefined
  let retainFence = false
  let handoffDigest: string | undefined
  let observedSelection: ChannelTaskPatch | undefined
  const target = { providerId: request.target.providerId, model: request.target.model }
  const scopeAdmitted = (state: ChannelConversationState) =>
    request.source.hostId === 'local' && request.source.appId === appId && request.source.profileId === profileId
    && (!!input.automatic?.group
      ? input.automatic.admitted(state)
      : channelLogicalContinuationAdmitted(state, event, profileId, source, input.automatic?.taskClaim))
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
    && (!input.automatic || input.automatic.admitted(state))
    && (!!input.automatic?.group
      || !channelTaskFields(target).some(command => channelCommandDenied(state.policy, event, command))
        && (input.automatic?.confirmedRecovery
          ? !channelCommandDenied(state.policy, event, 'continue-provider')
            && !channelTaskChangeDenied(state.taskConfig, state.policy, event, target, {
              ...observedSelection,
              ...target,
            })
          : channelTaskChangeAllowed(state.taskConfig, state.policy, event, target, {
            ...observedSelection,
            ...target,
          })))
  const diagnose = (code: string) => {
    try {
      input.automatic?.diagnostic?.(code)
    } catch { /* Diagnostics must not change the continuation decision. */ }
  }
  const unavailable = (code: string) => {
    diagnose(code)
    return undefined
  }
  const inspect = async <T>(code: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      diagnose(code)
      throw error
    }
  }
  const control = new LogicalContinuationControl(channelLogicalTransactionStore(store), {
    state: root => root.logicalContinuations!,
    admitted: (root, caller) => isDeepStrictEqual(caller, actor) && admitted(root),
    bind: (root, caller, _request, destination) =>
      isDeepStrictEqual(caller, actor)
      && bindChannelLogicalContinuation(
        root,
        event,
        profileId,
        source,
        destination.sessionId,
        request.target,
        !!input.automatic?.group,
        input.automatic?.taskClaim,
      )
      && (!input.automatic || input.automatic.consume(root)),
    preflight: async caller => {
      if (!isDeepStrictEqual(caller, actor) || !scopeAdmitted(store.snapshot())) return unavailable('PREFLIGHT_SCOPE')
      if (input.automatic && !await inspect('PREFLIGHT_IDLE_ERROR', () => native.idle(source, true))) {
        return unavailable('PREFLIGHT_SOURCE_NOT_IDLE')
      }
      const catalog = object(
        await inspect('PREFLIGHT_CATALOG_ERROR', () => native.modelOperation('list', {})),
      ).providers
      if (
        !Array.isArray(catalog)
        || !catalog.map(object).some(provider =>
          provider.providerId === request.target.providerId && Array.isArray(provider.models)
          && provider.models.map(object).some(model => model.id === request.target.model)
        )
      ) return unavailable('PREFLIGHT_TARGET_UNAVAILABLE')
      const selection = await inspect('PREFLIGHT_SELECTION_ERROR', () => native.taskSelection(source))
      if (input.automatic && !isDeepStrictEqual(input.automatic.selection, selection)) {
        return unavailable('PREFLIGHT_SELECTION_CHANGED')
      }
      if (observedSelection && !isDeepStrictEqual(observedSelection, selection)) {
        return unavailable('PREFLIGHT_SELECTION_CHANGED')
      }
      observedSelection ??= selection
      if (request.mode === 'linked' && request.handoffConsent === 'checkpoint') {
        const handoff = channelLogicalHandoff(store.snapshot(), request)
        if (!handoff || handoffDigest && handoffDigest !== handoff.digest) return unavailable('PREFLIGHT_HANDOFF')
        handoffDigest ??= handoff.digest
      }
      const current = store.snapshot()
      if (!admitted(current)) {
        if (
          !input.automatic?.group
          && !channelTaskFields(target).some(command => channelCommandDenied(current.policy, event, command))
          && !channelTaskChangeDenied(current.taskConfig, current.policy, event, target, { ...selection, ...target })
          && !channelTaskChangeAllowed(current.taskConfig, current.policy, event, target, { ...selection, ...target })
        ) return unavailable('PREFLIGHT_TASK_CHANGE_NOT_ALLOWED')
        return unavailable('PREFLIGHT_AUTHORITY')
      }
      const sourceConfiguration = await inspect(
        'PREFLIGHT_CONFIG_ERROR',
        () => native.continuationConfiguration(source),
      )
      if (!sourceConfiguration) {
        return unavailable('PREFLIGHT_CONFIG_UNAVAILABLE')
      }
      if (selection.providerId !== sourceConfiguration.providerId) return unavailable('PREFLIGHT_PROVIDER_MISMATCH')
      if (selection.model !== sourceConfiguration.model) return unavailable('PREFLIGHT_MODEL_MISMATCH')
      if (selection.effort !== undefined && selection.effort !== sourceConfiguration.execution.effort) {
        return unavailable('PREFLIGHT_EFFORT_MISMATCH')
      }
      if (input.automatic && selection.fast !== (sourceConfiguration.serviceTier === 'priority')) {
        return unavailable('PREFLIGHT_FAST_MISMATCH')
      }
      if (input.automatic?.destinationConfiguration) {
        try {
          input.automatic.destinationConfiguration(sourceConfiguration)
        } catch {
          return unavailable('PREFLIGHT_DESTINATION_CONFIG')
        }
      }
      if (
        request.mode === 'fork' && (request.target.providerId !== sourceConfiguration.providerId
          || request.target.model !== sourceConfiguration.model)
        && await native.supportsCrossProviderFork?.(request.target) !== true
      ) return unavailable('PREFLIGHT_FORK_UNAVAILABLE')
      if (
        request.mode === 'fork'
        && Object.values(store.snapshot().logicalContinuations?.relations ?? {}).some(parent =>
          parent.mode === 'linked' && isDeepStrictEqual(parent.destination, request.source)
        )
      ) return unavailable('PREFLIGHT_LINKED_ANCESTOR')
      const sourceHistoryVersion = await inspect(
        'PREFLIGHT_HISTORY_ERROR',
        () =>
          input.automatic?.group ? input.automatic.group.sourceVersion() : native.logicalSourceVersion(request.source),
      )
      if (!sourceHistoryVersion) {
        return unavailable('PREFLIGHT_HISTORY_UNAVAILABLE')
      }
      return {
        sourceConfiguration,
        sourceHistoryVersion,
        ...(handoffDigest
          ? { handoff: 'checkpoint' as const, handoffDigest }
          : { handoff: 'none' as const }),
      }
    },
    create: async (current, evidence) => {
      const destinationEvidence = input.automatic?.destinationConfiguration
        ? { ...evidence, sourceConfiguration: input.automatic.destinationConfiguration(evidence.sourceConfiguration) }
        : evidence
      const result = await native.createLogicalDestination(
        current,
        destinationEvidence,
        fence,
        destination => channelLogicalDestinationAvailable(store.snapshot(), source, destination),
        nativeLease?.nativeRequest,
      )
      if (result.state === 'rejected') return result
      if ('releaseTarget' in result) releaseTarget = result.releaseTarget
      if (
        result.confirmed && (!input.automatic?.confirmDestination
          || await input.automatic.confirmDestination(result.destination.sessionId))
      ) {
        confirmed = result.destination.sessionId
      }
      return { state: 'created' as const, destination: result.destination }
    },
    confirm: async (_request, _evidence, destination) => confirmed === destination.sessionId,
  })
  try {
    if (native.logicalMigrationLease) {
      let acquired: Awaited<ReturnType<typeof acquireChannelLogicalNativeLease>>
      try {
        acquired = await native.logicalMigrationLease(source)
      } catch {
        acquired = { state: 'unknown' }
      }
      if (acquired.state !== 'acquired') {
        retainFence = acquired.state === 'unknown'
        return {
          state: 'rejected' as const,
          operationId: request.operationId,
          code: acquired.state === 'busy' ? 'SOURCE_BUSY' : 'SOURCE_FENCE_UNAVAILABLE',
        }
      }
      nativeLease = acquired
    }
    if (input.automatic?.taskClaim && !await native.continuationConfiguration(source)) {
      if (!scopeAdmitted(store.snapshot()) || !input.automatic.admitted(store.snapshot())) {
        return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_CHANGED_OR_BUSY' }
      }
      try {
        if (!await native.restoreLogicalSource(source, input.automatic.selection, fence)) {
          return { state: 'rejected' as const, operationId: request.operationId, code: 'PREFLIGHT_UNAVAILABLE' }
        }
      } catch {
        retainFence = true
        return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_FENCE_UNAVAILABLE' }
      }
    }
    const result = await control.start(actor, request)
    if (!nativeLease) return result
    if (result.state === 'unknown') {
      retainFence = true
      return result
    }
    const targetReleased = !nativeLease.destination() || await nativeLease.releaseDestination().catch(() => false)
    const sourceReleased = targetReleased && await nativeLease.releaseSource().catch(() => false)
    if (!sourceReleased) {
      retainFence = true
      return result.state === 'applied'
        ? { ...result, navigationReady: false as const }
        : { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_FENCE_UNAVAILABLE' }
    }
    return result.state === 'applied' ? { ...result, navigationReady: true as const } : result
  } finally {
    claims.delete(source)
    if (!retainFence) {
      releaseTarget?.()
      release()
    }
  }
}
