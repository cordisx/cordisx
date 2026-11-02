import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSnapshotV1,
  StartupSubscriptionV1,
} from '@cordisx/protocol/startup/v1'
import { randomUUID } from 'node:crypto'

/** Transport-free scoped history. The caller supplies an already-authorized projection. */
export function createStartupObserverSource(input: {
  readonly scopeId: string
  readonly hostGeneration: string
  readonly read: () => Pick<StartupSnapshotV1, 'entries' | 'pages'>
  readonly subscribe: (changed: () => void) => () => void
  readonly historyLimit?: number
}): { readonly observer: StartupObserverV1; close(reason: 'scope-revoked' | 'host-replaced'): void } {
  const epoch = randomUUID()
  let sequence = 0
  let closed: 'scope-revoked' | 'host-replaced' | undefined
  const listeners = new Set<(event: StartupEventV1) => void>()
  const snapshot = (): StartupSnapshotV1 =>
    structuredClone({
      contract: 'cordisx.startup-snapshot/v1',
      cursor: { scopeId: input.scopeId, hostGeneration: input.hostGeneration, epoch, sequence },
      ...input.read(),
    })
  let current = snapshot()
  const history = [current]
  const deliver = (listener: (event: StartupEventV1) => void, event: StartupEventV1) => {
    try {
      listener(structuredClone(event))
    } catch { /* Reader isolation. */ }
  }
  const stop = input.subscribe(() => {
    if (closed !== undefined) return
    sequence += 1
    current = snapshot()
    history.push(current)
    while (history.length > (input.historyLimit ?? 64)) history.shift()
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) deliver(listener, { kind: 'snapshot', reason: 'update', snapshot: current })
    }
  })
  const validCursor = (after: StartupCursorV1) => {
    if (after.scopeId !== input.scopeId || after.hostGeneration !== input.hostGeneration) {
      throw new Error('startup cursor scope mismatch')
    }
    if (!Number.isSafeInteger(after.sequence) || after.sequence < 0) {
      throw new Error('startup cursor sequence is invalid')
    }
  }
  const observer: StartupObserverV1 = Object.freeze<StartupObserverV1>({
    contract: 'cordisx.startup-observer/v1',
    async read(options) {
      if (closed !== undefined) throw new Error(`startup observer ${closed}`)
      options?.signal?.throwIfAborted()
      return structuredClone(current)
    },
    async subscribe(listener, options): Promise<StartupSubscriptionV1> {
      if (closed !== undefined) throw new Error(`startup observer ${closed}`)
      options?.signal?.throwIfAborted()
      const after = options?.after
      if (after !== undefined) validCursor(after)
      let ended = false
      let replaying = true
      let draining = false
      let delivered = -1
      const queued: StartupEventV1[] = []
      const drain = () => {
        if (replaying || draining) return
        draining = true
        try {
          while (!ended && queued.length > 0) {
            const event = queued.shift()!
            if (event.kind === 'snapshot') {
              if (event.snapshot.cursor.sequence <= delivered) continue
              delivered = event.snapshot.cursor.sequence
            }
            deliver(listener, event)
          }
        } finally {
          draining = false
        }
      }
      const receive = (event: StartupEventV1) => {
        if (ended) return
        if (event.kind === 'closed') {
          close(event.reason)
          return
        }
        queued.push(event)
        drain()
      }
      const close = (reason: Extract<StartupEventV1, { kind: 'closed' }>['reason']) => {
        if (ended) return
        ended = true
        listeners.delete(receive)
        options?.signal?.removeEventListener('abort', abort)
        queued.length = 0
        deliver(listener, { kind: 'closed', reason, cursor: current.cursor })
      }
      const abort = () => close('unsubscribed')
      listeners.add(receive)
      options?.signal?.addEventListener('abort', abort, { once: true })
      if (after === undefined) queued.push({ kind: 'snapshot', reason: 'initial', snapshot: current })
      else if (after.epoch !== epoch) queued.push({ kind: 'snapshot', reason: 'epoch-changed', snapshot: current })
      else if (after.sequence > sequence || after.sequence < history[0]!.cursor.sequence) {
        queued.push({ kind: 'snapshot', reason: 'gap', snapshot: current })
      } else {
        queued.push(
          ...history.filter(item => item.cursor.sequence > after.sequence).map(item => ({
            kind: 'snapshot' as const,
            reason: 'update' as const,
            snapshot: item,
          })),
        )
      }
      replaying = false
      drain()
      return Object.freeze({ close: () => close('unsubscribed') })
    },
  })
  return {
    observer,
    close(reason) {
      if (closed !== undefined) return
      closed = reason
      stop()
      for (const listener of [...listeners]) deliver(listener, { kind: 'closed', reason, cursor: current.cursor })
      listeners.clear()
      history.length = 0
    },
  }
}
