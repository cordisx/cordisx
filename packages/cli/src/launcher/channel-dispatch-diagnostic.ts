import type { ChannelConversationStore } from './channel-conversation-store.js'

/** Keep uncertain dispatches fenced while preserving a safe, actionable failure code. */
export async function recordChannelDispatchFailure(
  store: Pick<ChannelConversationStore, 'mutate'>,
  jobId: string,
  error: unknown,
  report?: (code: string) => void,
) {
  const code = error instanceof Error && /^MEMORY_[A-Z_]+$/u.test(error.message) ? error.message : undefined
  await store.mutate(state => {
    const current = state.jobs[jobId]
    if (current?.state === 'dispatching') {
      current.state = 'reconciliation-required'
      current.code = code ?? 'NATIVE_EFFECT_UNCERTAIN'
      current.failureNotice ??= 'pending'
    } else if (current?.state === 'running') current.code = 'NATIVE_READBACK_UNAVAILABLE'
  })
  if (code) report?.(code)
}
