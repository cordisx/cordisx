import { describe, expect, it, vi } from 'vitest'
import { a, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { channelGroupPriorityCommand } from '../packages/cli/src/launcher/channel-group-priority.js'
import { attemptChannelGroupPriority } from '../packages/cli/src/launcher/channel-group-priority-attempt.js'

async function setup() {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  await store.bindCommitBarrier(async () => {})
  const group = channel('synthetic-group', 'group')
  const admin = message('admin', 'command', group).source.event
  const first = message('first', 'synthetic first', group).source.event
  const second = message('second', 'synthetic second', group).source.event
  first.actor!.userId = 'member-one'
  second.actor!.userId = 'member-two'
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        {
          id: 'admin',
          action: 'command',
          effect: 'allow',
          userIds: ['alice'],
          commands: ['allow-user', 'continue-provider'],
        },
      ],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [
        { id: 'models', effect: 'allow', fields: ['providerId', 'model'], kinds: ['group'], userIds: ['alice'] },
      ],
    })
    state.modelPriority = {
      revision: 1,
      candidates: [
        { providerId: 'same', model: 'current' },
        { providerId: 'same', model: 'fallback' },
        { providerId: 'same', model: 'last' },
        { providerId: 'other', model: 'cross' },
      ],
    }
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
    for (const [i, event] of [first, second].entries()) {
      const id = `r${i}`, job = `j${i}`
      const source = message(event.eventId, `synthetic ${id}`, group)
      state.inputs[id] = {
        recordId: id,
        input: { ...source, source: { ...source.source, event } },
        accepted: true,
        routed: true,
        persisted: true,
        mentionedBot: true,
        sequence: i + 1,
      } as never
      state.jobs[job] = { id: job, recordId: id, bindingId: 'b', autoCreate: false, state: 'queued', sessionId: a }
    }
  })
  let selection = { providerId: 'same', model: 'current', effort: 'low', fast: false }
  const native = {
    taskSelection: vi.fn(async () => ({ ...selection })),
    idle: vi.fn(async () => true),
    modelOperation: vi.fn(async () => ({
      providers: [{
        providerId: 'same',
        models: ['current', 'fallback', 'last']
          .map(id => ({ id, reasoningCapabilities: { efforts: ['low'] } })),
      }],
    })),
    validateTaskConfiguration: vi.fn(async () => {}),
    priorityEvidence: vi.fn(async (candidate: { model: string }) =>
      candidate.model === 'current' ? 'unavailable' : 'healthy'
    ),
    applyTaskSelection: vi.fn(async (_session, value, guard) => {
      if (!await guard({})) return { status: 'rejected' }
      selection = value
      return { status: 'selected', application: 'applied' }
    }),
  }
  const offers = new Map(), claims = new Set<string>()
  const command = (parts: string[], event = admin) =>
    channelGroupPriorityCommand({
      store,
      native: native as never,
      appId: 'codex',
      profileId: 'fixture',
      event,
      parts,
      idlePriorityOffers: offers,
    })
  const run = (id = 'j0', event = first) =>
    attemptChannelGroupPriority({
      store,
      native: native as never,
      claims,
      appId: 'codex',
      profileId: 'fixture',
      event,
      job: store.snapshot().jobs[id]!,
      signal: new AbortController().signal,
    })
  return { ...f, businessNative: f.native, store, native, group, admin, first, second, command, run }
}
async function enable(f: Awaited<ReturnType<typeof setup>>) {
  const disclosure = await f.command(['group-auto-suggest', 'same', 'current'])
  expect(disclosure).toContain('same / fallback、same / last')
  expect(disclosure).not.toContain('other / cross')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  expect(await f.command(['group-auto', 'same', 'current', `--confirm=${token}`])).toContain('已授权')
}

describe('group priority, same provider', () => {
  it('requires a scoped administrator and an explicit disclosed group authorization', async () => {
    const f = await setup()
    expect(await f.command(['group-auto-suggest', 'same', 'current'], f.first)).toContain('没有群管理权限')
    expect(await f.run()).toBe(false)
    await enable(f)
    expect(f.store.snapshot().logicalContinuations?.idlePriorityGrants?.b?.groupScope).toBe(true)
  })
  it('keeps a healthy or inconclusive source without any selection', async () => {
    const f = await setup()
    await f.store.mutate(state => {
      state.modelPriority = {
        ...state.modelPriority,
        candidates: [
          { providerId: 'same', model: 'earlier' },
          ...state.modelPriority.candidates,
        ],
      }
    })
    await enable(f)
    f.native.priorityEvidence.mockResolvedValueOnce('healthy')
    expect(await f.run()).toBe(false)
    f.native.priorityEvidence.mockResolvedValueOnce('inconclusive')
    expect(await f.run()).toBe(false)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
  })
  it('selects an authorized same-provider target once and preserves both group senders and order', async () => {
    const f = await setup()
    await enable(f)
    expect(await f.run('j1', f.second)).toBe(true)
    expect(f.native.priorityEvidence).not.toHaveBeenCalled()
    expect(await f.run()).toBe(true)
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    const state = f.store.snapshot()
    expect(state.bindings.b!.sessionId).toBe(a)
    expect(state.jobs.j0).toMatchObject({ state: 'queued', sessionId: a })
    expect(state.jobs.j1).toMatchObject({ state: 'queued', sessionId: a })
    expect(state.logicalContinuations?.idlePriorityGrants?.b).toMatchObject({
      selection: { providerId: 'same', model: 'fallback' },
      target: { providerId: 'same', model: 'last' },
    })
  })
  it('does not bypass a group member explicit deny', async () => {
    const f = await setup()
    await enable(f)
    await f.store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({
        permissions: [
          { id: 'allow', effect: 'allow', fields: ['providerId', 'model'], kinds: ['group'] },
          { id: 'deny', effect: 'deny', userIds: ['member-two'], models: [{ providerId: 'same', model: 'fallback' }] },
        ],
      })
    })
    expect(await f.run()).toBe(false)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
  })
  it('does not bypass an explicit sender continuation denial', async () => {
    const f = await setup()
    await enable(f)
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        enabled: true,
        rules: [
          {
            id: 'admin',
            action: 'command',
            effect: 'allow',
            userIds: ['alice'],
            commands: ['allow-user', 'continue-provider'],
          },
          {
            id: 'deny-member',
            action: 'command',
            effect: 'deny',
            userIds: ['member-two'],
            commands: ['continue-provider'],
          },
        ],
      })
    })
    expect(await f.run()).toBe(false)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
  })
  it('does not switch a session previously bound to another conversation', async () => {
    const f = await setup()
    await enable(f)
    await f.store.mutate(state => {
      state.bindings.foreign = {
        ...state.bindings.b!,
        id: 'foreign',
        channel: channel('other-group', 'group'),
        state: 'archived',
      }
    })
    expect(await f.run()).toBe(false)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
  })
  it('retains reconciliation and never repeats an uncertain native selection', async () => {
    const f = await setup()
    await enable(f)
    f.native.applyTaskSelection.mockRejectedValueOnce(new Error('synthetic lost response'))
    expect(await f.run()).toBe(true)
    expect(f.store.snapshot().jobs.j0).toMatchObject({
      state: 'reconciliation-required',
      code: 'GROUP_PRIORITY_EFFECT_UNCERTAIN',
      failureNotice: 'pending',
    })
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
  })
  it('tries later disclosed models after a failed target probe', async () => {
    const f = await setup()
    await enable(f)
    f.native.priorityEvidence.mockImplementation(async candidate =>
      candidate.model === 'last' ? 'healthy' : 'unavailable'
    )
    expect(await f.run()).toBe(true)
    expect(f.native.priorityEvidence.mock.calls.map(([candidate]) => candidate.model))
      .toEqual(['current', 'fallback', 'last'])
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    expect(f.store.snapshot().jobs.j0).toMatchObject({ state: 'queued', sessionId: a })
  })
  it('halts if the rule is revoked during the target probe', async () => {
    const f = await setup()
    await enable(f)
    f.native.priorityEvidence.mockImplementation(async candidate => {
      if (candidate.model === 'fallback') await f.command(['group-auto-off'])
      return candidate.model === 'current' ? 'unavailable' : 'healthy'
    })
    expect(await f.run()).toBe(true)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
    expect(f.store.snapshot().jobs.j0!.state).toBe('queued')
  })
  it('prevents concurrent group inputs from selecting twice', async () => {
    const f = await setup()
    await enable(f)
    expect(await Promise.all([f.run(), f.run()])).toEqual([true, true])
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
  })
  it('rechecks group authority at the native effect boundary', async () => {
    const f = await setup()
    await enable(f)
    let admitted = true
    f.native.applyTaskSelection.mockImplementationOnce(async (_id, _target, guard) => {
      await f.store.mutate(state => {
        state.policyRevision += 1
      })
      admitted = await guard({})
      return { status: 'rejected' } as never
    })
    await f.run()
    expect(admitted).toBe(false)
    expect(f.store.snapshot().jobs.j0).toMatchObject({ state: 'reconciliation-required', failureNotice: 'pending' })
  })
  it('does not override an explicitly changed model', async () => {
    const f = await setup()
    await enable(f)
    f.native.taskSelection.mockResolvedValue({ providerId: 'same', model: 'explicit', effort: 'low', fast: false })
    expect(await f.run()).toBe(false)
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
    expect(f.store.snapshot().logicalContinuations?.idlePriorityGrants).toBeUndefined()
  })
  it('keeps an uncertain selection fenced after reopening', async () => {
    const f = await setup()
    await enable(f)
    f.native.applyTaskSelection.mockRejectedValueOnce(new Error('synthetic lost response'))
    await f.run()
    await f.consumer.dispose()
    const reopened = await fixture(f.file)
    const state = reopened.consumer.profileLogicalOwner().store.snapshot()
    expect(state.jobs.j0).toMatchObject({ state: 'reconciliation-required', code: 'GROUP_PRIORITY_EFFECT_UNCERTAIN' })
    expect(state.logicalContinuations?.idlePriorityGrants?.b?.groupScope).toBe(true)
  })
  it('restores a failure notice if interrupted immediately after reservation', async () => {
    const f = await setup()
    await enable(f)
    await f.store.mutate(state => {
      state.jobs.j0!.state = 'reconciliation-required'
      state.jobs.j0!.code = 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
    })
    await f.consumer.dispose()
    const reopened = await fixture(f.file)
    expect(reopened.consumer.profileLogicalOwner().store.snapshot().jobs.j0)
      .toMatchObject({ state: 'reconciliation-required', failureNotice: 'pending' })
  })
  it('dispatches two group inputs only once after the selection is confirmed', async () => {
    const f = await setup()
    await enable(f)
    f.consumer.setNativeExtras(() => ({ ...f.native, contextObservations: () => undefined }) as never)
    for (let i = 0; i < 6; i++) await settle(f.consumer)
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    expect(f.businessNative.start).toHaveBeenCalledTimes(2)
    expect(f.businessNative.start.mock.calls.map(call => call[1].source.event.eventId)).toEqual(['first', 'second'])
    expect(f.store.snapshot().bindings.b!.sessionId).toBe(a)
  })
})
