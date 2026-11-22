import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelFeedback } from '../packages/cli/src/launcher/channel-feedback.js'
import { parseChannelFeedbackSettings } from '../packages/cli/src/launcher/channel-feedback-settings.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import type { ChannelConversationState } from '../packages/cli/src/launcher/channel-conversation-store.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const event = (accountId = 'account-a', messageId = 'message-a'): ChannelEventRef => ({
  adapterId: 'feishu',
  accountId,
  tenantId: 'tenant',
  conversationId: `chat-${accountId}`,
  threadId: `chat-${accountId}`,
  kind: 'group',
  semantics: 'conversation',
  eventId: messageId,
  messageId,
  actor: { adapterId: 'feishu', accountId, tenantId: 'tenant', userId: 'human' },
})
const input = (ref = event()): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  source: { kind: 'channel', event: ref },
  content: [{ type: 'text', text: 'synthetic task' }],
  receivedAt: new Date().toISOString(),
})
function fixture(settings: unknown = {}) {
  const state = {
    policy: { enabled: true, groupReception: 'all', rules: [] },
    inputs: {},
    jobs: {},
    bindings: {},
    liveTakeovers: {},
  } as unknown as ChannelConversationState
  const store = {
    snapshot: () => structuredClone(state),
    mutate: async <T>(change: (value: ChannelConversationState) => T) => change(state),
  }
  const access = {
    generation: 'one',
    runtime: { observeOutbound: () => () => {} },
    feedbackReact: vi.fn(async (ref: ChannelEventRef, emojiType: string) => ({
      reactionId: `${ref.accountId}-${emojiType}`,
      emojiType,
    })),
    feedbackRemove: vi.fn(async (_ref: ChannelEventRef, reactionId: string) => ({ reactionId, removed: true })),
  } as unknown as ChannelConversationAccess
  const create = () =>
    new ChannelFeedback({
      store,
      access: () => access,
      turnState: async () => 'active',
      settings: async () => parseChannelFeedbackSettings(settings),
      signal: new AbortController().signal,
    })
  const feedback = create()
  cleanup.push(() => feedback.dispose())
  function add(id = 'a', ref = event()) {
    state.inputs[id] = {
      recordId: id,
      input: input(ref),
      mentionedBot: true,
      sequence: 1,
      persisted: true,
      accepted: true,
      routed: true,
    }
    state.jobs[id] = { id, recordId: id, autoCreate: true, state: 'queued' }
  }
  function running(id = 'a') {
    Object.assign(state.jobs[id]!, { state: 'running', sessionId: `session-${id}`, turnId: `turn-${id}` })
  }
  return { state, access, feedback, create, add, running }
}
it('Get precedes confirmed processing; queued work and duplicate notifications do not add OnIt', async () => {
  const f = fixture({ wait: { enabled: false } })
  f.add()
  await f.feedback.routed('a')
  await f.feedback.started('a')
  expect(f.access.feedbackReact).toHaveBeenCalledExactlyOnceWith(event(), 'Get')
  f.running()
  await Promise.all([f.feedback.started('a'), f.feedback.started('a')])
  await vi.waitFor(() => expect(f.access.feedbackRemove).toHaveBeenCalledExactlyOnceWith(event(), 'account-a-Get'))
  expect(vi.mocked(f.access.feedbackReact!).mock.calls.map(call => call[1])).toEqual(['Get', 'OnIt'])
  await f.feedback.routed('a')
  await f.feedback.started('a')
  expect(f.access.feedbackReact).toHaveBeenCalledTimes(2)
})
it('slow receipt never blocks processing and its late owned Get is removed exactly once', async () => {
  const f = fixture({ wait: { enabled: false } })
  f.add()
  let release!: (value: { reactionId: string; emojiType: string }) => void
  vi.mocked(f.access.feedbackReact!).mockImplementation(async (_ref, emojiType) =>
    emojiType === 'Get'
      ? new Promise(resolve => {
        release = resolve
      })
      : { reactionId: 'processing', emojiType }
  )
  await f.feedback.routed('a')
  f.running()
  await f.feedback.started('a')
  expect(f.access.feedbackReact).toHaveBeenCalledTimes(2)
  expect(f.access.feedbackRemove).not.toHaveBeenCalled()
  release({ reactionId: 'received', emojiType: 'Get' })
  await vi.waitFor(() => expect(f.access.feedbackRemove).toHaveBeenCalledExactlyOnceWith(event(), 'received'))
})
it.each(['Get', 'OnIt'])('failure in %s does not delete the other phase or block native processing', async failed => {
  const f = fixture({ wait: { enabled: false } })
  f.add()
  vi.mocked(f.access.feedbackReact!).mockImplementation(async (_ref, emojiType) => {
    if (emojiType === failed) throw Error('synthetic failure')
    return { reactionId: emojiType, emojiType }
  })
  await f.feedback.routed('a')
  f.running()
  await f.feedback.started('a')
  await vi.waitFor(() => expect(f.access.feedbackReact).toHaveBeenCalledTimes(2))
  expect(f.access.feedbackRemove).not.toHaveBeenCalled()
})
it('restart and changed account generation never remove an unowned persisted receipt', async () => {
  const f = fixture({ wait: { enabled: false } })
  f.add()
  await f.feedback.routed('a')
  await vi.waitFor(() => expect(f.state.inputs.a!.feedback?.receivedReaction).toBeDefined())
  f.feedback.dispose()
  Object.assign(f.access, { generation: 'two' })
  const recovered = f.create()
  cleanup.push(() => recovered.dispose())
  f.running()
  await recovered.started('a')
  await vi.waitFor(() => expect(f.state.inputs.a!.feedback?.reaction).toBeDefined())
  await recovered.received('a')
  await recovered.started('a')
  expect(f.access.feedbackRemove).not.toHaveBeenCalled()
  expect(f.access.feedbackReact).toHaveBeenCalledTimes(2)
})
it('separate accounts keep their source messages and receipts isolated', async () => {
  const f = fixture({ wait: { enabled: false } })
  f.add('a', event('a', 'one'))
  f.add('b', event('b', 'two'))
  await Promise.all([f.feedback.routed('a'), f.feedback.routed('b')])
  f.running('a')
  await f.feedback.started('a')
  await vi.waitFor(() => expect(f.access.feedbackRemove).toHaveBeenCalledExactlyOnceWith(event('a', 'one'), 'a-Get'))
  expect(vi.mocked(f.access.feedbackReact!).mock.calls.filter(call => call[0].accountId === 'b').map(call => call[1]))
    .toEqual(['Get'])
})
it.each([
  [{ receivedEnabled: false }, ['OnIt']],
  [{ processingEnabled: false }, ['Get']],
  [{ enabled: false, processingEnabled: true }, ['OnIt']],
  [{ receivedEmojiType: 'OK', emojiType: 'Pencil' }, ['OK', 'Pencil']],
  [{ emojiType: 'Get' }, ['Get']],
])('supports independent configuration and matching emojis: %j', async (reaction, expected) => {
  const f = fixture({ reaction, wait: { enabled: false } })
  f.add()
  await f.feedback.routed('a')
  f.running()
  await f.feedback.started('a')
  await vi.waitFor(() => expect(f.access.feedbackReact).toHaveBeenCalledTimes(expected.length))
  expect(vi.mocked(f.access.feedbackReact!).mock.calls.map(call => call[1])).toEqual(expected)
  if (expected.length === 1) expect(f.access.feedbackRemove).not.toHaveBeenCalled()
})
it('late Get is retired after fast completion without duplicating completion feedback', async () => {
  const f = fixture({ reaction: { completionEmojiType: 'OK' }, wait: { enabled: false } })
  f.add()
  let release!: (value: { reactionId: string; emojiType: string }) => void
  vi.mocked(f.access.feedbackReact!).mockImplementation(async (_ref, emojiType) =>
    emojiType === 'Get'
      ? new Promise(resolve => {
        release = resolve
      })
      : { reactionId: emojiType, emojiType }
  )
  await f.feedback.routed('a')
  f.running()
  await f.feedback.started('a')
  await vi.waitFor(() => expect(f.state.inputs.a!.feedback?.reaction).toBeDefined())
  f.state.jobs.a!.state = 'completed'
  await f.feedback.completed('a')
  release({ reactionId: 'Get', emojiType: 'Get' })
  await vi.waitFor(() => expect(f.access.feedbackRemove).toHaveBeenCalledWith(event(), 'Get'))
  await f.feedback.catchup()
  expect(vi.mocked(f.access.feedbackReact!).mock.calls.map(call => call[1])).toEqual(['Get', 'OnIt', 'OK'])
})
it('rejects malformed stage settings while retaining legacy off behavior', () => {
  expect(parseChannelFeedbackSettings({ reaction: { enabled: false } }).reaction).toMatchObject({
    receivedEnabled: false,
    processingEnabled: false,
    receivedEmojiType: 'Get',
    emojiType: 'OnIt',
  })
  for (
    const reaction of [{ receivedEnabled: null }, { processingEnabled: 'yes' }, { receivedEmojiType: 'bad emoji' }]
  ) {
    expect(() => parseChannelFeedbackSettings({ reaction })).toThrow('INVALID_FEEDBACK_CONFIG')
  }
})
it('real consumer ignores unaddressed groups and acknowledges while native dispatch is pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'feedback-route-two-stage-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'channel-feedback.json'), JSON.stringify({ wait: { enabled: false } }))
  const f = fixture(),
    access = {
      ...f.access,
      accounts: () => [{ ref: event(), state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      runtime: { ...f.access.runtime, inputsSince: async () => ({ cursor: 'channel-input:0:empty', messages: [] }) },
    } as unknown as ChannelConversationAccess
  let release!: (result: { state: 'running'; sessionId: string; turnId: string }) => void
  const start = vi.fn(() =>
    new Promise(resolve => {
      release = resolve
    })
  )
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'test',
    access: () => access,
    native: () =>
      ({
        start,
        exists: async () => true,
        completion: async () => ({ state: 'running' }),
        reconcile: async () => ({ state: 'reconciliation-required' }),
      }) as never,
  })
  cleanup.push(() => consumer.dispose())
  await consumer.policySet({ ...consumer.policy().policy, enabled: true, groupReception: 'all' }, 0)
  await consumer.receive('chatter', input(), false)
  await consumer.pump()
  expect(start).not.toHaveBeenCalled()
  expect(access.feedbackReact).not.toHaveBeenCalled()
  await consumer.receive('task', input(event('account-a', 'task')), true)
  const pumping = consumer.pump()
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
  expect(vi.mocked(access.feedbackReact!).mock.calls.map(call => call[1])).toEqual(['Get'])
  release({ state: 'running', sessionId: 'session', turnId: 'turn' })
  await pumping
  await vi.waitFor(() => expect(access.feedbackRemove).toHaveBeenCalledOnce())
  expect(vi.mocked(access.feedbackReact!).mock.calls.map(call => call[1])).toEqual(['Get', 'OnIt'])
})
