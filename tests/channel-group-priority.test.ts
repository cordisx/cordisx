import { describe, expect, it, vi } from 'vitest'
import { a, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { channelGroupPriorityCommand } from '../packages/cli/src/launcher/channel-group-priority.js'
import { attemptChannelGroupPriority } from '../packages/cli/src/launcher/channel-group-priority-attempt.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import {
  channelLogicalHistoryAvailable,
  createChannelLogicalHistory,
} from '../packages/cli/src/launcher/channel-logical-history.js'
import { identity } from '../packages/cli/src/launcher/channel-conversation-refs.js'

async function setup() {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  await store.bindCommitBarrier(async () => {})
  const group = channel('oc_synthetic_group', 'group')
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
      }, { providerId: 'other', models: [{ id: 'cross', reasoningCapabilities: { efforts: ['low'] } }] }],
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
    continuationConfiguration: vi.fn(async () => ({
      providerId: 'same',
      model: 'current',
      cwd: '/workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
      sandbox: { type: 'readOnly' },
      permissionProfile: null,
    })),
    logicalMigrationLease: vi.fn(async () => ({
      state: 'acquired',
      destination: () => undefined,
      releaseSource: async () => true,
      nativeRequest: async () => ({}),
    })),
    createLogicalDestination: vi.fn(async (request: { source: object }) => ({
      state: 'created',
      confirmed: true,
      destination: { ...request.source, sessionId: 'destination' },
    })),
    logicalSourceVersion: vi.fn(async () => {
      throw new Error('NATIVE_HISTORY_MUST_NOT_BE_READ')
    }),
    logicalHistoryPage: vi.fn(async () => {
      throw new Error('NATIVE_HISTORY_MUST_NOT_BE_READ')
    }),
    sourceForLogicalTurn: vi.fn(async () => first),
    logicalTurnActive: vi.fn(async () => true),
  }
  const offers = new Map(), claims = new Set<string>(), fence = new ChannelNativeSourceFence(() => false)
  Object.assign(f.runtime, { confirmedGroupDeliveryText: vi.fn(() => undefined) })
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
      access: () => f.access,
      fence,
      claims,
      appId: 'codex',
      profileId: 'fixture',
      event,
      job: store.snapshot().jobs[id]!,
      signal: new AbortController().signal,
    })
  return { ...f, businessNative: f.native, store, native, group, admin, first, second, command, run, fence }
}
async function enable(f: Awaited<ReturnType<typeof setup>>) {
  const disclosure = await f.command(['group-auto-suggest', 'same', 'current'])
  expect(disclosure).toContain('same / fallback、same / last')
  expect(disclosure).not.toContain('other / cross')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  expect(await f.command(['group-auto', 'same', 'current', `--confirm=${token}`])).toContain('已授权')
}

async function enableLinked(f: Awaited<ReturnType<typeof setup>>) {
  const disclosure = await f.command(['group-linked-suggest', 'same', 'current'])
  expect(disclosure).toContain('other / cross')
  expect(disclosure).toContain('未记录')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  expect(await f.command(['group-linked', 'same', 'current', '--history=group-recorded', `--confirm=${token}`]))
    .toContain('已授权')
}

it('links a group across providers using only attributed inputs and confirmed group replies', async () => {
  const f = await setup()
  const old = message('old', 'SYNTHETIC_GROUP_HISTORY', f.group)
  const oldEvent = old.source.event
  const excluded = message('excluded', 'SYNTHETIC_EXPLICIT_DENY', f.group)
  excluded.source.event.actor!.userId = 'historical-denied'
  await f.store.mutate(state => {
    state.inputs.old = {
      recordId: 'old',
      input: old,
      accepted: true,
      routed: true,
      persisted: true,
      mentionedBot: true,
      sequence: 0,
    }
    state.jobs.old = {
      id: 'old-job',
      recordId: 'old',
      bindingId: 'b',
      autoCreate: false,
      state: 'completed',
      sessionId: a,
      turnId: 'old-turn',
      finalDeliveryEnabled: true,
    }
    state.inputs.foreign = {
      ...state.inputs.old!,
      recordId: 'foreign',
      input: message('foreign', 'SYNTHETIC_PRIVATE', channel('different', 'direct')),
    }
    state.jobs.foreign = { ...state.jobs.old!, id: 'foreign-job', recordId: 'foreign', bindingId: 'other' }
    state.inputs.excluded = { ...state.inputs.old!, recordId: 'excluded', input: excluded }
    state.jobs.excluded = { ...state.jobs.old!, id: 'excluded-job', recordId: 'excluded' }
    state.taskConfig = parseChannelTaskConfig({
      permissions: [
        { id: 'admin', effect: 'allow', fields: ['providerId', 'model'], userIds: ['alice'] },
        {
          id: 'deny-history',
          effect: 'deny',
          fields: ['providerId', 'model'],
          userIds: ['historical-denied'],
          models: [{ providerId: 'other', model: 'cross' }],
        },
      ],
    })
  })
  const receipt = vi.fn((id: string) =>
    id === `delivery:${identity(['old-job', oldEvent])}` ? 'SYNTHETIC_CONFIRMED_REPLY' : undefined
  )
  Object.assign(f.runtime, { confirmedGroupDeliveryText: receipt })
  await enableLinked(f)
  f.native.priorityEvidence.mockImplementation(async candidate =>
    candidate.model === 'cross' ? 'healthy' : 'unavailable'
  )
  expect(await f.run()).toBe(true)
  const state = f.store.snapshot()
  expect(state.bindings.b!.sessionId).toBe('destination')
  expect(state.jobs.j0).toMatchObject({ state: 'queued', sessionId: 'destination' })
  expect(state.jobs.j1).toMatchObject({ state: 'queued', sessionId: 'destination' })
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(f.native.logicalSourceVersion).not.toHaveBeenCalled()
  expect(receipt).not.toHaveBeenCalledWith(
    `delivery:${identity(['excluded-job', excluded.source.event])}`,
    expect.anything(),
    expect.anything(),
  )
  const handler = createChannelLogicalHistory({
    store: f.store,
    native: () => f.native as never,
    appId: 'codex',
    profileId: 'fixture',
  })
  expect(channelLogicalHistoryAvailable(state, f.first, 'destination')).toBe(true)
  const call = {
    threadId: 'destination',
    turnId: 'turn',
    callId: 'call',
    tool: 'cordisx_continuation_history',
    arguments: {},
  }
  const page = await handler(call)
  expect(page.success).toBe(true)
  expect(JSON.stringify(page)).toContain('SYNTHETIC_GROUP_HISTORY')
  expect(JSON.stringify(page)).toContain('SYNTHETIC_CONFIRMED_REPLY')
  expect(JSON.stringify(page)).not.toContain('SYNTHETIC_PRIVATE')
  expect(JSON.stringify(page)).not.toContain('SYNTHETIC_UNCONFIRMED')
  expect(JSON.stringify(page)).not.toContain('SYNTHETIC_EXPLICIT_DENY')
  expect(JSON.stringify(page)).not.toContain('SYNTHETIC_DENIED_REPLY')
  expect(JSON.parse(page.contentItems[0]!.text).omitted).toContain('unsupported')
  expect(f.native.logicalHistoryPage).not.toHaveBeenCalled()
  f.native.sourceForLogicalTurn.mockResolvedValue(f.second)
  expect((await handler(call)).success).toBe(true)
  f.native.sourceForLogicalTurn.mockResolvedValue({ ...f.second, conversationId: 'oc_other_group' })
  expect((await handler(call)).success).toBe(false)
  f.native.sourceForLogicalTurn.mockResolvedValue(f.first)
  const limited = await handler({ ...call, arguments: { limit: 1 } })
  const cursor = JSON.parse(limited.contentItems[0]!.text).nextCursor
  expect(typeof cursor).toBe('string')
  const next = await handler({ ...call, arguments: { cursor } })
  expect(next.success).toBe(true)
  await f.command(['group-auto-off'])
  expect((await handler(call)).success).toBe(false)
})

it('fences a created target when the group authorization is revoked during creation', async () => {
  const f = await setup()
  await enableLinked(f)
  f.native.priorityEvidence.mockImplementation(async candidate =>
    candidate.model === 'cross' ? 'healthy' : 'unavailable'
  )
  f.native.createLogicalDestination.mockImplementation(async request => {
    await f.command(['group-auto-off'])
    return { state: 'created', confirmed: true, destination: { ...request.source, sessionId: 'destination' } }
  })
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().bindings.b!.sessionId).toBe(a)
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(f.store.snapshot().jobs.j0!.state).toBe('reconciliation-required')
})

it('never repeats an unknown cross-provider destination creation', async () => {
  const f = await setup()
  await enableLinked(f)
  f.native.priorityEvidence.mockImplementation(async candidate =>
    candidate.model === 'cross' ? 'healthy' : 'unavailable'
  )
  f.native.createLogicalDestination.mockRejectedValueOnce(new Error('synthetic lost response'))
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().jobs.j0).toMatchObject({
    state: 'reconciliation-required',
    code: 'IDLE_PRIORITY_MIGRATION_UNCERTAIN',
  })
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  await f.run()
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
})

it('preserves the bounded group projection and authorization across restart', async () => {
  const f = await setup()
  const old = message('old', 'SYNTHETIC_RESTART_HISTORY', f.group)
  await f.store.mutate(state => {
    state.inputs.old = {
      recordId: 'old',
      input: old,
      accepted: true,
      routed: true,
      persisted: true,
      mentionedBot: true,
      sequence: 0,
    }
    state.jobs.old = {
      id: 'old-job',
      recordId: 'old',
      bindingId: 'b',
      autoCreate: false,
      state: 'completed',
      sessionId: a,
      turnId: 'old-turn',
    }
  })
  await enableLinked(f)
  f.native.priorityEvidence.mockImplementation(async candidate =>
    candidate.model === 'cross' ? 'healthy' : 'unavailable'
  )
  await f.run()
  await f.consumer.dispose()
  const reopened = await fixture(f.file)
  const store = reopened.consumer.profileLogicalOwner().store
  const handler = createChannelLogicalHistory({
    store,
    native: () => f.native as never,
    appId: 'codex',
    profileId: 'fixture',
  })
  const page = await handler({
    threadId: 'destination',
    turnId: 'turn',
    callId: 'call',
    tool: 'cordisx_continuation_history',
    arguments: {},
  })
  expect(page.success).toBe(true)
  expect(JSON.stringify(page)).toContain('SYNTHETIC_RESTART_HISTORY')
  expect(f.native.logicalHistoryPage).not.toHaveBeenCalled()
})

it.each(['healthy', 'inconclusive'] as const)('does not create a linked target when source is %s', async status => {
  const f = await setup()
  await enableLinked(f)
  f.native.priorityEvidence.mockResolvedValueOnce(status as never)
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  expect(f.store.snapshot().bindings.b!.sessionId).toBe(a)
})

it('fences a created target when group history changes before commit', async () => {
  const f = await setup()
  const old = message('old', 'SYNTHETIC_BEFORE', f.group)
  await f.store.mutate(state => {
    state.inputs.old = {
      recordId: 'old',
      input: old,
      accepted: true,
      routed: true,
      persisted: true,
      mentionedBot: true,
      sequence: 0,
    }
    state.jobs.old = {
      id: 'old-job',
      recordId: 'old',
      bindingId: 'b',
      autoCreate: false,
      state: 'completed',
      sessionId: a,
      turnId: 'old-turn',
    }
  })
  await enableLinked(f)
  f.native.priorityEvidence.mockImplementation(async candidate =>
    candidate.model === 'cross' ? 'healthy' : 'unavailable'
  )
  f.native.createLogicalDestination.mockImplementationOnce(async request => {
    await f.store.mutate(state => {
      const record = state.inputs.old!
      state.inputs.old = { ...record, input: message('old', 'SYNTHETIC_AFTER', f.group) }
    })
    return { state: 'created', confirmed: true, destination: { ...request.source, sessionId: 'destination' } }
  })
  await f.run()
  expect(f.store.snapshot().bindings.b!.sessionId).toBe(a)
  expect(f.store.snapshot().jobs.j0).toMatchObject({ state: 'reconciliation-required' })
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
})

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
  it('recognizes different reply threads in the same authenticated group', async () => {
    const f = await setup()
    const admin = { ...f.admin, threadId: 'admin-topic', semantics: 'topic' as const }
    const first = { ...f.first, threadId: 'reply-one', semantics: 'reply-chain' as const }
    const second = { ...f.second, threadId: 'reply-two', semantics: 'reply-chain' as const }
    await f.store.mutate(state => {
      for (const [id, event] of [['r0', first], ['r1', second]] as const) {
        const input = state.inputs[id]!.input
        state.inputs[id] = { ...state.inputs[id]!, input: { ...input, source: { ...input.source, event } } as never }
      }
    })
    const disclosure = await f.command(['group-auto-suggest', 'same', 'current'], admin)
    const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
    expect(token).toBeDefined()
    expect(await f.command(['group-auto', 'same', 'current', `--confirm=${token}`], admin)).toContain('已授权')
    expect(await f.run('j0', first)).toBe(true)
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
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
    expect(await f.run()).toBe(true)
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    expect(f.native.applyTaskSelection.mock.calls[0]![1]).toMatchObject({ providerId: 'same', model: 'last' })
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
  it('dispatches queued group messages once and in order after a linked migration', async () => {
    const f = await setup()
    await enableLinked(f)
    f.native.priorityEvidence.mockImplementation(async candidate =>
      candidate.model === 'cross' ? 'healthy' : 'unavailable'
    )
    f.consumer.setNativeExtras(() => ({ ...f.native, contextObservations: () => undefined }) as never)
    for (let i = 0; i < 8; i++) await settle(f.consumer)
    expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
    expect(f.businessNative.start).toHaveBeenCalledTimes(2)
    expect(f.businessNative.start.mock.calls.map(call => call[1].source.event.eventId)).toEqual(['first', 'second'])
    expect(f.store.snapshot().bindings.b!.sessionId).toBe('destination')
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
