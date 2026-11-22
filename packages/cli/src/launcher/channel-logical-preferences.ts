import type { ChannelConversationStore } from './channel-conversation-store.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import {
  logicalPreferenceRevision,
  resolveLogicalContinuationPreference,
  setLogicalContinuationPreference,
} from './logical-continuation-preferences.js'

/** Local-only callers own the profile default; it is not an authorization to export history. */
export async function channelLogicalProfilePreference(
  store: ChannelConversationStore,
  profileId: string,
  operation: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const args = value as Record<string, unknown>, scope = { kind: 'profile' as const, id: profileId }
  const transaction = channelLogicalTransactionStore(store)
  if (operation === 'logical-mode-default') {
    if (Object.keys(args).length) throw new Error('INVALID_REQUEST')
    const logical = transaction.snapshot().logicalContinuations!
    return {
      status: 'ok',
      revision: logicalPreferenceRevision(logical, scope),
      preference: resolveLogicalContinuationPreference(logical, { profileId }) ?? null,
      legacyFreshRequiresReselection: resolveLogicalContinuationPreference(logical, { profileId })?.mode === 'fresh',
    }
  }
  if (
    operation !== 'logical-mode-default-set'
    || Object.keys(args).some(key => !['mode', 'expectedRevision'].includes(key))
    || !Number.isSafeInteger(args.expectedRevision)
    || !(args.mode === null || ['linked', 'fork'].includes(String(args.mode)))
  ) {
    throw new Error('INVALID_REQUEST')
  }
  return transaction.mutate(state => {
    const preference = setLogicalContinuationPreference(
      state.logicalContinuations!,
      scope,
      args.mode as 'linked' | 'fork' | null,
      args.expectedRevision as number,
    )
    return {
      status: 'ok',
      revision: logicalPreferenceRevision(state.logicalContinuations!, scope),
      preference: preference ?? null,
    }
  })
}

/** Local profile owners may configure one logical conversation without granting its history. */
export async function channelLogicalConversationPreference(
  store: ChannelConversationStore,
  appId: string,
  profileId: string,
  operation: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const args = value as Record<string, unknown>
  if (
    typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(args.sessionId)
  ) throw new Error('INVALID_REQUEST')
  const source = { hostId: 'local', appId, profileId, sessionId: args.sessionId }
  const transaction = channelLogicalTransactionStore(store)
  const scopeFor = (state: ReturnType<typeof transaction.snapshot>) => {
    const id = logicalConversationIdentity(state.logicalContinuations, source)
    if (!id) throw new Error('CONVERSATION_IDENTITY_AMBIGUOUS')
    return { kind: 'conversation' as const, id }
  }
  if (operation === 'logical-mode-conversation') {
    if (Object.keys(args).some(key => key !== 'sessionId')) throw new Error('INVALID_REQUEST')
    const state = transaction.snapshot(), scope = scopeFor(state), logical = state.logicalContinuations!
    return {
      status: 'ok',
      conversationId: scope.id,
      revision: logicalPreferenceRevision(logical, scope),
      preference: resolveLogicalContinuationPreference(logical, { profileId, conversationId: scope.id }) ?? null,
      legacyFreshRequiresReselection:
        resolveLogicalContinuationPreference(logical, { profileId, conversationId: scope.id })?.mode === 'fresh',
    }
  }
  if (
    operation !== 'logical-mode-conversation-set'
    || Object.keys(args).some(key => !['sessionId', 'mode', 'expectedRevision', 'expectedConversationId'].includes(key))
    || !Number.isSafeInteger(args.expectedRevision)
    || typeof args.expectedConversationId !== 'string'
    || !(args.mode === null || ['linked', 'fork'].includes(String(args.mode)))
  ) {
    throw new Error('INVALID_REQUEST')
  }
  return transaction.mutate(state => {
    const scope = scopeFor(state), logical = state.logicalContinuations!
    if (scope.id !== args.expectedConversationId) throw new Error('CONVERSATION_IDENTITY_CHANGED')
    const preference = setLogicalContinuationPreference(
      logical,
      scope,
      args.mode as 'linked' | 'fork' | null,
      args.expectedRevision as number,
    )
    return {
      status: 'ok',
      conversationId: scope.id,
      revision: logicalPreferenceRevision(logical, scope),
      preference: preference ?? null,
    }
  })
}
