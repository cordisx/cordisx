import { expect, it, vi } from 'vitest'
import { a, channel, fixture, message } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { recoverConfirmedChannelProvider } from '../packages/cli/src/launcher/channel-confirmed-provider-recovery.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { ChannelNativeProviderRecovery } from '../packages/cli/src/launcher/channel-native-provider-recovery.js'

async function setup() {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  const ref = channel(), input = message('input', 'hello', ref)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [{ id: 'commands', action: 'command', effect: 'allow', userIds: ['alice'] }],
    })
    state.bindings.b = {
      id: 'b',
      channel: ref,
      sessionId: a,
      hostId: 'local',
      profileId: 'fixture',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
    state.inputs.r = {
      recordId: 'r',
      input,
      accepted: true,
      routed: true,
      persisted: true,
      mentionedBot: false,
      sequence: 1,
    }
    state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: a }
  })
  const target = { providerId: 'fixture-provider', model: 'fixture-model' }
  const native = {
    supportsCrossProviderFork: vi.fn(async () => true),
    idle: vi.fn(async (_id: string, observed = false) => !observed),
    providerRecovery: {
      target: vi.fn(async () => target),
      probe: vi.fn(async () => ({ state: 'resumed' as const })),
    },
  }
  const fence = new ChannelNativeSourceFence(() => false)
  const report = vi.fn()
  const run = () =>
    recoverConfirmedChannelProvider({
      store,
      native: native as never,
      fence,
      claims: new Set(),
      appId: 'codex',
      profileId: 'fixture',
      access: () => f.access,
      event: input.source.event,
      job: store.snapshot().jobs.j!,
      report,
    })
  return { store, native, fence, run, report }
}

it('continues dispatch immediately when the confirmed provider resumes unchanged', async () => {
  const f = await setup()
  expect(await f.run()).toBe(false)
  expect(f.native.providerRecovery.probe).toHaveBeenCalledOnce()
  expect(f.store.snapshot().jobs.j?.state).toBe('queued')
  expect(f.fence.isMigrating(a)).toBe(false)
})

it('marks a recovery check failure as uncertain instead of silently retrying', async () => {
  const f = await setup()
  f.native.providerRecovery.target.mockRejectedValueOnce(new Error('temporary read failure'))
  // The first read is outside the recovery fence and its caller records the failure.
  await expect(f.run()).rejects.toThrow('temporary read failure')
  f.native.providerRecovery.target.mockResolvedValueOnce({ providerId: 'fixture-provider', model: 'fixture-model' })
    .mockRejectedValueOnce(new Error('temporary read failure'))
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().jobs.j).toMatchObject({
    state: 'reconciliation-required',
    code: 'CONFIRMED_PROVIDER_RECOVERY_UNCERTAIN',
    failureNotice: 'pending',
  })
  expect(f.report).toHaveBeenCalledWith('CHANNEL_PROVIDER_RECOVERY_TARGET_CHECK_ERROR')
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('temporary read failure')
  expect(f.fence.isMigrating(a)).toBe(false)
})

it('does not dispatch if the confirmed selection changes during resume', async () => {
  const f = await setup()
  f.native.providerRecovery.target.mockResolvedValueOnce({ providerId: 'fixture-provider', model: 'fixture-model' })
    .mockResolvedValueOnce({ providerId: 'fixture-provider', model: 'fixture-model' })
    .mockResolvedValueOnce({ providerId: 'other-provider', model: 'other-model' })
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
  expect(f.fence.isMigrating(a)).toBe(false)
})

it('does not use an unconfirmed source resume as a configuration observation', async () => {
  const accept = vi.fn(async (_value: unknown) => true)
  const native = new ChannelNativeProviderRecovery({
    nativeRequest: async () => ({ thread: { id: 'other' }, modelProvider: 'source', model: 'model' }),
    configuration: { captureObservation: () => accept },
  })
  const fence = new ChannelNativeSourceFence(() => false), release = fence.beginMigration('thread')!
  try {
    expect(await native.restore('thread', 'source', fence)).toBeUndefined()
    expect(accept).not.toHaveBeenCalled()
  } finally {
    release()
  }
})
