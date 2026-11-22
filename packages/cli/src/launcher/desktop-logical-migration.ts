import { isDeepStrictEqual } from 'node:util'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { NativeSubmissionControlServer } from './native-submission-control-server.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { LogicalContinuationRequest } from './logical-continuation-control.js'
import { startDesktopLogicalContinuation } from './desktop-logical-continuation.js'
import { logicalPreferenceRevision, resolveLogicalContinuationPreference } from './logical-continuation-preferences.js'
import { desktopLogicalChain } from './desktop-logical-chain.js'
import { jointHistoryPotential } from './channel-joint-history.js'
import { isModelReasoningEffort, type ModelReasoningEffort } from '../model-reasoning-capabilities.js'

export type DesktopLogicalMode = 'linked' | 'fork'

/** Assemble a continuation only from a verified Desktop scope and a separately approved mode. */
export function desktopLogicalMigration(input: {
  owner: ProfileLogicalConversationOwner
  control: NativeSubmissionControlServer
  native(): ChannelNativeSessions | undefined
  profileId: string
  identity(scope: NativeSubmissionScope): Promise<string | undefined>
  dispatchIdentity?(scope: NativeSubmissionScope): Promise<string | undefined>
  targetAllowed(providerId: string, model: string, effort?: ModelReasoningEffort): Promise<boolean>
  historyReady(): boolean
}) {
  return {
    async previous(scope: NativeSubmissionScope) {
      if (!scope.threadId || !input.owner.store.hasCommitBarrier()) return undefined
      const identity = await input.identity(scope)
      if (!identity) return undefined
      const source = { hostId: 'local', appId: 'codex', profileId: input.profileId, sessionId: scope.threadId }
      const logical = input.owner.store.snapshot().logicalContinuations
      const chain = desktopLogicalChain(logical, source, identity)
      if (
        !input.owner.store.hasCommitBarrier() || await input.identity(scope) !== identity
        || !isDeepStrictEqual(input.owner.store.snapshot().logicalContinuations, logical)
      ) return undefined
      return chain.links.at(-1)?.source
    },
    async canNavigate(scope: NativeSubmissionScope, sessionId: string) {
      if (!scope.threadId || !sessionId || sessionId === scope.threadId || !input.owner.store.hasCommitBarrier()) {
        return false
      }
      const identity = await input.identity(scope)
      if (!identity) return false
      const source = { hostId: 'local', appId: 'codex', profileId: input.profileId, sessionId: scope.threadId }
      const logical = input.owner.store.snapshot().logicalContinuations
      const chain = desktopLogicalChain(logical, source, identity)
      return chain.links.some(link => link.source === sessionId) && input.owner.store.hasCommitBarrier()
        && await input.identity(scope) === identity
        && isDeepStrictEqual(input.owner.store.snapshot().logicalContinuations, logical)
    },
    async suggest(
      scope: NativeSubmissionScope,
      target: { providerId: string; model: string },
      effort?: ModelReasoningEffort,
    ) {
      const native = input.native()
      if (
        !scope.threadId || !native || !input.owner.store.hasCommitBarrier()
        || effort !== undefined && !isModelReasoningEffort(effort)
        || !await input.targetAllowed(target.providerId, target.model, effort)
      ) return undefined
      const identity = await input.identity(scope)
      if (!identity) return undefined
      const dispatchReady = !input.dispatchIdentity || await input.dispatchIdentity(scope) === identity
      const config = await native.continuationConfiguration(scope.threadId)
      if (!config) return undefined
      const source = { hostId: 'local', appId: 'codex', profileId: input.profileId, sessionId: scope.threadId }
      const state = input.owner.store.snapshot(), logical = state.logicalContinuations
      const channelBound = Object.values(state.bindings).some(binding => binding.sessionId === scope.threadId)
      const logicalConversationId = logicalConversationIdentity(logical, source)
      if (!logicalConversationId) return undefined
      const preference = logical && resolveLogicalContinuationPreference(logical, {
        profileId: input.profileId,
        conversationId: logicalConversationId,
      })
      const linkedParent = Object.values(logical?.relations ?? {}).some(
        relation => relation.mode === 'linked' && isDeepStrictEqual(relation.destination, source),
      )
      const jointHistoryReady = channelBound && jointHistoryPotential(state, source, identity) && input.historyReady()
        && typeof native.logicalOwnerIdentity === 'function'
        && await native.logicalOwnerIdentity().catch(() => undefined) === identity
        && typeof native.logicalJointSourceRoot === 'function' && await native.logicalJointSourceRoot(source)
      const forkAvailable = !channelBound && native.supportsLogicalFork() && !linkedParent
        && config.providerId === target.providerId && config.model === target.model
      const legacyFreshPreference = preference?.mode === 'fresh'
      const recommended = legacyFreshPreference || preference?.mode === 'fork' && !forkAvailable
        ? 'linked'
        : preference?.mode
          ?? (forkAvailable ? 'fork' : 'linked')
      const chain = desktopLogicalChain(logical, source, identity)
      if (
        !await input.targetAllowed(target.providerId, target.model, effort) || input.native() !== native
        || !input.owner.store.hasCommitBarrier() || await input.identity(scope) !== identity
        || input.dispatchIdentity !== undefined && (await input.dispatchIdentity(scope) === identity) !== dispatchReady
        || !isDeepStrictEqual(input.owner.store.snapshot().logicalContinuations, logical)
      ) return undefined
      const channelChallenge = channelBound ? input.owner.desktopChannelGrants.begin(scope.threadId, target) : undefined
      return {
        recommended,
        forkAvailable,
        linkedAvailable: dispatchReady && (channelBound ? jointHistoryReady : input.historyReady()),
        ...(legacyFreshPreference ? { legacyFreshPreference: true } : {}),
        chain,
        channelBound,
        ...(channelChallenge ? { channelChallenge } : {}),
      }
    },
    async continue(inputAction: {
      scope: NativeSubmissionScope
      operationId: string
      target: { providerId: string; model: string }
      mode: DesktopLogicalMode
      targetReasoningEffort?: ModelReasoningEffort
      remember?: 'conversation' | 'profile' | 'inherit'
      channelCode?: string
      current(): boolean
      configOverrides: Readonly<Record<string, unknown>>
    }) {
      const { scope, target, mode } = inputAction, native = input.native()
      if (!scope.threadId || !native || !inputAction.current()) return undefined
      if (
        inputAction.targetReasoningEffort !== undefined && !isModelReasoningEffort(inputAction.targetReasoningEffort)
        || inputAction.configOverrides.model_reasoning_effort !== inputAction.targetReasoningEffort
      ) {
        return { state: 'rejected' as const, operationId: inputAction.operationId, code: 'TARGET_EFFORT_UNAVAILABLE' }
      }
      if (!['linked', 'fork'].includes(mode)) {
        return { state: 'rejected' as const, operationId: inputAction.operationId, code: 'FRESH_CONTINUATION_REMOVED' }
      }
      const state = input.owner.store.snapshot(),
        source = {
          hostId: 'local',
          appId: 'codex',
          profileId: input.profileId,
          sessionId: scope.threadId,
        }
      const channelBound = Object.values(state.bindings).some(binding => binding.sessionId === scope.threadId)
      if (channelBound && (mode === 'fork' || !inputAction.channelCode) || !channelBound && inputAction.channelCode) {
        return { state: 'rejected' as const, operationId: inputAction.operationId, code: 'CHANNEL_GRANT_REQUIRED' }
      }
      const channelGrant = inputAction.channelCode
        ? input.owner.desktopChannelGrants.consume(
          inputAction.channelCode,
          scope.threadId,
          target,
          'linked',
        )
        : undefined
      if (channelBound && !channelGrant) {
        return { state: 'rejected' as const, operationId: inputAction.operationId, code: 'CHANNEL_GRANT_REQUIRED' }
      }
      const logicalConversationId = logicalConversationIdentity(state.logicalContinuations, source)
      if (!logicalConversationId) return undefined
      const preferenceScope = inputAction.remember && {
        kind: inputAction.remember === 'inherit' ? 'conversation' as const : inputAction.remember,
        id: inputAction.remember === 'profile' ? input.profileId : logicalConversationId,
      }
      const preference = preferenceScope && {
        scope: preferenceScope.kind,
        expectedRevision: state.logicalContinuations
          ? logicalPreferenceRevision(state.logicalContinuations, preferenceScope)
          : 0,
        ...(inputAction.remember === 'inherit' ? { clear: true as const } : {}),
      }
      const common = {
        contract: 'cordisx.conversation-continuation-request/v1' as const,
        operationId: inputAction.operationId,
        logicalConversationId,
        source,
        expectedRevision: state.logicalContinuations?.revision ?? 0,
        target,
      }
      const request: LogicalContinuationRequest = mode === 'linked'
        ? {
          ...common,
          mode,
          historyConsent: 'on-demand',
          handoffConsent: 'none',
          historyCategories: ['user-text', 'assistant-text'],
        }
        : { ...common, mode, historyConsent: 'inherit' }
      return await startDesktopLogicalContinuation({
        owner: input.owner,
        control: input.control,
        native,
        request,
        appId: 'codex',
        profileId: input.profileId,
        ...(preference ? { preference } : {}),
        ...(channelGrant ? { channelGrant } : {}),
        authority: {
          identity: () => input.identity(scope),
          ...(input.dispatchIdentity ? { dispatchIdentity: () => input.dispatchIdentity!(scope) } : {}),
          current: () =>
            inputAction.current()
            && logicalConversationIdentity(input.owner.store.snapshot().logicalContinuations, source)
              === logicalConversationId,
          targetAllowed: input.targetAllowed,
          ...(inputAction.targetReasoningEffort ? { targetReasoningEffort: inputAction.targetReasoningEffort } : {}),
          linkedHistoryReady: input.historyReady(),
          configuredProviderOverrides: inputAction.configOverrides,
        },
      })
    },
  }
}
