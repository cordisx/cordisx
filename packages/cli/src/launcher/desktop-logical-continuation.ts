import { isDeepStrictEqual } from 'node:util'
import type { NativeSubmissionControlServer } from './native-submission-control-server.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import {
  bindChannelLogicalContinuation,
  channelLogicalDestinationAvailable,
} from './channel-logical-continuation-bind.js'
import { LogicalContinuationControl, type LogicalContinuationRequest } from './logical-continuation-control.js'
import { acquireProfileLogicalSource } from './profile-logical-source-lease.js'
import { desktopLogicalNativeRequests } from './desktop-logical-native.js'
import { logicalPreferenceRevision, setLogicalContinuationPreference } from './logical-continuation-preferences.js'
import { channelDesktopAuthorization } from './channel-desktop-authorization.js'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelTaskPatch } from './channel-task-config.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { jointHistorySourceAllowed } from './channel-joint-history.js'

/** A Host-owned verified action, never a model-supplied account or consent. */
export async function startDesktopLogicalContinuation(input: {
  owner: ProfileLogicalConversationOwner
  control: NativeSubmissionControlServer
  native: ChannelNativeSessions
  request: LogicalContinuationRequest
  appId: string
  profileId: string
  preference?: { scope: 'conversation' | 'profile'; expectedRevision: number; clear?: boolean }
  channelGrant?: ChannelEventRef
  authority: {
    identity(): Promise<string | undefined>
    current(): boolean
    targetAllowed(providerId: string, model: string): Promise<boolean>
    linkedHistoryReady: boolean
    configuredProviderOverrides?: Readonly<Record<string, unknown>>
  }
}) {
  const { owner, control, native, request, authority } = input
  const identity = await authority.identity()
  const actor = identity && { principal: identity, scope: `desktop:${input.appId}:${input.profileId}` }
  if (
    !actor || !owner.store.hasCommitBarrier() || !authority.current() || !request?.source
    || typeof request.source.sessionId !== 'string'
    || !request.source.sessionId || request.source.hostId !== 'local' || request.source.appId !== input.appId
    || input.preference !== undefined && (!['conversation', 'profile'].includes(input.preference.scope)
        || !Number.isSafeInteger(input.preference.expectedRevision) || input.preference.expectedRevision < 0)
    || input.preference?.clear !== undefined
      && (input.preference.clear !== true || input.preference.scope !== 'conversation')
    || input.channelGrant !== undefined && request.mode === 'fork'
    || request.source.profileId !== input.profileId || request.mode === 'linked' && (!authority.linkedHistoryReady
        || request.handoffConsent !== 'none')
  ) {
    return {
      state: 'rejected' as const,
      operationId: request?.operationId ?? '',
      code: 'DESKTOP_AUTHORITY_UNAVAILABLE',
    }
  }
  const transaction = channelLogicalTransactionStore(owner.store)
  const prior = transaction.snapshot().logicalContinuations!.intents[request.operationId]
  if (prior) {
    if (!isDeepStrictEqual(prior.actor, actor) || !isDeepStrictEqual(prior.request, request)) {
      return { state: 'rejected' as const, operationId: request.operationId, code: 'OPERATION_ID_CONFLICT' }
    }
    if (prior.state === 'applied' && prior.destination) {
      return {
        state: 'applied' as const,
        operationId: request.operationId,
        destination: prior.destination,
        navigationReady: false,
      }
    }
    if (prior.state === 'rejected') {
      return { state: 'rejected' as const, operationId: request.operationId, code: prior.code ?? 'NATIVE_REJECTED' }
    }
    return {
      state: 'unknown' as const,
      operationId: request.operationId,
      ...(prior.destination
        ? { destination: prior.destination }
        : {}),
    }
  }
  if (request.mode === 'fresh') {
    return { state: 'rejected' as const, operationId: request.operationId, code: 'FRESH_CONTINUATION_REMOVED' }
  }
  const source = request.source.sessionId
  const preferenceScope = input.preference && {
    kind: input.preference.scope,
    id: input.preference.scope === 'profile' ? input.profileId : request.logicalConversationId,
  }
  const lease = await acquireProfileLogicalSource(owner, control, source)
  if (lease.state !== 'acquired') {
    return { state: 'rejected' as const, operationId: request.operationId, code: 'SOURCE_FENCE_UNAVAILABLE' }
  }
  const nativeRequests = desktopLogicalNativeRequests({
    control,
    sourceThreadId: source,
    sourceLease: lease.lease,
    ...(authority.configuredProviderOverrides
      ? { configuredProviderOverrides: authority.configuredProviderOverrides }
      : {}),
  })
  let confirmed: string | undefined
  let releaseTarget: (() => void) | undefined
  let observedSelection: ChannelTaskPatch | undefined
  const target = { providerId: request.target.providerId, model: request.target.model }
  const admitted = (state: ReturnType<typeof owner.store.snapshot>) =>
    authority.current() && (input.channelGrant
      ? !!observedSelection
        && channelDesktopAuthorization(state, input.channelGrant, input.profileId, source, target, observedSelection)
        && (request.mode !== 'linked' || jointHistorySourceAllowed(state, request.source, input.channelGrant, identity))
      : !Object.values(state.bindings).some(binding => binding.sessionId === source)
        && !Object.values(state.jobs).some(job =>
          job.sessionId === source && !['completed', 'failed', 'cancelled'].includes(job.state)
        )
        && !state.taskSettings[source] && !state.continuations[source] && !state.liveTakeovers[source])
    && (!preferenceScope || (state.logicalContinuations
          ? logicalPreferenceRevision(state.logicalContinuations, preferenceScope)
          : 0) === input.preference!.expectedRevision)
    && !Object.values(state.logicalContinuations?.relations ?? {}).some(relation =>
      relation.logicalConversationId === request.logicalConversationId
      && isDeepStrictEqual(relation.source, request.source)
    )
  const engine = new LogicalContinuationControl(transaction, {
    state: root => root.logicalContinuations!,
    admitted: (root, current) => isDeepStrictEqual(current, actor) && admitted(root),
    bind: (root, current, _request, destination) => {
      if (!isDeepStrictEqual(current, actor) || !admitted(root)) return false
      const bound = input.channelGrant
        ? bindChannelLogicalContinuation(
          root,
          input.channelGrant,
          input.profileId,
          source,
          destination.sessionId,
          target,
        )
        : channelLogicalDestinationAvailable(root, source, destination.sessionId)
      if (!bound) return false
      if (input.channelGrant && request.mode === 'linked') {
        root.logicalContinuations!.intents[request.operationId]!.channelHistoryActor = channelLogicalActor(
          input.channelGrant,
        )
      }
      if (preferenceScope) {
        setLogicalContinuationPreference(
          root.logicalContinuations!,
          preferenceScope,
          input.preference!.clear ? null : request.mode,
          input.preference!.expectedRevision,
        )
      }
      return true
    },
    preflight: async current => {
      if (
        !isDeepStrictEqual(current, actor) || !authority.current() || await authority.identity() !== identity
        || !await authority.targetAllowed(request.target.providerId, request.target.model)
      ) return undefined
      if (input.channelGrant) {
        if (
          request.mode === 'linked' && (await native.logicalOwnerIdentity() !== identity
            || !await native.logicalJointSourceRoot(request.source))
        ) return undefined
        const selection = await native.taskSelection(source)
        if (observedSelection && !isDeepStrictEqual(observedSelection, selection)) return undefined
        observedSelection ??= selection
      }
      if (!admitted(owner.store.snapshot())) return undefined
      const config = await native.continuationConfiguration(source)
      if (
        !config || request.mode === 'fork' && (request.target.providerId !== config.providerId
            || request.target.model !== config.model || !native.supportsLogicalFork())
      ) return undefined
      if (
        request.mode === 'fork' && Object.values(owner.store.snapshot().logicalContinuations?.relations ?? {}).some(
          relation => relation.mode === 'linked' && isDeepStrictEqual(relation.destination, request.source),
        )
      ) return undefined
      const version = await native.logicalSourceVersion(request.source)
      if (
        !version || !authority.current() || await authority.identity() !== identity
        || input.channelGrant && request.mode === 'linked' && await native.logicalOwnerIdentity() !== identity
        || input.channelGrant && request.mode === 'linked' && !await native.logicalJointSourceRoot(request.source)
      ) return undefined
      return { sourceConfiguration: config, sourceHistoryVersion: version, handoff: 'none' as const }
    },
    create: async (current, evidence) => {
      const created = await native.createLogicalDestination(
        current,
        evidence,
        owner.fence,
        destination => channelLogicalDestinationAvailable(owner.store.snapshot(), source, destination),
        nativeRequests.nativeRequest,
      )
      if (created.state === 'rejected') return created
      if ('releaseTarget' in created) releaseTarget = created.releaseTarget
      if (created.confirmed) confirmed = created.destination.sessionId
      return { state: 'created' as const, destination: created.destination }
    },
    confirm: async (_request, _evidence, destination) => confirmed === destination.sessionId,
  })
  const result = await engine.start(actor, request)
  if (result.state === 'unknown') return result
  const targetReleased = !nativeRequests.destination() || await nativeRequests.releaseDestination().catch(() => false)
  if (targetReleased) releaseTarget?.()
  const sourceReleased = targetReleased && await lease.release()
  return result.state === 'applied' ? { ...result, navigationReady: sourceReleased } : result
}
