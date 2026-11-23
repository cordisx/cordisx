import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelPolicyScope } from './channel-conversation-policy.js'
import { channelSameScope, channelText, parseChannelConversationPolicy } from './channel-conversation-policy.js'
import { identity } from './channel-conversation-refs.js'
import { parseChannelGroupUserTaskAccess } from './channel-group-access.js'

/** Message commands and the scoped CLI own the same rules; reset never removes another owner's denial. */
export function channelTaskPolicyChange(
  state: ChannelConversationState,
  scope: ChannelPolicyScope,
  command: string,
  argument = '',
  groupGrant = false,
): void {
  const id = `command:${identity([scope, command.includes('user') ? argument : 'messages'])}`
  const rules = state.policy.rules.filter(rule => rule.id !== id)
  if (command === 'messages-off' || command === 'allow-user' && !groupGrant || command === 'deny-user') {
    rules.push({
      id,
      ...scope,
      action: 'dispatch',
      effect: command === 'allow-user' ? 'allow' : 'deny',
      ...(command.includes('user') ? { userIds: [channelText(argument)] } : {}),
    })
  }
  if (command.includes('user')) {
    const prior = state.groupUserTaskAccess ?? []
    const exists = prior.find(item => channelSameScope(item, scope) && item.userId === argument)
    state.groupUserTaskAccess = parseChannelGroupUserTaskAccess([
      ...prior.filter(item => !channelSameScope(item, scope) || item.userId !== argument),
      ...(command === 'allow-user' && groupGrant
        ? [{ ...scope, userId: argument, fromSequence: exists?.fromSequence ?? state.nextSequence }]
        : []),
    ])
  }
  const wakePrefixes = command === 'wake'
    ? [
      ...state.policy.wakePrefixes.filter(item => !channelSameScope(item, scope)),
      ...(argument === '--clear' ? [] : [{ ...scope, prefixes: [channelText(argument)] }]),
    ]
    : state.policy.wakePrefixes
  state.policy = parseChannelConversationPolicy({ ...state.policy, rules, wakePrefixes })
  state.policyRevision += 1
}
