import { waitForAbort } from './host-lifecycle.js'

/** Reattach only after the prior renderer was conclusively retired. */
export async function runOwnerConnectionLoop<T>(input: {
  readonly initial: T
  readonly initialWatcher: Promise<void>
  readonly signal: AbortSignal
  readonly isReady: () => boolean
  readonly isDisconnected: (value: T) => boolean
  readonly cleanupConfirmed: () => boolean
  readonly start: (value: T) => Promise<void>
  readonly reconnect?: (signal: AbortSignal) => Promise<{ readonly value: T; close(): Promise<void> }>
  readonly report: (event: 'disconnected' | 'cleanup-uncertain' | 'reconnect-failed') => void
}): Promise<void> {
  let current = input.initial
  let watcher = input.initialWatcher
  let session: { readonly value: T; close(): Promise<void> } | undefined
  try {
    while (true) {
      try {
        await watcher
      } catch (error) {
        if (!input.isDisconnected(current) || input.signal.aborted || !input.isReady()) throw error
        if (!input.cleanupConfirmed()) {
          input.report('cleanup-uncertain')
          await waitForAbort(input.signal)
          return
        }
      }
      if (!input.isDisconnected(current) || input.signal.aborted || !input.isReady()) return
      await session?.close()
      session = undefined
      input.report('disconnected')
      if (!input.reconnect) {
        await waitForAbort(input.signal)
        return
      }
      try {
        session = await input.reconnect(input.signal)
      } catch {
        if (input.signal.aborted) return
        input.report('reconnect-failed')
        await waitForAbort(input.signal)
        return
      }
      if (input.signal.aborted) return
      current = session.value
      watcher = input.start(current)
    }
  } finally {
    await session?.close()
  }
}
