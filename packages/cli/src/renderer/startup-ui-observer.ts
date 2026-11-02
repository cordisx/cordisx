import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSubscriptionV1,
} from '@cordisx/protocol/startup/v1'
import type { StartupUIRequest } from '../launcher/startup-ui-rpc.js'

type Invoke = (request: StartupUIRequest, signal?: AbortSignal) => Promise<unknown>
const requestId = (): string => globalThis.crypto.randomUUID()

export class StartupObservationTerminated extends Error {
  constructor(readonly reason: 'scope-revoked' | 'host-replaced') {
    super(reason)
  }
}

/** Public observer facade; retries observation only, never actions or preparation. */
export function createBrowserStartupObserver(invoke: Invoke) {
  const subscriptions = new Set<(reason: 'scope-revoked' | 'host-replaced') => void>()
  const reads = new Set<AbortController>()
  let terminated: 'scope-revoked' | 'host-replaced' | undefined
  const dispose = (reason: 'scope-revoked' | 'host-replaced'): void => {
    if (terminated) return
    terminated = reason
    for (const controller of reads) controller.abort()
    for (const close of [...subscriptions]) close(reason)
  }
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
        const snapshot = await invoke(
          { requestId: requestId(), operation: 'startupRead' },
          controller.signal,
        ) as Awaited<
          ReturnType<StartupObserverV1['read']>
        >
        if (terminated || controller.signal.aborted) throw new Error('startup observer is unavailable')
        return snapshot
      } catch (error) {
        if (error instanceof StartupObservationTerminated) dispose(error.reason)
        throw error
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
        if (reason !== 'unsubscribed') dispose(reason)
      }
      const abort = (): void => finish('unsubscribed')
      const terminate = (reason: 'scope-revoked' | 'host-replaced'): void => finish(reason)
      subscriptions.add(terminate)
      options?.signal?.addEventListener('abort', abort, { once: true })
      const accept = (event: StartupEventV1): void => {
        if (closed) return
        if (event.kind === 'connection') {
          notify(event)
          return
        }
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
        subscriptionId = requestId()
        const result = await invoke({
          requestId: requestId(),
          operation: 'startupSubscribe',
          subscriptionId,
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
        while (!closed && cursor === undefined) {
          accept(
            await invoke(
              { requestId: requestId(), operation: 'startupNext', subscriptionId },
              controller.signal,
            ) as StartupEventV1,
          )
        }
        if (!closed) notify({ kind: 'connection', connection: { state: 'connected' } })
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
          } catch (error) {
            if (closed) break
            if (error instanceof StartupObservationTerminated) {
              finish(error.reason)
              break
            }
            notify({
              kind: 'connection',
              connection: {
                state: 'disconnected',
                reason: error instanceof Error && /timed out/.test(error.message) ? 'timeout' : 'transport-unavailable',
              },
            })
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
            while (!closed) {
              notify({ kind: 'connection', connection: { state: 'reconnecting', reason: 'transport-unavailable' } })
              try {
                await connect(cursor)
                break
              } catch (error) {
                cleanupRemote(subscriptionId)
                subscriptionId = undefined
                if (error instanceof StartupObservationTerminated) {
                  finish(error.reason)
                  break
                }
                await new Promise<void>(resolve => {
                  wakeRetry = resolve
                  retryTimer = setTimeout(resolve, 1_000)
                })
                retryTimer = undefined
                wakeRetry = undefined
              }
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
    dispose: (reason: 'scope-revoked' | 'host-replaced' = 'scope-revoked'): void => dispose(reason),
  }
}
