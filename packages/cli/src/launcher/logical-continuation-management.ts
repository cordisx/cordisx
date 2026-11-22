import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import { channelLogicalConversationPreference, channelLogicalProfilePreference } from './channel-logical-preferences.js'
import { logicalContinuationStatus } from './logical-continuation-status.js'
import { logicalContinuationChain } from './logical-continuation-chain.js'
import { abandonDesktopLogicalContinuation } from './desktop-logical-abandon.js'

/** Local management is shared by Desktop-only and configured Channel owners. */
export function logicalContinuationManagement(
  input: {
    owner: ProfileLogicalConversationOwner
    appId?: string
    profileId: string
    available: boolean
    recoveryRequired: boolean
  },
  operation: string,
  value: unknown,
) {
  if (!input.available) throw new Error('LOGICAL_RUNTIME_UNAVAILABLE')
  const { owner, appId, profileId } = input
  if (
    input.recoveryRequired && !owner.store.hasCommitBarrier()
    && !['logical-status', 'logical-chain'].includes(operation)
  ) {
    throw new Error('LOGICAL_RECOVERY_UNAVAILABLE')
  }
  if (operation === 'logical-status') {
    if (!appId) throw new Error('LOGICAL_RUNTIME_UNAVAILABLE')
    return {
      ...logicalContinuationStatus(owner.store, appId, profileId, value),
      ...(input.recoveryRequired ? { recoveryReady: owner.store.hasCommitBarrier() } : {}),
    }
  }
  if (operation === 'logical-chain') {
    if (!appId) throw new Error('LOGICAL_RUNTIME_UNAVAILABLE')
    return logicalContinuationChain(owner.store, appId, profileId, value)
  }
  if (operation === 'logical-abandon') {
    if (!appId) throw new Error('LOGICAL_RUNTIME_UNAVAILABLE')
    return abandonDesktopLogicalContinuation(owner, appId, profileId, value)
  }
  if (operation.startsWith('logical-mode-conversation')) {
    if (!appId) throw new Error('LOGICAL_RUNTIME_UNAVAILABLE')
    return channelLogicalConversationPreference(owner.store, appId, profileId, operation, value)
  }
  return channelLogicalProfilePreference(owner.store, profileId, operation, value)
}
