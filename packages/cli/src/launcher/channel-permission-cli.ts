import { isDeepStrictEqual } from 'node:util'
import type { ChannelAgentAccess } from './channel-agent-access.js'
import type { ChannelCommandUsers } from './channel-command-users.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import {
  channelCommandScope,
  channelExact,
  channelGlobalCommandAllowed,
  channelPolicyAllows,
  channelPolicyDenied,
  channelRecord,
  channelSameScope,
  channelText,
} from './channel-conversation-policy.js'
import { channelGroupSourceRecord } from './channel-group-access.js'
import { channelTaskPolicyChange } from './channel-task-policy-change.js'
import {
  channelGroupBlockIntent,
  channelSameUserArgument,
  type ChannelUserAccessEffect,
  channelUserAccessIntent,
} from './channel-permission-intent.js'
import { identity } from './channel-conversation-refs.js'

const commands = { allow: 'allow-user', deny: 'deny-user', reset: 'reset-user' } as const

/** These operations can change task admission only, never arbitrary policy or management grants. */
export async function channelPermissionOperation(input: {
  readonly operation: string
  readonly value: unknown
  readonly metadata: unknown
  readonly store: ChannelConversationStore
  readonly agent: ChannelAgentAccess
  readonly users: ChannelCommandUsers
  readonly access: () => ChannelConversationAccess | undefined
  readonly signal: AbortSignal
}) {
  const args = channelRecord(input.value), write = input.operation.endsWith('-set')
  const userOperation = input.operation.startsWith('user-access')
  channelExact(
    args,
    userOperation
      ? ['user', 'scope', ...(write ? ['effect', 'expectedRevision'] : [])]
      : write
      ? ['blocked', 'expectedRevision']
      : [],
  )
  if (write && (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)) {
    throw new Error('INVALID_REQUEST')
  }
  if (userOperation && args.scope !== undefined && !['conversation', 'account'].includes(String(args.scope))) {
    throw new Error('INVALID_REQUEST')
  }
  const effect = args.effect as ChannelUserAccessEffect
  if (write && (userOperation ? !Object.hasOwn(commands, effect) : typeof args.blocked !== 'boolean')) {
    throw new Error('INVALID_REQUEST')
  }
  const caller = input.agent.caller(input.metadata), event = caller?.source, access = input.access()
  if (
    !event?.actor?.userId || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
    || event.actor.tenantId !== event.tenantId
  ) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  if (!userOperation && event.kind !== 'group') throw new Error('CHANNEL_GROUP_REQUIRED')
  const generation = access?.generation
  const live = () =>
    !input.signal.aborted && generation !== undefined && input.access()?.generation === generation
    && input.access()?.accounts().some(account =>
      channelSameScope(account.ref, {
        adapterId: event.adapterId,
        accountId: event.accountId,
        tenantId: event.tenantId,
      }) && account.state === 'ready'
    )
    && isDeepStrictEqual(input.agent.caller(input.metadata)?.source, event)
  if (!live()) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  const account = args.scope === 'account'
  const scope = account
    ? { adapterId: event.adapterId, accountId: event.accountId, tenantId: event.tenantId }
    : channelCommandScope(event, false)
  const allowed = (state: ChannelConversationState, command: string) =>
    state.policy.enabled && channelPolicyAllows(state.policy, 'command', event, command)
    && (!account || channelGlobalCommandAllowed(state.policy, event, command))
  const command = userOperation ? commands[effect] : args.blocked ? 'messages-off' : 'messages-on'
  let userId: string | undefined
  if (userOperation) {
    const user = channelText(args.user)
    if (write) {
      const intent = channelUserAccessIntent(input.agent.requestText(input.metadata), effect)
      if (!intent || intent.account !== account || !channelSameUserArgument(intent.user, user)) {
        throw new Error('CHANNEL_PERMISSION_REQUEST_REQUIRED')
      }
    }
    // Do not disclose directory candidates or begin lookup for an unauthorized mutation.
    if (
      !allowed(input.store.snapshot(), write ? command : 'allow-user')
      && (write || !['deny-user', 'reset-user'].some(name => allowed(input.store.snapshot(), name)))
    ) {
      throw new Error('CHANNEL_PERMISSION_DENIED')
    }
    const record = channelGroupSourceRecord(input.store.snapshot(), event)
    const resolution = await input.users.resolve({
      event,
      command: write ? command : 'allow-user',
      argument: user,
      global: account,
      ...(generation === undefined ? {} : { generation }),
      ...(record?.addressing === undefined ? {} : { addressing: record.addressing }),
      ...(access?.users ? { directory: () => access.users!(event) } : {}),
    })
    if (!live()) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    if (
      !allowed(input.store.snapshot(), write ? command : 'allow-user')
      && (write || !['deny-user', 'reset-user'].some(name => allowed(input.store.snapshot(), name)))
    ) throw new Error('CHANNEL_PERMISSION_DENIED')
    if ('message' in resolution) return { status: 'choice-required', message: resolution.message }
    userId = resolution.userId
  }
  const read = (state: ChannelConversationState) => {
    const ownedId = `command:${identity([scope, userOperation ? userId : 'messages'])}`
    const owned = state.policy.rules.find(rule => rule.id === ownedId)
    const grant = userOperation
      && state.groupUserTaskAccess?.find(item => channelSameScope(item, scope) && item.userId === userId)
    const target = userId ? { ...event, actor: { ...event.actor!, userId } } : event
    return {
      revision: state.policyRevision,
      scope,
      ...(userOperation
        ? {
          userId,
          effect: owned?.effect ?? (grant ? 'allow' : 'reset'),
          dispatchAllowed: state.policy.enabled && !channelPolicyDenied(state.policy, 'dispatch', target)
            && (channelPolicyAllows(state.policy, 'dispatch', target) || !!grant
              || event.kind === 'group' && state.groupTaskAccess?.some(item => channelSameScope(item, event)) === true),
          grantForFutureMentions: !!grant,
          fromSequence: grant ? grant.fromSequence : null,
          explicitlyDenied: channelPolicyDenied(state.policy, 'dispatch', target),
          canAllow: allowed(state, 'allow-user'),
          canDeny: allowed(state, 'deny-user'),
          canReset: allowed(state, 'reset-user'),
        }
        : {
          blocked: owned?.effect === 'deny',
          canBlock: allowed(state, 'messages-off'),
          canRestore: allowed(state, 'messages-on'),
          recovery: '/messages-on',
        }),
    }
  }
  if (!write) return { status: 'ok', ...read(input.store.snapshot()) }
  await input.store.mutate(state => {
    if (!live()) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    if (!allowed(state, command)) throw new Error('CHANNEL_PERMISSION_DENIED')
    const record = channelGroupSourceRecord(state, event)
    if (!record?.accepted || !record.routed || event.kind === 'group' && !record.mentionedBot) {
      throw new Error('CHANNEL_AUTHENTICATED_INPUT_REQUIRED')
    }
    if (userOperation) {
      const intent = channelUserAccessIntent(input.agent.requestText(input.metadata), effect)
      if (!intent || intent.account !== account || !channelSameUserArgument(intent.user, channelText(args.user))) {
        throw new Error('CHANNEL_PERMISSION_REQUEST_REQUIRED')
      }
    }
    if (!userOperation && !channelGroupBlockIntent(input.agent.requestText(input.metadata), args.blocked as boolean)) {
      throw new Error('CHANNEL_PERMISSION_REQUEST_REQUIRED')
    }
    if (state.policyRevision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
    channelTaskPolicyChange(state, scope, command, userId, userOperation && !account && event.kind === 'group')
  })
  return { status: 'ok', ...read(input.store.snapshot()) }
}
