import { expect, it } from 'vitest'
import {
  jointHistoryCurrentEvent,
  jointHistorySourceAllowed,
} from '../packages/cli/src/launcher/channel-joint-history.js'
import { channelLogicalActor } from '../packages/cli/src/launcher/channel-logical-actor.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

it('limits joint history to one direct actor, its binding, and an unlinked source', () => {
  const channel = {
    adapterId: 'test',
    accountId: 'account',
    tenantId: 'tenant',
    conversationId: 'chat',
    threadId: 'chat',
    kind: 'direct' as const,
    semantics: 'conversation' as const,
  }
  const event = {
    ...channel,
    eventId: 'event',
    actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'user' },
  }
  const source = { hostId: 'local', appId: 'codex', profileId: 'profile', sessionId: 'source' }
  const destination = { ...source, sessionId: 'destination' }
  const state = {
    policy: parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
        { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
      ],
    }),
    bindings: { b: { hostId: 'local', profileId: 'profile', sessionId: 'destination', state: 'active', channel } },
    jobs: { j: { sessionId: 'source', recordId: 'r' } },
    inputs: { r: { input: { source: { event } } } },
    logicalContinuations: { relations: {} },
  } as any
  expect(jointHistorySourceAllowed(state, source, event)).toBe(true)
  expect(jointHistoryCurrentEvent(state, destination, channelLogicalActor(event))).toBeDefined()
  state.inputs.r.input.source.event = { ...event, actor: { ...event.actor, userId: 'other' } }
  expect(jointHistorySourceAllowed(state, source, event)).toBe(false)
  state.inputs.r.input.source.event = event
  state.logicalContinuations.relations.parent = { destination: source }
  expect(jointHistorySourceAllowed(state, source, event)).toBe(false)
  state.logicalContinuations.relations.parent = {
    destination: source,
    source: { ...source, sessionId: 'earlier' },
    operationId: 'parent',
    mode: 'linked',
    logicalConversationId: 'logical',
  }
  state.logicalContinuations.intents = {
    parent: {
      state: 'applied',
      channelHistoryActor: channelLogicalActor(event),
      actor: { principal: 'desktop:owner', scope: 'desktop:codex:profile' },
    },
  }
  expect(jointHistorySourceAllowed(state, source, event, 'desktop:owner')).toBe(true)
  expect(jointHistorySourceAllowed(state, source, event, 'desktop:other')).toBe(false)
  state.logicalContinuations.intents.parent.channelHistoryActor.principal = 'other'
  expect(jointHistorySourceAllowed(state, source, event, 'desktop:owner')).toBe(false)
  state.bindings.b.state = 'archived'
  expect(jointHistoryCurrentEvent(state, destination, channelLogicalActor(event))).toBeUndefined()
})
