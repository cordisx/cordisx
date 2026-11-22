import { describe, expect, it } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelLogicalContinuationAdmitted } from '../packages/cli/src/launcher/channel-logical-continuation-scope.js'
import { bindChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-continuation-bind.js'
import { CHANNEL_CONVERSATION_POLICY_INITIAL } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import type { ChannelConversationState } from '../packages/cli/src/launcher/channel-conversation-store.js'

const channel = {
  adapterId: 'feishu',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'chat',
  threadId: 'thread',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const event: ChannelEventRef = {
  ...channel,
  eventId: 'event',
  actor: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant', userId: 'owner' },
}
function fixture(): ChannelConversationState {
  return {
    policy: {
      ...CHANNEL_CONVERSATION_POLICY_INITIAL,
      enabled: true,
      rules: [
        { id: 'dispatch-owner', action: 'dispatch', effect: 'allow', userIds: ['owner'] },
        { id: 'command-owner', action: 'command', effect: 'allow', userIds: ['owner'] },
      ],
    },
    bindings: {
      binding: {
        id: 'binding',
        channel,
        sessionId: 'source',
        hostId: 'local',
        profileId: 'profile',
        createdAt: '',
        fromSequence: 0,
        mode: 'deliver',
        autoReply: true,
        state: 'active',
      },
    },
    inputs: {},
    jobs: {},
    taskRequests: {},
    taskSettings: {},
    continuations: {},
    liveTakeovers: {},
  } as unknown as ChannelConversationState
}

describe('Channel logical continuation scope', () => {
  it('admits only the current authorized owner and exact active direct binding', () => {
    const state = fixture()
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(true)
    expect(
      channelLogicalContinuationAdmitted(
        state,
        { ...event, actor: { ...event.actor!, userId: 'other' } },
        'profile',
        'source',
      ),
    ).toBe(false)
    for (const field of ['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId'] as const) {
      expect(channelLogicalContinuationAdmitted(state, { ...event, [field]: 'other' }, 'profile', 'source')).toBe(false)
    }
    expect(channelLogicalContinuationAdmitted(state, event, 'other-profile', 'source')).toBe(false)
    expect(channelLogicalContinuationAdmitted(state, { ...event, kind: 'group' }, 'profile', 'source')).toBe(false)
  })
  it('refuses ambiguous sources, revoked policy, pending work and unknown native outcomes', () => {
    const state = fixture()
    state.bindings.other = { ...state.bindings.binding!, id: 'other' }
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(false)
    delete state.bindings.other
    state.policy = { ...state.policy, enabled: false }
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(false)
    state.policy = { ...state.policy, enabled: true }
    state.jobs.pending = { id: 'pending', recordId: 'r', autoCreate: false, state: 'running', sessionId: 'source' }
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(false)
    delete state.jobs.pending
    state.taskSettings.source = { revision: 1, settings: {}, application: 'unknown' }
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(false)
  })
  it('moves an authorized queued job and binding together while retaining source history', () => {
    const state = fixture()
    state.jobs.queued = {
      id: 'queued',
      recordId: 'r',
      bindingId: 'binding',
      autoCreate: false,
      state: 'queued',
      sessionId: 'source',
    }
    state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
    state.taskSettings.source = { revision: 1, settings: {}, application: 'applied' }
    expect(channelLogicalContinuationAdmitted(state, event, 'profile', 'source')).toBe(true)
    const target = { providerId: 'new', model: 'model' }
    expect(bindChannelLogicalContinuation(state, event, 'profile', 'source', 'destination', target)).toBe(true)
    expect(state.bindings.binding?.sessionId).toBe('destination')
    expect(state.jobs.queued?.sessionId).toBe('destination')
    expect(state.inputs.r?.input.source.event).toEqual(event)
    expect(state.taskSettings.destination).toMatchObject({ settings: target, application: 'applied' })
  })
  it('makes no changes when queued ownership or destination conflicts', () => {
    const state = fixture()
    state.jobs.queued = {
      id: 'queued',
      recordId: 'r',
      bindingId: 'binding',
      autoCreate: false,
      state: 'queued',
      sessionId: 'source',
    }
    state.inputs.r = {
      recordId: 'r',
      input: { source: { event: { ...event, actor: { ...event.actor!, userId: 'other' } } } },
      accepted: true,
    } as never
    const before = structuredClone(state)
    expect(
      bindChannelLogicalContinuation(state, event, 'profile', 'source', 'destination', {
        providerId: 'new',
        model: 'model',
      }),
    ).toBe(false)
    expect(state).toEqual(before)
    state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
    state.taskSettings.destination = { revision: 1, settings: {}, application: 'applied' }
    const conflict = structuredClone(state)
    expect(
      bindChannelLogicalContinuation(state, event, 'profile', 'source', 'destination', {
        providerId: 'new',
        model: 'model',
      }),
    ).toBe(false)
    expect(state).toEqual(conflict)
  })
})
