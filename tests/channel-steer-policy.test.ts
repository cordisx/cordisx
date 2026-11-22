import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  channelSteerParent,
  claimChannelSteer,
  reconcileChannelJob,
} from '../packages/cli/src/launcher/channel-conversation-steer.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import {
  type ChannelConversationState,
  ChannelConversationStore,
} from '../packages/cli/src/launcher/channel-conversation-store.js'
import { sameChannelPrincipal } from '../packages/cli/src/launcher/channel-source-principal.js'

function fixture() {
  const event = {
    adapterId: 'feishu',
    accountId: 'bot',
    tenantId: 'tenant',
    conversationId: 'group',
    kind: 'group',
    threadId: 'topic',
    semantics: 'topic',
    actor: { userId: 'alice' },
  }
  const state = {
    policy: parseChannelConversationPolicy({ enabled: true }),
    continuations: {},
    liveTakeovers: {},
    inputs: Object.fromEntries(
      ['parent', 'first', 'second'].map((
        id,
        i,
      ) => [id, {
        accepted: true,
        routed: true,
        sequence: i + 1,
        input: { source: { event: structuredClone(event) } },
      }]),
    ),
    jobs: {
      parent: {
        id: 'parent',
        recordId: 'parent',
        bindingId: 'binding',
        sessionId: 'session',
        state: 'running',
        turnId: 'turn',
      },
      first: { id: 'first', recordId: 'first', bindingId: 'binding', sessionId: 'session', state: 'queued' },
      second: { id: 'second', recordId: 'second', bindingId: 'binding', sessionId: 'session', state: 'queued' },
    },
    bindings: { binding: { state: 'active', mode: 'deliver', sessionId: 'session' } },
  } as unknown as ChannelConversationState
  return { state, event }
}
it('claims multiple same-sender supplements in order and never resubmits a claimed job', () => {
  const { state } = fixture()
  expect(claimChannelSteer(state, 'second')).toBeUndefined()
  expect(claimChannelSteer(state, 'first')?.id).toBe('parent')
  expect(claimChannelSteer(state, 'first')).toBeUndefined()
  expect(claimChannelSteer(state, 'second')).toBeUndefined()
  state.jobs.first!.state = 'running'
  expect(claimChannelSteer(state, 'second')?.id).toBe('parent')
  expect(state.jobs.second).toMatchObject({ steeredInto: 'turn', steerParent: 'parent', finalDeliveryEnabled: false })
})
it('keeps a crashed steer reservation uncertain after reopening instead of submitting it again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-steer-recovery-'))
  try {
    const file = path.join(root, 'store.json'), store = await ChannelConversationStore.open(file)
    await store.mutate(state => {
      state.jobs.pending = {
        id: 'pending',
        recordId: 'record',
        autoCreate: false,
        state: 'dispatching',
        sessionId: 'session',
        turnId: 'turn',
        steeredInto: 'turn',
        steerParent: 'parent',
        finalDeliveryEnabled: false,
      }
    })
    const recovered = await ChannelConversationStore.open(file)
    const steerObserved = vi.fn(async () => false), steer = vi.fn(), reconcile = vi.fn()
    const job = recovered.snapshot().jobs.pending!
    expect(job.state).toBe('reconciliation-required')
    await reconcileChannelJob(recovered, { steerObserved, steer, reconcile } as never, job, {} as never, 'test')
    await reconcileChannelJob(recovered, { steerObserved, steer, reconcile } as never, job, {} as never, 'test')
    expect(steerObserved).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(recovered.snapshot().jobs.pending?.state).toBe('reconciliation-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('retains wake/dispatch, sender, topic, and takeover boundaries', () => {
  for (
    const field of ['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind', 'threadId', 'semantics'] as const
  ) {
    const { state, event } = fixture()
    Object.assign(state.inputs.first!.input.source.event, { [field]: 'other' })
    expect(sameChannelPrincipal(event as never, state.inputs.first!.input.source.event)).toBe(false)
    expect(channelSteerParent(state, 'first')).toBeUndefined()
  }
  for (
    const change of [
      (s: ChannelConversationState) => {
        s.inputs.first!.accepted = false
      },
      (s: ChannelConversationState) => {
        s.inputs.first!.routed = false
      },
      (s: ChannelConversationState) => {
        s.policy.enabled = false
      },
      (s: ChannelConversationState) => {
        s.inputs.first!.input.source.event.actor = { userId: 'bob' } as never
      },
      (s: ChannelConversationState) => {
        s.liveTakeovers.session = { state: 'preparing' } as never
      },
      (s: ChannelConversationState) => {
        s.jobs.parent!.state = 'reconciliation-required'
      },
      (s: ChannelConversationState) => {
        s.jobs.first!.steerRejectedTurn = 'turn'
      },
      (s: ChannelConversationState) => {
        s.bindings.binding!.state = 'archived'
      },
    ]
  ) {
    const { state } = fixture()
    change(state)
    expect(channelSteerParent(state, 'first')).toBeUndefined()
  }
})
