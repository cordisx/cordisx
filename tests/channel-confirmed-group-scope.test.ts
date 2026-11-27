import { expect, it } from 'vitest'
import { a, channel, fixture, message } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { confirmedGroupRecoveryScope } from '../packages/cli/src/launcher/channel-confirmed-group-scope.js'

it('limits recovery to a single group, verified administrators, and permitted queued members', async () => {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  const group = channel('oc_group', 'group')
  const admin = message('admin', 'admin input', group)
  const member = message('member', 'member input', group)
  member.source.event.actor!.userId = 'member'
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [{ id: 'admin', action: 'command', effect: 'allow', userIds: ['alice'] }],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [{ id: 'models', effect: 'allow', fields: ['providerId', 'model'], userIds: ['alice'] }],
    })
    state.bindings.b = {
      id: 'b',
      channel: group,
      sessionId: a,
      hostId: 'local',
      profileId: 'fixture',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
    for (const [index, input] of [admin, member].entries()) {
      const recordId = `r${index}`
      state.inputs[recordId] = {
        recordId,
        input,
        accepted: true,
        routed: true,
        persisted: true,
        mentionedBot: true,
        sequence: index + 1,
      }
      state.jobs[`j${index}`] = {
        id: `j${index}`,
        recordId,
        bindingId: 'b',
        autoCreate: false,
        state: 'queued',
        sessionId: a,
      }
    }
  })
  const target = { providerId: 'target', model: 'model' }, source = { providerId: 'source', model: 'model' }
  const check = (state: ReturnType<typeof store.snapshot>, event = admin.source.event, job = 'j0') =>
    confirmedGroupRecoveryScope(state, event, 'fixture', a, state.jobs[job]!, target, source)
  const state = store.snapshot()
  expect(check(state)?.actor?.userId).toBe('alice')
  expect(check(state, member.source.event, 'j1')).toBeUndefined()
  const approved = structuredClone(state)
  approved.taskRequests.previous = {
    threadId: a,
    state: 'applied',
    selection: target,
    approvedBy: admin.source.event,
  } as never
  expect(check(approved, member.source.event, 'j1')?.actor?.userId).toBe('alice')
  expect(check(approved, member.source.event, 'j0')).toBeUndefined()
  const crossGroup = structuredClone(state)
  crossGroup.inputs.r1!.input.source.event.conversationId = 'oc_other'
  expect(check(crossGroup)).toBeUndefined()
  const forged = structuredClone(state)
  forged.inputs.r1!.input.source.event.actor!.tenantId = 'other'
  expect(check(forged)).toBeUndefined()
  const denied = structuredClone(state)
  denied.policy.rules.push({ id: 'deny', action: 'command', effect: 'deny', userIds: ['member'], commands: ['model'] })
  expect(check(denied)).toBeUndefined()
  const multiple = structuredClone(state)
  multiple.bindings.extra = { ...multiple.bindings.b!, id: 'extra' }
  expect(check(multiple)).toBeUndefined()
  const uncertain = structuredClone(state)
  uncertain.jobs.j1!.state = 'reconciliation-required'
  expect(check(uncertain)).toBeUndefined()
})
