import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelFeedback } from '../packages/cli/src/launcher/channel-feedback.js'
import {
  parseChannelFeedbackSettings,
  readChannelFeedbackSettings,
} from '../packages/cli/src/launcher/channel-feedback-settings.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const roots: string[] = [], cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const source = (accountId = 'app', conversationId = 'oc_chat'): ChannelEventRef => ({
  adapterId: 'feishu',
  accountId,
  tenantId: 'tenant',
  conversationId,
  kind: 'group',
  threadId: conversationId,
  semantics: 'conversation',
  eventId: 'om_input',
  messageId: 'om_input',
  actor: { adapterId: 'feishu', accountId, tenantId: 'tenant', userId: 'ou_user' },
})
const message = (event = source(), text = 'please work'): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  source: { kind: 'channel', event },
  content: [{ type: 'text', text }],
  receivedAt: new Date().toISOString(),
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-feedback-'))
  roots.push(root)
  const store = await ChannelConversationStore.open(path.join(root, 'store.json'))
  const event = source(), input = message(event)
  await store.mutate(state => {
    state.policy = { ...state.policy, enabled: true, groupReception: 'all' }
    state.inputs.record = {
      recordId: 'record',
      input,
      mentionedBot: true,
      sequence: 1,
      persisted: true,
      accepted: true,
      routed: true,
    }
    state.jobs.job = {
      id: 'job',
      recordId: 'record',
      autoCreate: true,
      state: 'running',
      sessionId: 'session',
      turnId: 'turn',
    }
  })
  const observers = new Set<(target: ChannelEventRef) => void>()
  const runtime = {
    observeOutbound: (listener: (target: ChannelEventRef) => void) => {
      observers.add(listener)
      return () => observers.delete(listener)
    },
  }
  const access = {
    generation: 'one',
    runtime,
    feedbackReact: vi.fn(async () => {}),
    feedbackWait: vi.fn(async () => {}),
  } as unknown as ChannelConversationAccess
  const turnState = vi.fn(async () => 'active')
  const feedback = new ChannelFeedback({
    store,
    access: () => access,
    turnState,
    settings: async () => parseChannelFeedbackSettings({ wait: { delaySeconds: 1, texts: ['one', 'two'] } }),
    signal: new AbortController().signal,
    randomIndex: () => 1,
  })
  cleanup.push(() => store.close(), () => feedback.dispose())
  return { root, store, feedback, access, observers, event, turnState }
}
it('acknowledges a routed task despite slow reaction, picks a configured wait text once and retains replay fencing', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  vi.mocked(f.access.feedbackReact!).mockImplementation(() => new Promise(() => {}))
  await f.feedback.routed('record')
  await f.feedback.routed('record')
  expect(f.access.feedbackReact).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.access.feedbackWait).toHaveBeenCalledTimes(1))
  expect(vi.mocked(f.access.feedbackWait!).mock.calls[0]?.[2]).toBe('two')
  await f.feedback.routed('record')
  await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(f.access.feedbackWait).toHaveBeenCalledTimes(1))
  expect(JSON.parse(await readFile(path.join(f.root, 'store.json'), 'utf8')).inputs.record.feedback.waitAttempted).toBe(
    true,
  )
})
it.each(['completed', 'unknown', 'cancelled', 'generation', 'reply'] as const)(
  'suppresses stale waiting feedback after %s',
  async reason => {
    vi.useFakeTimers()
    const f = await fixture()
    await f.feedback.routed('record')
    if (reason === 'completed' || reason === 'unknown') f.turnState.mockResolvedValue(reason)
    if (reason === 'cancelled') {
      await f.store.mutate(state => {
        state.jobs.job!.state = 'cancelled'
      })
    }
    if (reason === 'generation') Object.assign(f.access, { generation: 'two' })
    if (reason === 'reply') { for (const listener of f.observers) listener(f.event) }
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.access.feedbackWait).not.toHaveBeenCalled()
  },
)
it('isolates reply cancellation by account and preserves another concurrent input in a different conversation', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const other = source('other-app', 'oc_other')
  await f.store.mutate(state => {
    state.inputs.other = { ...state.inputs.record!, recordId: 'other', input: message(other) }
    state.jobs.other = {
      ...state.jobs.job!,
      id: 'other',
      recordId: 'other',
      sessionId: 'other-session',
      turnId: 'other-turn',
    }
  })
  await f.feedback.routed('record')
  await f.feedback.routed('other')
  for (const listener of f.observers) listener({ ...f.event, accountId: 'wrong-account' })
  for (const listener of f.observers) listener(f.event)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.access.feedbackWait).toHaveBeenCalledTimes(1))
  expect(vi.mocked(f.access.feedbackWait!).mock.calls[0]?.[0].accountId).toBe('other-app')
})
it('uses legacy single text and profile overrides, rejects malformed config and honors independent off switches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-feedback-config-'))
  roots.push(root)
  const profile = path.join(root, 'profile')
  await (await import('node:fs/promises')).mkdir(profile)
  await writeFile(path.join(root, 'channel-feedback.json'), JSON.stringify({ wait: { text: 'legacy' } }))
  expect((await readChannelFeedbackSettings(profile, root)).wait.text).toBe('legacy')
  await writeFile(
    path.join(profile, 'channel-feedback.json'),
    JSON.stringify({ reaction: { enabled: false }, wait: { enabled: false } }),
  )
  expect(await readChannelFeedbackSettings(profile, root)).toMatchObject({
    reaction: { enabled: false },
    wait: { enabled: false },
  })
  for (const value of [{ wait: { texts: [] } }, { wait: { delaySeconds: -1 } }, { reaction: { emojiType: 42 } }]) {
    expect(() => parseChannelFeedbackSettings(value)).toThrow()
  }
})
it('the real consumer routes only awakened non-command messages and keeps dispatch independent of reaction failures', async () => {
  vi.useFakeTimers()
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-feedback-route-'))
  roots.push(root)
  const access = {
    generation: 'route',
    accounts: () => [{ ref: source(), state: 'ready' }],
    conversations: async () => ({ complete: true, conversations: [] }),
    runtime: {
      inputsSince: async () => ({ cursor: 'channel-input:0:empty', messages: [] }),
      observeOutbound: () => () => {},
    },
    feedbackReact: vi.fn(async () => {
      throw Error('reaction failed')
    }),
    feedbackWait: vi.fn(async () => {}),
  } as unknown as ChannelConversationAccess
  const start = vi.fn(async () => ({ state: 'running' as const, sessionId: 'session', turnId: 'turn' }))
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'test',
    access: () => access,
    native: () => ({
      start,
      exists: async () => true,
      completion: async () => ({ state: 'running' }),
      reconcile: async () => ({ state: 'running', sessionId: 'session', turnId: 'turn' }),
    }),
  })
  cleanup.push(() => consumer.dispose())
  await consumer.policySet({ ...consumer.policy().policy, enabled: true, groupReception: 'all' }, 0)
  await consumer.receive('unaddressed', message(source(), 'group chatter'), false)
  await consumer.pump()
  expect(start).not.toHaveBeenCalled()
  expect(access.feedbackReact).not.toHaveBeenCalled()
  await consumer.receive('addressed', message({ ...source(), messageId: 'om_task', eventId: 'om_task' }), true)
  await consumer.pump()
  expect(start).toHaveBeenCalledOnce()
  expect(access.feedbackReact).toHaveBeenCalledOnce()
})
