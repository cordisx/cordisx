import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelSentDelivery } from '@cordisx/channel-runtime'
import { ChannelProgressReminders } from '../packages/cli/src/launcher/channel-progress-reminders.js'
import { channelProgressNative } from '../packages/cli/src/launcher/channel-progress-native.js'
import { outboundCallerScope } from '../packages/cli/src/launcher/channel-outbound-rpc.js'
import { parseChannelFeedbackSettings } from '../packages/cli/src/launcher/channel-feedback-settings.js'
import { ChannelFeedback } from '../packages/cli/src/launcher/channel-feedback.js'

const disposals: (() => void)[] = []
afterEach(() => {
  for (const fn of disposals.splice(0)) fn()
  vi.useRealTimers()
})
const event = (id = 'm1', conversationId = 'chat', accountId = 'fixture'): ChannelEventRef => ({
  adapterId: 'feishu',
  accountId,
  tenantId: 'fixture',
  conversationId,
  threadId: conversationId,
  kind: 'group',
  semantics: 'conversation',
  eventId: id,
  messageId: id,
  actor: { adapterId: 'feishu', accountId, tenantId: 'fixture', userId: 'user' },
})
function fixture(ackTimeoutSeconds = 60) {
  vi.useFakeTimers()
  const state: any = {
    policy: { enabled: true, rules: [], wakePrefixes: [] },
    inputs: {},
    jobs: {},
    bindings: {},
    liveTakeovers: {},
    continuations: {},
  }
  const listeners = new Set<(delivery: ChannelSentDelivery) => void>()
  const runtime = {
    observeSentDelivery: (fn: (delivery: ChannelSentDelivery) => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
  const access: any = { generation: 'g1', runtime }
  const remind = vi.fn(async () => 'accepted' as const), turn = vi.fn(async () => 'active')
  const report = vi.fn()
  const reminders = new ChannelProgressReminders({
    store: { snapshot: () => structuredClone(state) },
    access: () => access,
    settings: async () =>
      parseChannelFeedbackSettings({ wait: { mode: 'agent', quietSeconds: 5, repeatSeconds: 10, ackTimeoutSeconds } }),
    turnState: turn,
    remind,
    report,
    signal: new AbortController().signal,
  })
  disposals.push(() => reminders.dispose())
  const add = async (id: string, ref = event(id), sessionId = 's', turnId = 't') => {
    state.inputs[id] = {
      recordId: id,
      sequence: Object.keys(state.inputs).length + 1,
      accepted: true,
      mentionedBot: true,
      input: { source: { event: ref }, content: [{ type: 'text', text: 'task' }] },
    }
    state.jobs[id] = { id, recordId: id, state: 'running', sessionId, turnId }
    reminders.inputReceived(id, ref)
    await reminders.accepted(id)
  }
  const sent = (
    ref: ChannelEventRef,
    createdAt = new Date().toISOString(),
    source = ref,
    session = 's',
    turnId = 't',
  ) => {
    for (const listener of listeners) {
      listener({
        target: ref,
        createdAt,
        sentAt: new Date().toISOString(),
        deliveryId: 'delivery:test',
        caller: {
          source: 'cordisx:native-channel',
          pluginId: 'host-channel-tools',
          generation: outboundCallerScope({ source, session, turnId }),
        },
      })
    }
  }
  return { state, remind, turn, reminders, add, sent, listeners, access, report }
}
describe('active Channel progress reminders', () => {
  it('debounces six inputs to the last one, then repeats only while no confirmed message is sent', async () => {
    const f = fixture()
    for (let i = 1; i <= 6; i++) {
      await f.add('m' + i)
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(3999)
    expect(f.remind).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.remind).toHaveBeenCalledOnce()
    expect(f.remind.mock.calls[0]![0]).toMatchObject({ source: event('m6'), reminder: 1, sessionId: 's', turnId: 't' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.remind).toHaveBeenCalledTimes(2)
    f.sent(event('m6'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.remind).toHaveBeenCalledTimes(2)
  })
  it('reports missing cooperative input acknowledgment without claiming consumption or interrupting work', async () => {
    const f = fixture()
    await f.add('m1')
    expect(f.reminders.inputStatus(event(), 's', false)).toMatchObject({
      acknowledgment: 'awaiting-agent',
      consumption: 'unconfirmed',
      overdue: false,
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.report).toHaveBeenCalledWith('CHANNEL_INPUT_ACK_OVERDUE')
    expect(f.reminders.inputStatus(event(), 's', false)).toMatchObject({ overdue: true, consumption: 'unconfirmed' })
    expect(f.reminders.inputStatus(event('old'), 's', true)).toMatchObject({ acknowledgment: 'not-monitored' })
    expect(f.reminders.inputStatus(event(), 's', true)).toMatchObject({
      acknowledgment: 'agent-acknowledged',
      consumption: 'acknowledged-by-caller',
      overdue: false,
    })
    await f.add('m2')
    expect(f.reminders.inputStatus(event('m2'), 's', false)).toMatchObject({
      acknowledgment: 'awaiting-agent',
      consumption: 'unconfirmed',
    })
    f.sent(event('m2'))
    expect(f.reminders.inputStatus(event('m2'), 's', false)).toMatchObject({ acknowledgment: 'not-monitored' })
  })
  it('allows disabling acknowledgment diagnostics and cancels obsolete/acknowledged timers', async () => {
    const disabled = fixture(0)
    await disabled.add('m1')
    await vi.advanceTimersByTimeAsync(60000)
    expect(disabled.report).not.toHaveBeenCalled()
    const f = fixture(10)
    await f.add('m1')
    await vi.advanceTimersByTimeAsync(9000)
    await f.add('m2')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.report).not.toHaveBeenCalled()
    f.reminders.inputStatus(event('m2'), 's', true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.report).not.toHaveBeenCalled()
    expect(() => parseChannelFeedbackSettings({ wait: { ackTimeoutSeconds: -1 } })).toThrow()
    expect(() => parseChannelFeedbackSettings({ wait: { ackTimeoutSeconds: 1.5 } })).toThrow()
  })
  it('invalidates a pending reminder immediately on a new input, even before the new input is routed', async () => {
    const f = fixture()
    await f.add('m1')
    await vi.advanceTimersByTimeAsync(5000)
    const token = f.remind.mock.calls[0]![0].token
    expect(() => f.reminders.assertCurrent(token, event(), 's')).not.toThrow()
    f.reminders.inputReceived('m2', event('m2'))
    expect(() => f.reminders.assertCurrent(token, event(), 's')).toThrow('STALE')
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.remind).toHaveBeenCalledOnce()
    await f.add('m2')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.remind).toHaveBeenCalledTimes(2)
  })
  it('does not reset timers for ambient group chatter, denied input or human reactions', async () => {
    const f = fixture()
    const spy = vi.spyOn(f.reminders, 'inputReceived')
    const feedback = new ChannelFeedback({
      store: { snapshot: () => structuredClone(f.state), mutate: async run => run(f.state) },
      access: () => f.access,
      settings: async () => parseChannelFeedbackSettings({}),
      turnState: f.turn,
      signal: new AbortController().signal,
      progress: f.reminders,
    })
    disposals.push(() => feedback.dispose())
    await f.add('m1')
    spy.mockClear()
    f.state.inputs.ambient = { ...f.state.inputs.m1, recordId: 'ambient', mentionedBot: false }
    feedback.inputReceived('ambient', event('ambient'))
    feedback.inputReceived('m1', { ...event(), eventId: 'reaction:synthetic' })
    expect(spy).not.toHaveBeenCalled()
    f.state.policy.rules = [{ action: 'dispatch', effect: 'deny' }]
    feedback.inputReceived('m1', event())
    expect(spy).not.toHaveBeenCalled()
  })
  it('does not cancel for old send requests, another task, account or topic', async () => {
    const f = fixture()
    await f.add('m1')
    f.sent(event(), new Date(Date.now() - 1).toISOString())
    f.sent(event(), new Date().toISOString(), event(), 'other-task')
    f.sent(event('m1', 'chat', 'other'))
    f.sent({ ...event(), semantics: 'topic', threadId: 'other-topic' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.remind).toHaveBeenCalledOnce()
    // Any actual send from the correlated shared turn after the latest input cancels it.
    f.sent(event())
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.remind).toHaveBeenCalledOnce()
  })
  it.each(['completed', 'failed', 'unknown', 'generation', 'mixed-sender', 'migration'])(
    'fails closed for %s',
    async status => {
      const f = fixture()
      await f.add('m1')
      if (['completed', 'failed', 'unknown'].includes(status)) f.turn.mockResolvedValue(status)
      if (status === 'generation') f.access.generation = 'g2'
      if (status === 'mixed-sender') f.state.inputs.m1.input.source.event.actor.userId = 'other'
      if (status === 'migration') f.state.liveTakeovers.s = { state: 'unknown' }
      await vi.advanceTimersByTimeAsync(30000)
      expect(f.remind).not.toHaveBeenCalled()
    },
  )
  it('does not retry an uncertain native steer until new user input resets the request', async () => {
    const f = fixture()
    f.remind.mockResolvedValue('unknown' as never)
    await f.add('m1')
    await vi.advanceTimersByTimeAsync(35000)
    expect(f.remind).toHaveBeenCalledOnce()
    await f.add('m2')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.remind).toHaveBeenCalledTimes(2)
  })
  it('isolates simultaneous conversations and preserves legacy config mode', async () => {
    const f = fixture()
    await f.add('m1')
    await f.add('other', event('other', 'other'), 's2', 't2')
    f.sent(event())
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.remind).toHaveBeenCalledOnce()
    expect(f.remind.mock.calls[0]![0].sessionId).toBe('s2')
    expect(parseChannelFeedbackSettings({}).wait).toMatchObject({
      mode: 'agent',
      quietSeconds: 5,
      repeatSeconds: 30,
      finishSeconds: 10,
    })
    expect(parseChannelFeedbackSettings({ wait: { text: 'legacy' } }).wait.mode).toBe('fixed')
    expect(parseChannelFeedbackSettings({ wait: { mode: 'agent', texts: ['legacy'] } }).wait.mode).toBe('agent')
    for (const wait of [{ mode: 'invalid' }, { quietSeconds: 0 }, { repeatSeconds: -1 }]) {
      expect(() => parseChannelFeedbackSettings({ wait })).toThrow()
    }
  })
})
it('native reminder targets the existing expected turn and labels its input as a Host notice', async () => {
  const request = vi.fn(async () => ({ turnId: 't' }))
  const notice = { source: event(), sessionId: 's', turnId: 't', token: 'notice-token', finishSeconds: 10, reminder: 1 }
  const input = {
    notice,
    cli: { node: '/node', entry: '/cli.js', home: '/home', profile: 'default' },
    source: event(),
    context: 'real-context',
    current: () => true,
    request,
  }
  expect(await channelProgressNative(input)).toBe('accepted')
  expect(request.mock.calls[0]).toMatchObject(['turn/steer', { threadId: 's', expectedTurnId: 't' }])
  const prompt = (request.mock.calls[0]![1] as any).input[0].text
  expect(prompt).toContain('not a new user message')
  expect(prompt).toContain('progressToken:"notice-token"')
  expect(prompt).toContain('--context')
  expect(await channelProgressNative({ ...input, current: () => false })).toBe('rejected')
  expect(request).toHaveBeenCalledOnce()
})
