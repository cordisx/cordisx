import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelFeedback } from '../packages/cli/src/launcher/channel-feedback.js'
import { ChannelStoppedFeedback } from '../packages/cli/src/launcher/channel-feedback-stopped.js'
import { parseChannelFeedbackSettings } from '../packages/cli/src/launcher/channel-feedback-settings.js'

const dispose: (() => void)[] = []
afterEach(() => {
  for (const run of dispose.splice(0)) run()
})

function fixture() {
  const event = {
    adapterId: 'feishu',
    accountId: 'account-a',
    tenantId: 'tenant',
    conversationId: 'chat-a',
    kind: 'direct',
    semantics: 'conversation',
    threadId: 'chat-a',
    eventId: 'message-a',
    messageId: 'message-a',
  }
  const state: any = {
    policy: { enabled: true, rules: [{ action: 'dispatch', effect: 'allow' }, { action: 'send', effect: 'allow' }] },
    inputs: {
      record: {
        recordId: 'record',
        accepted: true,
        input: { source: { event } },
        feedback: { reaction: { reactionId: 'processing', emojiType: 'OnIt' } },
      },
    },
    jobs: { job: { id: 'job', recordId: 'record', state: 'running', sessionId: 's', turnId: 't' } },
    liveTakeovers: {},
    continuations: {},
    bindings: {},
  }
  const calls: string[] = []
  const react = vi.fn(async (_event: any, emoji: string) => {
    calls.push('add:' + emoji)
    return { reactionId: 'done', emojiType: emoji }
  })
  const remove = vi.fn(async (_event: any, id: string) => {
    calls.push('remove:' + id)
    return { reactionId: id, removed: true }
  })
  const access: any = { generation: 'generation-a', feedbackReact: react, feedbackRemove: remove }
  let turnState = 'active'
  const stopped = new ChannelStoppedFeedback({
    store: { snapshot: () => structuredClone(state), mutate: async (run: any) => run(state) },
    access: () => access,
    turnState: async () => turnState,
    signal: new AbortController().signal,
  })
  dispose.push(() => stopped.dispose())
  return {
    state,
    event,
    calls,
    react,
    remove,
    access,
    stopped,
    setTurn: (value: string) => {
      turnState = value
    },
  }
}

describe('stopped-turn feedback', () => {
  it('keeps processing while active or unknown, then adds DONE before removing the owned processing reaction', async () => {
    const f = fixture()
    f.stopped.accepted('record', 'generation-a', 'DONE')
    await f.stopped.check('record')
    f.setTurn('unknown')
    await f.stopped.check('record')
    expect(f.calls).toEqual([])
    f.setTurn('completed')
    await f.stopped.check('record')
    await f.stopped.check('record')
    expect(f.calls).toEqual(['add:DONE', 'remove:processing'])
    expect(f.react).toHaveBeenCalledWith(f.event, 'DONE')
    expect(f.state.inputs.record.feedback.completion.emojiType).toBe('DONE')
  })

  it.each(['failed', 'interrupted'] as const)(
    'marks an explicitly stopped %s turn but not a queued or uncertain job',
    async status => {
      const f = fixture()
      f.stopped.accepted('record', 'generation-a', 'DONE')
      f.setTurn(status === 'interrupted' ? 'failed' : status)
      for (const jobState of ['queued', 'dispatching', 'reconciliation-required']) {
        f.state.jobs.job.state = jobState
        await f.stopped.check('record')
      }
      expect(f.calls).toEqual([])
      f.state.jobs.job.state = 'failed'
      await f.stopped.check('record')
      expect(f.calls).toEqual(['add:DONE', 'remove:processing'])
    },
  )

  it('does not update historical inputs, other accounts, or an uncertain takeover', async () => {
    const f = fixture()
    f.setTurn('completed')
    await f.stopped.check('record')
    expect(f.calls).toEqual([])
    f.stopped.accepted('record', 'generation-a', 'DONE')
    f.access.generation = 'other-generation'
    await f.stopped.check('record')
    expect(f.calls).toEqual([])
    f.access.generation = 'generation-a'
    f.state.liveTakeovers.s = { state: 'unknown' }
    await f.stopped.check('record')
    expect(f.calls).toEqual([])
    delete f.state.liveTakeovers.s
    await f.stopped.check('record')
    expect(f.remove).toHaveBeenCalledWith(f.event, 'processing')
  })

  it('does not remove OnIt or repeat an uncertain DONE request', async () => {
    const f = fixture()
    f.stopped.accepted('record', 'generation-a', 'DONE')
    f.setTurn('completed')
    f.react.mockRejectedValueOnce(new Error('unknown receipt'))
    await expect(f.stopped.check('record')).rejects.toThrow()
    await f.stopped.check('record')
    expect(f.react).toHaveBeenCalledTimes(1)
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('retires a late OnIt receipt after DONE and does not repeat an uncertain removal', async () => {
    const f = fixture()
    delete f.state.inputs.record.feedback.reaction
    f.stopped.accepted('record', 'generation-a', 'DONE')
    f.setTurn('completed')
    await f.stopped.check('record')
    f.state.inputs.record.feedback.reaction = { reactionId: 'late', emojiType: 'OnIt' }
    f.remove.mockRejectedValueOnce(new Error('unknown receipt'))
    await f.stopped.retire('record')
    await f.stopped.retire('record')
    expect(f.react).toHaveBeenCalledTimes(1)
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('uses an already-owned identical DONE emoji without adding or removing it', async () => {
    const f = fixture()
    f.state.inputs.record.feedback.reaction.emojiType = 'DONE'
    f.stopped.accepted('record', 'generation-a', 'DONE')
    f.setTurn('completed')
    await f.stopped.check('record')
    expect(f.react).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('marks each steered input only after its shared turn ends and isolates a different account', async () => {
    const f = fixture()
    const second = { ...f.event, messageId: 'message-b', eventId: 'message-b' }
    const other = { ...f.event, accountId: 'account-b', conversationId: 'chat-b', messageId: 'message-c' }
    f.state.inputs.second = {
      recordId: 'second',
      input: { source: { event: second } },
      feedback: { reaction: { reactionId: 'processing-b', emojiType: 'OnIt' } },
    }
    f.state.jobs.second = { id: 'second', recordId: 'second', state: 'running', sessionId: 's', turnId: 't' }
    f.state.inputs.other = {
      recordId: 'other',
      input: { source: { event: other } },
      feedback: { reaction: { reactionId: 'processing-c', emojiType: 'OnIt' } },
    }
    f.state.jobs.other = { id: 'other', recordId: 'other', state: 'queued', sessionId: 'other' }
    f.react.mockImplementation(async (event: any, emoji: string) => {
      f.calls.push('add:' + event.messageId + ':' + emoji)
      return { reactionId: 'done-' + event.messageId, emojiType: emoji }
    })
    for (const id of ['record', 'second', 'other']) f.stopped.accepted(id, 'generation-a', 'DONE')
    await Promise.all(['record', 'second', 'other'].map(id => f.stopped.check(id)))
    expect(f.calls).toEqual([])
    f.setTurn('completed')
    await Promise.all(['record', 'second', 'other'].map(id => f.stopped.check(id)))
    expect(f.react).toHaveBeenCalledTimes(2)
    expect(f.react).toHaveBeenCalledWith(f.event, 'DONE')
    expect(f.react).toHaveBeenCalledWith(second, 'DONE')
    expect(f.remove).toHaveBeenCalledWith(f.event, 'processing')
    expect(f.remove).toHaveBeenCalledWith(second, 'processing-b')
    expect(f.react).not.toHaveBeenCalledWith(other, 'DONE')
  })

  it('rechecks job identity and permissions after an asynchronous native read', async () => {
    const f = fixture()
    let resolve!: (value: string) => void
    const pending = new Promise<string>(done => {
      resolve = done
    })
    const stopped = new ChannelStoppedFeedback({
      store: { snapshot: () => structuredClone(f.state), mutate: async (run: any) => run(f.state) },
      access: () => f.access,
      turnState: async () => pending,
      signal: new AbortController().signal,
    })
    dispose.push(() => stopped.dispose())
    stopped.accepted('record', 'generation-a', 'DONE')
    const check = stopped.check('record')
    f.state.jobs.job.state = 'reconciliation-required'
    resolve('completed')
    await check
    expect(f.calls).toEqual([])
  })
  it('requires all correlated native turns stopped and preserves explicit send denials', async () => {
    const f = fixture()
    f.state.jobs.second = { id: 'second', recordId: 'record', state: 'running', sessionId: 's2', turnId: 't2' }
    let second = 'active'
    const stopped = new ChannelStoppedFeedback({
      store: { snapshot: () => structuredClone(f.state), mutate: async (run: any) => run(f.state) },
      access: () => f.access,
      turnState: async session => session === 's2' ? second : 'completed',
      signal: new AbortController().signal,
    })
    dispose.push(() => stopped.dispose())
    stopped.accepted('record', 'generation-a', 'DONE')
    await stopped.check('record')
    expect(f.calls).toEqual([])
    second = 'failed'
    f.state.policy.rules.push({ action: 'send', effect: 'deny' })
    await stopped.check('record')
    expect(f.calls).toEqual([])
    f.state.policy.rules.pop()
    await stopped.check('record')
    expect(f.calls).toEqual(['add:DONE', 'remove:processing'])
  })

  it('defaults to DONE and validates independent stop configuration', () => {
    expect(parseChannelFeedbackSettings({}).reaction).toMatchObject({ stoppedEnabled: true, stoppedEmojiType: 'DONE' })
    expect(parseChannelFeedbackSettings({ reaction: { enabled: false } }).reaction.stoppedEnabled).toBe(false)
    expect(parseChannelFeedbackSettings({ reaction: { completionEmojiType: 'OK' } }).reaction.stoppedEnabled).toBe(
      false,
    )
    expect(parseChannelFeedbackSettings({ reaction: { stoppedEnabled: true, stoppedEmojiType: 'OK' } }).reaction)
      .toMatchObject({ stoppedEnabled: true, stoppedEmojiType: 'OK' })
    expect(() => parseChannelFeedbackSettings({ reaction: { stoppedEnabled: 'yes' } })).toThrow()
    expect(() => parseChannelFeedbackSettings({ reaction: { stoppedEmojiType: 'bad emoji' } })).toThrow()
  })
  it('does not re-add an uncertain DONE when accepted is notified twice', async () => {
    const f = fixture()
    f.stopped.accepted('record', 'generation-a', 'DONE')
    f.setTurn('completed')
    f.react.mockRejectedValueOnce(new Error('unknown receipt'))
    await expect(f.stopped.check('record')).rejects.toThrow()
    f.stopped.accepted('record', 'generation-a', 'DONE')
    await f.stopped.check('record')
    expect(f.react).toHaveBeenCalledTimes(1)
  })
})

it.each(['direct', 'group grant'])('wires %s inputs through Get, OnIt, and stopped feedback', async mode => {
  const f = fixture()
  if (mode === 'group grant') {
    Object.assign(f.event, {
      kind: 'group',
      actor: { adapterId: 'feishu', accountId: 'account-a', tenantId: 'tenant', userId: 'member' },
    })
    f.state.inputs.record.mentionedBot = true
    f.state.inputs.record.sequence = 3
    f.state.policy.rules = [
      { action: 'dispatch', effect: 'allow', userIds: ['admin'] },
      { action: 'send', effect: 'allow' },
    ]
    f.state.groupTaskAccess = [{
      adapterId: 'feishu',
      accountId: 'account-a',
      tenantId: 'tenant',
      conversationId: 'chat-a',
      fromSequence: 2,
    }]
  }
  delete f.state.inputs.record.feedback
  f.access.runtime = { observeOutbound: () => () => {} }
  const feedback = new ChannelFeedback({
    store: { snapshot: () => structuredClone(f.state), mutate: async (run: any) => run(f.state) },
    access: () => f.access,
    turnState: async () => f.state.jobs.job.state === 'completed' ? 'completed' : 'active',
    settings: async () =>
      parseChannelFeedbackSettings({ reaction: { stoppedEnabled: true }, wait: { enabled: false } }),
    signal: new AbortController().signal,
  })
  dispose.push(() => feedback.dispose())
  f.react.mockImplementation(async (_event: any, emoji: string) => {
    f.calls.push('add:' + emoji)
    return { reactionId: emoji, emojiType: emoji }
  })
  await feedback.routed('record')
  await vi.waitFor(() => expect(f.state.inputs.record.feedback.receivedReaction?.reactionId).toBe('Get'))
  await feedback.started('record')
  await vi.waitFor(() => expect(f.state.inputs.record.feedback.reaction?.reactionId).toBe('OnIt'))
  await vi.waitFor(() => expect(f.calls).toContain('remove:Get'))
  f.state.jobs.job.state = 'completed'
  feedback.jobUpdated('record')
  await vi.waitFor(() => expect(f.calls).toContain('remove:OnIt'))
  expect(f.calls).toEqual(['add:Get', 'add:OnIt', 'remove:Get', 'add:DONE', 'remove:OnIt'])
})

it.each(['confirmed removal', 'unknown Get removal'])(
  'retires late OnIt after DONE with %s',
  async outcome => {
    const f = fixture()
    delete f.state.inputs.record.feedback
    f.access.runtime = { observeOutbound: () => () => {} }
    let resolveGet!: (value: { reactionId: string; emojiType: string }) => void
    let resolveOnIt!: (value: { reactionId: string; emojiType: string }) => void
    const get = new Promise<{ reactionId: string; emojiType: string }>(done => {
      resolveGet = done
    })
    const onIt = new Promise<{ reactionId: string; emojiType: string }>(done => {
      resolveOnIt = done
    })
    if (outcome === 'unknown Get removal') {
      f.remove.mockImplementation(async (_event: any, id: string) => {
        f.calls.push('remove:' + id)
        if (id === 'Get') throw new Error('unknown removal')
        return { reactionId: id, removed: true }
      })
    }
    f.react.mockImplementation(async (_event: any, emoji: string) => {
      f.calls.push('add:' + emoji)
      if (emoji === 'Get') return get
      if (emoji === 'OnIt') return onIt
      return { reactionId: 'done', emojiType: emoji }
    })
    const feedback = new ChannelFeedback({
      store: { snapshot: () => structuredClone(f.state), mutate: async (run: any) => run(f.state) },
      access: () => f.access,
      turnState: async () => f.state.jobs.job.state === 'completed' ? 'completed' : 'active',
      settings: async () =>
        parseChannelFeedbackSettings({ reaction: { stoppedEnabled: true }, wait: { enabled: false } }),
      signal: new AbortController().signal,
    })
    dispose.push(() => feedback.dispose())
    await feedback.routed('record')
    await feedback.started('record')
    f.state.jobs.job.state = 'completed'
    feedback.jobUpdated('record')
    await vi.waitFor(() => expect(f.calls).toContain('add:DONE'))
    resolveGet({ reactionId: 'Get', emojiType: 'Get' })
    resolveOnIt({ reactionId: 'OnIt', emojiType: 'OnIt' })
    await vi.waitFor(() => expect(f.calls).toContain('remove:Get'))
    await vi.waitFor(() => expect(f.calls).toContain('remove:OnIt'))
    expect(f.calls.filter(value => value === 'remove:Get')).toHaveLength(1)
    expect(f.calls.filter(value => value === 'remove:OnIt')).toHaveLength(1)
  },
)

it('enabling stopped feedback does not sweep already stored messages or replay them after restart', async () => {
  const f = fixture()
  f.access.runtime = { observeOutbound: () => () => {} }
  f.state.jobs.job.state = 'completed'
  const feedback = new ChannelFeedback({
    store: { snapshot: () => structuredClone(f.state), mutate: async (run: any) => run(f.state) },
    access: () => f.access,
    turnState: async () => 'completed',
    settings: async () =>
      parseChannelFeedbackSettings({ reaction: { stoppedEnabled: true, completionEmojiType: 'OK' } }),
    signal: new AbortController().signal,
  })
  dispose.push(() => feedback.dispose())
  await feedback.catchup()
  feedback.jobUpdated('record')
  await feedback.completed('record')
  expect(f.calls).toEqual([])
})
