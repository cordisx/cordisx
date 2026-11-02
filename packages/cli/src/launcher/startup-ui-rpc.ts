import { safeStartupEvent, safeStartupSnapshot } from './startup-ui-projection.js'
import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSubscriptionV1,
} from '@cordisx/protocol/startup/v1'
import type { ManagedServiceUIOwner } from './managed-service-ui-rpc.js'

export type StartupUIRequest =
  | { readonly requestId: string; readonly operation: 'startupRead' }
  | {
    readonly requestId: string
    readonly operation: 'startupSubscribe'
    readonly subscriptionId: string
    readonly after?: StartupCursorV1
  }
  | { readonly requestId: string; readonly operation: 'startupNext' | 'startupClose'; readonly subscriptionId: string }

export interface StartupUIObserverBinding extends ManagedServiceUIOwner {
  readonly observer: StartupObserverV1
}

export type StartupUIPrincipal = ManagedServiceUIOwner | { readonly kind: 'host'; readonly hostGeneration: string }
const keyOf = (owner: StartupUIPrincipal): string =>
  'kind' in owner
    ? JSON.stringify(['host', owner.hostGeneration])
    : JSON.stringify(['plugin', owner.pluginId, owner.pluginGeneration])

/** Reject wire-selected scope. The selected observer is issued by the Host, never by a cursor. */
export function parseStartupUIRequest(value: Record<string, unknown>): StartupUIRequest {
  const operation = value.operation
  const allowed = [
    'version',
    'token',
    'requestId',
    'operation',
    'scope',
    ...(operation === 'startupSubscribe' ? ['after', 'subscriptionId'] : []),
    ...(operation === 'startupNext' || operation === 'startupClose' ? ['subscriptionId'] : []),
  ]
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('startup request contains unsupported fields')
  }
  if (operation === 'startupRead') return { requestId: value.requestId as string, operation }
  if (operation === 'startupSubscribe') {
    if (typeof value.subscriptionId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.subscriptionId)) {
      throw new Error('startup subscription id is invalid')
    }
    const subscriptionId = value.subscriptionId
    if (value.after === undefined) return { requestId: value.requestId as string, operation, subscriptionId }
    const after = value.after as StartupCursorV1
    if (
      !after || typeof after !== 'object'
      || Object.keys(after).sort().join(',') !== 'epoch,hostGeneration,scopeId,sequence'
      || ![after.scopeId, after.hostGeneration, after.epoch].every(id =>
        typeof id === 'string' && id.length > 0 && id.length <= 256
      )
      || !Number.isSafeInteger(after.sequence) || after.sequence < 0
    ) throw new Error('startup cursor is invalid')
    return { requestId: value.requestId as string, operation, subscriptionId, after }
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
export function createStartupUIRPC(
  bindings: readonly StartupUIObserverBinding[],
  host?: { readonly generation: string; readonly observer: StartupObserverV1 },
) {
  const observers = new Map<string, StartupObserverV1>()
  if (host) observers.set(keyOf({ kind: 'host', hostGeneration: host.generation }), host.observer)
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
    pending?: { resolve: (event: StartupEventV1) => void; reject: (error: Error) => void }
    closed?: StartupEventV1 & { kind: 'closed' }
    cursor?: StartupCursorV1
    stopped?: boolean
  }
  const streams = new Map<string, Stream>()
  let disposed = false
  const revoked = new Set<string>()
  function close(stream: Stream, reason: 'unsubscribed' | 'scope-revoked' | 'host-replaced'): void {
    if (!stream.closed && stream.cursor) deliver(stream, { kind: 'closed', reason, cursor: stream.cursor })
    stream.stopped = true
    stream.pending?.reject(new Error('startup observer was revoked'))
    delete stream.pending
    stream.controller.abort()
    stream.subscription?.close()
  }
  function deliver(stream: Stream, event: StartupEventV1): void {
    if (stream.closed || stream.stopped) return
    event = safeStartupEvent(event)
    if (event.kind !== 'connection') stream.cursor = event.kind === 'snapshot' ? event.snapshot.cursor : event.cursor
    if (event.kind === 'closed') stream.closed = event
    if (stream.pending) {
      const { resolve } = stream.pending
      delete stream.pending
      resolve(event)
    } else {
      // A slow/disconnected renderer receives a full reset, never a truncated replay.
      if (stream.queue.length >= 32 && event.kind === 'snapshot') {
        stream.queue.length = 0
        stream.queue.push({ ...event, reason: 'gap' })
      } else {
        if (event.kind === 'connection' && stream.queue.length >= 32) {
          const prior = stream.queue.findIndex(item => item.kind === 'connection')
          if (prior >= 0) stream.queue.splice(prior, 1)
          else return
        }
        stream.queue.push(event)
      }
    }
  }
  return {
    async handle(owner: StartupUIPrincipal, request: StartupUIRequest): Promise<unknown> {
      const key = keyOf(owner)
      const observer = observers.get(key)
      if (disposed || revoked.has(key)) {
        return { status: 'startup-terminated', reason: disposed ? 'host-replaced' : 'scope-revoked' }
      }
      if (!observer) throw new Error('startup observer is unavailable')
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
        const subscriptionId = request.subscriptionId
        if (streams.has(subscriptionId) || streams.size >= 512) {
          throw new Error('startup subscription limit or duplicate id')
        }
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
          // A valid current cursor has no replay events. Atomic subscribe is still complete.
          const initial = stream.queue.shift()
          return { subscriptionId, ...(initial === undefined ? {} : { initial }) }
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
      return await new Promise<StartupEventV1>((resolve, reject) => {
        stream.pending = { resolve, reject }
      })
    },
    disposeOwner(owner: StartupUIPrincipal, reason: 'scope-revoked' | 'host-replaced' = 'scope-revoked'): void {
      const key = keyOf(owner)
      revoked.add(key)
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
