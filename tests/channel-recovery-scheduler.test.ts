import { expect, it } from 'vitest'
import { ChannelRecoveryScheduler } from '../packages/cli/src/launcher/channel-recovery-scheduler.js'
import { a, b, channel, fixture, message } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

it('does not block other jobs or start the same pending recovery twice', async () => {
  const scheduler = new ChannelRecoveryScheduler()
  let finish!: (value: boolean) => void, attempts = 0
  const slow = new Promise<boolean>(resolve => {
    finish = resolve
  })
  const recover = () => {
    attempts++
    return slow
  }
  try {
    expect(await scheduler.run('one', recover)).toBe(true)
    expect(await scheduler.run('two', async () => false)).toBe(false)
    expect(await scheduler.run('one', recover)).toBe(true)
    expect(attempts).toBe(1)
    finish(true)
    await slow
    expect(await scheduler.run('one', recover)).toBe(true)
    expect(attempts).toBe(1)
  } finally {
    finish(true)
    await scheduler.close()
  }
})

it('keeps the real Channel job pump available to another conversation during a slow recovery', async () => {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  let finish!: (value: undefined) => void
  const slow = new Promise<undefined>(resolve => {
    finish = resolve
  })
  const native = Object.assign(f.native, {
    providerRecovery: { target: async (id: string) => id === a ? await slow : undefined },
    supportsCrossProviderFork: async () => true,
  })
  f.consumer.setNativeExtras(() => native as never)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({ enabled: true })
    for (const [index, sessionId] of [a, b].entries()) {
      const ref = channel(`oc_${index}`), input = message(`message-${index}`, 'fixture', ref), id = `r${index}`
      state.bindings[id] = {
        id,
        channel: ref,
        sessionId,
        hostId: 'local',
        profileId: 'fixture',
        createdAt: '',
        fromSequence: 0,
        mode: 'deliver',
        autoReply: false,
        state: 'active',
      }
      state.inputs[id] = {
        recordId: id,
        input,
        sequence: index + 1,
        accepted: true,
        routed: true,
        persisted: true,
        mentionedBot: false,
      }
      state.jobs[id] = { id, recordId: id, bindingId: id, sessionId, autoCreate: false, state: 'queued' }
    }
  })
  try {
    await f.consumer.pump()
    expect(f.native.start).toHaveBeenCalledTimes(1)
    expect(f.native.start.mock.calls[0]?.[2]).toBe(b)
    expect(store.snapshot().jobs.r0?.state).toBe('queued')
  } finally {
    finish(undefined)
  }
})
