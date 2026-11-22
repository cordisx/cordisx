import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import { channelLogicalBindingAdmitted } from './channel-logical-continuation-bind.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import { channelTaskChangeAllowed, channelTaskFields, type ChannelTaskPatch } from './channel-task-config.js'

/** Reused at grant issuance and inside the migration transaction. */
export function channelDesktopAuthorization(
  state: ChannelConversationState,
  event: ChannelEventRef,
  profileId: string,
  source: string,
  target: { providerId: string; model: string },
  selection: ChannelTaskPatch,
) {
  return channelLogicalBindingAdmitted(state, event, profileId, source)
    && !channelCommandDenied(state.policy, event, 'continue-provider')
    && !channelTaskFields(target).some(command => channelCommandDenied(state.policy, event, command))
    && channelTaskChangeAllowed(state.taskConfig, state.policy, event, target, { ...selection, ...target })
}
