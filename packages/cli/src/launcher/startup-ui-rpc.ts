import { safeStartupEvent, safeStartupSnapshot } from './startup-ui-projection.js'
import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSubscriptionV1,
} from '@cordisx/protocol/startup/v1'
import { randomUUID } from 'node:crypto'
import type { ManagedServiceUIOwner } from './managed-service-ui-rpc.js'

export type StartupUIRequest =
  | { readonly requestId: string; readonly operation: 'startupRead' }
  | { readonly requestId: string; readonly operation: 'startupSubscribe'; readonly after?: StartupCursorV1 }
  | { readonly requestId: string; readonly operation: 'startupNext' | 'startupClose'; readonly subscriptionId: string }

export interface StartupUIObserverBinding extends ManagedServiceUIOwner {
  readonly observer: StartupObserverV1
}

const keyOf = (owner: ManagedServiceUIOwner): string => JSON.stringify([owner.pluginId, owner.pluginGeneration])

/** Reject wire-selected scope. The selected observer is issued by the Host, never by a cursor. */
export function parseStartupUIRequest(value: Record<string, unknown>): StartupUIRequest {
  const operation = value.operation
  const allowed = [
    'version',
    'token',
    'requestId',
    'operation',
    'scope',
    ...(operation === 'startupSubscribe' ? ['after'] : []),
    ...(operation === 'startupNext' || operation === 'startupClose' ? ['subscriptionId'] : []),
  ]
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('startup request contains unsupported fields')
  }
  if (operation === 'startupRead') return { requestId: value.requestId as string, operation }
  if (operation === 'startupSubscribe') {
    if (value.after === undefined) return { requestId: value.requestId as string, operation }
    const after = value.after as StartupCursorV1
    if (
      !after || typeof after !== 'object'
      || Object.keys(after).sort().join(',') !== 'epoch,hostGeneration,scopeId,sequence'
      || ![after.scopeId, after.hostGeneration, after.epoch].every(id =>
        typeof id === 'string' && id.length > 0 && id.length <= 256
      )
      || !Number.isSafeInteger(after.sequence) || after.sequence < 0
    ) throw new Error('startup cursor is invalid')
    return { requestId: value.requestId as string, operation, after }
  }
  if (
    (operation === 'startupNext' || operation === 'startupClose')
    && typeof value.subscriptionId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value.subscriptionId)
  ) {
    return { requestId: value.requestId as string, operation, subscriptionId: value.subscriptionId }
  }
  throw new Error('startup operation is invalid')
}

/** Transport only: the runtime observer owns scope authorization, history, epochs and atomic replay. */
export function createStartupUIRPC(bindings: readonly StartupUIObserverBinding[]) {
  const observers = new Map<string, StartupObserverV1>()
  const controllers = new Map<string, Set<AbortController>>()
  for (const binding of bindings) {
    const key = keyOf(binding)
    if (observers.has(key)) throw new Error('startup observer owner is duplicated')
    observers.set(key, binding.observer)
  }
  interface Stream {
    readonly owner: string
    readonly queue: StartupEventV1[]
    readonly controller: AbortController
    subscription?: StartupSubscriptionV1
    pending?: (event: StartupEventV1) => void
    closed?: StartupEventV1 & { kind: 'closed' }
    cursor?: StartupCursorV1
  }
  const streams = new Map<string, Stream>()
  let disposed = false
  function close(stream: Stream, reason: 'unsubscribed' | 'scope-revoked' | 'host-replaced'): void {
    stream.subscription?.close()
    stream.controller.abort()
    if (!stream.closed && stream.cursor) deliver(stream, { kind: 'closed', reason, cursor: stream.cursor })
  }
  function deliver(stream: Stream, event: StartupEventV1): void {
    if (stream.closed) return
    event = safeStartupEvent(event)
    stream.cursor = event.kind === 'snapshot' ? event.snapshot.cursor : event.cursor
    if (event.kind === 'closed') stream.closed = event
    if (stream.pending) {
      const resolve = stream.pending
      delete stream.pending
      resolve(event)
    } else {
      // A slow/disconnected renderer receives a full reset, never a truncated replay.
      if (stream.queue.length >= 32 && event.kind === 'snapshot') {
        stream.queue.length = 0
        stream.queue.push({ ...event, reason: 'gap' })
      } else stream.queue.push(event)
    }
  }
  return {
    async handle(owner: ManagedServiceUIOwner, request: StartupUIRequest): Promise<unknown> {
      const key = keyOf(owner)
      const observer = observers.get(key)
      if (disposed || !observer) throw new Error('startup observer is unavailable')
      if (request.operation === 'startupRead') {
        const controller = new AbortController()
        const owned = controllers.get(key) ?? new Set<AbortController>()
        controllers.set(key, owned)
        owned.add(controller)
        try {
          const snapshot = await observer.read({ signal: controller.signal })
          if (controller.signal.aborted || observers.get(key) !== observer) {
            throw new Error('startup observer was revoked')
          }
          return safeStartupSnapshot(snapshot)
        } finally {
          owned.delete(controller)
        }
      }
      if (request.operation === 'startupSubscribe') {
        const subscriptionId = randomUUID()
        const stream: Stream = { owner: key, queue: [], controller: new AbortController() }
        streams.set(subscriptionId, stream)
        try {
          stream.subscription = await observer.subscribe(event => deliver(stream, event), {
            ...(request.after === undefined ? {} : { after: request.after }),
            signal: stream.controller.signal,
          })
          if (stream.controller.signal.aborted || observers.get(key) !== observer) {
            stream.subscription.close()
            throw new Error('startup observer was revoked')
          }
          const initial = stream.queue.length
            ? stream.queue.shift()!
            : await new Promise<StartupEventV1>(resolve => {
              stream.pending = resolve
            })
          return { subscriptionId, initial }
        } catch (error) {
          streams.delete(subscriptionId)
          stream.controller.abort()
          throw error
        }
      }
      const stream = streams.get(request.subscriptionId)
      if (!stream || stream.owner !== key) throw new Error('startup subscription is outside the current owner scope')
      if (request.operation === 'startupClose') {
        close(stream, 'unsubscribed')
        streams.delete(request.subscriptionId)
        return null
      }
      if (stream.queue.length) return stream.queue.shift()
      if (stream.closed) return stream.closed
      if (stream.pending) throw new Error('startup subscription already has a pending read')
      return await new Promise<StartupEventV1>(resolve => {
        stream.pending = resolve
      })
    },
    disposeOwner(owner: ManagedServiceUIOwner, reason: 'scope-revoked' | 'host-replaced' = 'scope-revoked'): void {
      const key = keyOf(owner)
      observers.delete(key)
      for (const controller of controllers.get(key) ?? []) controller.abort()
      controllers.delete(key)
      for (const [id, stream] of streams) {
        if (stream.owner === key) {
          close(stream, reason)
          streams.delete(id)
        }
      }
    },
    dispose(): void {
      disposed = true
      for (const owned of controllers.values()) for (const controller of owned) controller.abort()
      controllers.clear()
      for (const stream of streams.values()) close(stream, 'host-replaced')
      observers.clear()
      streams.clear()
    },
  }
}
