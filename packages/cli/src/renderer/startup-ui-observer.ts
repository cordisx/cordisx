import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSubscriptionV1,
} from '@cordisx/protocol/startup/v1'
import type { StartupUIRequest } from '../launcher/startup-ui-rpc.js'

type Invoke = (request: StartupUIRequest, signal?: AbortSignal) => Promise<unknown>
const requestId = (): string => globalThis.crypto.randomUUID()

/** Public observer facade; retries observation only, never actions or preparation. */
export function createBrowserStartupObserver(invoke: Invoke) {
  const subscriptions = new Set<(reason: 'scope-revoked' | 'host-replaced') => void>()
  const reads = new Set<AbortController>()
  let terminated: 'scope-revoked' | 'host-replaced' | undefined
  const observer: StartupObserverV1 = {
    contract: 'cordisx.startup-observer/v1',
    async read(options) {
      if (terminated) throw new Error('startup observer is unavailable')
      const controller = new AbortController()
      const abort = () => controller.abort(options?.signal?.reason)
      if (options?.signal?.aborted) abort()
      else options?.signal?.addEventListener('abort', abort, { once: true })
      reads.add(controller)
      try {
        return await invoke({ requestId: requestId(), operation: 'startupRead' }, controller.signal) as Awaited<
          ReturnType<StartupObserverV1['read']>
        >
      } finally {
        reads.delete(controller)
        options?.signal?.removeEventListener('abort', abort)
      }
    },
    async subscribe(listener, options) {
      if (terminated || options?.signal?.aborted) throw new Error('startup observer is unavailable')
      const controller = new AbortController()
      let closed = false
      let cursor: StartupCursorV1 | undefined
      let subscriptionId: string | undefined
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let wakeRetry: (() => void) | undefined
      const cleanupRemote = (id: string | undefined): void => {
        if (id !== undefined) {
          void invoke({ requestId: requestId(), operation: 'startupClose', subscriptionId: id }).catch(() => undefined)
        }
      }
      const notify = (event: StartupEventV1): void => {
        // A plugin callback cannot break transport cleanup or ordered delivery.
        try {
          listener(event)
        } catch { /* plugin owns its callback error */ }
      }
      const finish = (reason: 'unsubscribed' | 'scope-revoked' | 'host-replaced'): void => {
        if (closed) return
        closed = true
        controller.abort()
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        wakeRetry?.()
        options?.signal?.removeEventListener('abort', abort)
        subscriptions.delete(terminate)
        cleanupRemote(subscriptionId)
        if (cursor) notify({ kind: 'closed', reason, cursor })
      }
      const abort = (): void => finish('unsubscribed')
      const terminate = (reason: 'scope-revoked' | 'host-replaced'): void => finish(reason)
      subscriptions.add(terminate)
      options?.signal?.addEventListener('abort', abort, { once: true })
      const accept = (event: StartupEventV1): void => {
        if (closed) return
        const next = event.kind === 'snapshot' ? event.snapshot.cursor : event.cursor
        if (cursor && (next.scopeId !== cursor.scopeId || next.hostGeneration !== cursor.hostGeneration)) {
          finish('host-replaced')
          return
        }
        if (event.kind === 'closed') {
          cursor = next
          finish(event.reason)
          return
        }
        if (cursor && next.epoch === cursor.epoch && next.sequence <= cursor.sequence) return
        if (cursor && next.epoch !== cursor.epoch && event.reason !== 'epoch-changed' && event.reason !== 'gap') {
          throw new Error('startup epoch changed without a reset')
        }
        cursor = next
        notify(event)
      }
      const connect = async (after?: StartupCursorV1): Promise<void> => {
        const result = await invoke({
          requestId: requestId(),
          operation: 'startupSubscribe',
          ...(after ? { after } : {}),
        }, controller.signal) as {
          subscriptionId: string
          initial: StartupEventV1
        }
        if (closed) {
          cleanupRemote(result.subscriptionId)
          return
        }
        subscriptionId = result.subscriptionId
        accept(result.initial)
      }
      try {
        await connect(options?.after)
      } catch (error) {
        finish('unsubscribed')
        throw error
      }
      const pump = async (): Promise<void> => {
        while (!closed) {
          try {
            const event = await invoke({
              requestId: requestId(),
              operation: 'startupNext',
              subscriptionId: subscriptionId!,
            }, controller.signal) as StartupEventV1
            accept(event)
          } catch {
            if (closed) break
            cleanupRemote(subscriptionId)
            subscriptionId = undefined
            // Bounded backoff, aborted on owner disposal. The authority decides replay/reset.
            await new Promise<void>(resolve => {
              wakeRetry = resolve
              retryTimer = setTimeout(resolve, 250)
            })
            retryTimer = undefined
            wakeRetry = undefined
            if (closed) break
            try {
              await connect(cursor)
            } catch {
              // Lost authorization is terminal. Acquire a newly authorized facade instead.
              finish('scope-revoked')
            }
          }
        }
      }
      void pump()
      return { close: () => finish('unsubscribed') } satisfies StartupSubscriptionV1
    },
  }
  return {
    observer,
    dispose(reason: 'scope-revoked' | 'host-replaced' = 'scope-revoked'): void {
      if (terminated) return
      terminated = reason
      for (const controller of reads) controller.abort()
      for (const close of [...subscriptions]) close(reason)
    },
  }
}
