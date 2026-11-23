import { expect, it, vi } from 'vitest'
import { recordChannelDispatchFailure } from '../packages/cli/src/launcher/channel-dispatch-diagnostic.js'
import type { ChannelConversationState } from '../packages/cli/src/launcher/channel-conversation-store.js'
it('preserves safe memory diagnostics and fences uncertain work without automatic replay', async () => {
  const state = { jobs: { job: { state: 'dispatching' } } } as unknown as ChannelConversationState
  const report = vi.fn()
  await recordChannelDispatchFailure(
    { mutate: async change => change(state) },
    'job',
    Error('MEMORY_UNSAFE_ROOT'),
    report,
  )
  expect(state.jobs.job).toMatchObject({ state: 'reconciliation-required', code: 'MEMORY_UNSAFE_ROOT' })
  expect(report).toHaveBeenCalledExactlyOnceWith('MEMORY_UNSAFE_ROOT')
})
it('does not expose paths, secrets or raw exceptions in generic dispatch diagnostics', async () => {
  const state = { jobs: { job: { state: 'dispatching' } } } as unknown as ChannelConversationState
  const report = vi.fn()
  await recordChannelDispatchFailure(
    { mutate: async change => change(state) },
    'job',
    Error('/private/synthetic/path'),
    report,
  )
  expect(state.jobs.job).toMatchObject({ state: 'reconciliation-required', code: 'NATIVE_EFFECT_UNCERTAIN' })
  expect(report).not.toHaveBeenCalled()
})
