import { safeDiagnosticMessage } from './diagnostic-redaction.js'
import type { ManagedServiceOwnerRoute } from './managed-service-fleet-types.js'
import type { ManagedServiceStartupTombstones } from './managed-service-startup-tombstones.js'
import { MAX_MANAGED_SERVICE_UI_REQUEST_BYTES, parseManagedServiceUIBindingRequest } from './managed-service-ui-rpc.js'

/** Resolve an owner-only plan without exposing the source token or plan to a renderer. */
export async function prepareManagedServiceUIAccountToggle(input: {
  readonly value: string
  readonly routes: ReadonlyMap<string, ManagedServiceOwnerRoute>
  readonly isDisposed: () => boolean
}): Promise<unknown> {
  if (Buffer.byteLength(input.value) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) {
    throw new Error('managed service UI request exceeds maximum size')
  }
  const envelope: unknown = JSON.parse(input.value)
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('managed service UI request is invalid')
  }
  const token = (envelope as { token?: unknown }).token
  const route = typeof token === 'string' ? input.routes.get(token) : undefined
  if (!route?.handler.prepareAccountToggle) throw new Error('managed service UI account toggle plan is unavailable')
  const request = parseManagedServiceUIBindingRequest(envelope, route.handler, route.owner)
  if (request.operation !== 'toggleAccount') throw new Error('managed service UI operation is invalid')
  const plan = await route.handler.prepareAccountToggle(route.owner, request)
  if (input.isDisposed() || input.routes.get(token as string) !== route) {
    throw new Error('managed service UI binding was replaced')
  }
  return plan
}

/** Dispatch a renderer request through the lifecycle owner selected by its token. */
export async function handleManagedServiceUIBindingValue(input: {
  readonly value: string
  readonly documentSignal: AbortSignal | undefined
  readonly routes: ReadonlyMap<string, ManagedServiceOwnerRoute>
  readonly tombstones: ManagedServiceStartupTombstones
}): Promise<Record<string, unknown>> {
  let requestId = 'invalid'
  let envelope: Record<string, unknown> | undefined
  try {
    if (Buffer.byteLength(input.value) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) {
      throw new Error('managed service UI request exceeds maximum size')
    }
    envelope = JSON.parse(input.value) as Record<string, unknown>
    if (typeof envelope.requestId === 'string') requestId = envelope.requestId
    if (typeof envelope.token !== 'string') throw new Error('managed service UI request is not authorized')
    const terminated = input.tombstones.result(envelope)
    if (terminated !== undefined) return { requestId, ok: true, value: terminated }
    const route = input.routes.get(envelope.token)
    if (route === undefined) throw new Error('managed service UI request is not authorized')
    const request = parseManagedServiceUIBindingRequest(envelope, route.handler, route.owner)
    if (request.operation === 'consoleBrowser' && (!input.documentSignal || input.documentSignal.aborted)) {
      return { requestId, ok: true, value: { status: 'unavailable', reason: 'owner-unavailable' } }
    }
    return { requestId, ok: true, value: await route.handler.handle(route.owner, request, input.documentSignal) }
  } catch (error) {
    const terminated = envelope === undefined ? undefined : input.tombstones.result(envelope)
    if (terminated !== undefined) return { requestId, ok: true, value: terminated }
    const message = safeDiagnosticMessage(error)
    const code = message.includes('not declared')
      ? 'service-not-declared'
      : message.includes('binding') && message.includes('replaced')
      ? 'binding-replaced'
      : message.includes('stale') || message.includes('spoofed')
      ? 'stale-generation'
      : message.includes('disposed')
      ? 'disposed'
      : 'owner-unavailable'
    return { requestId, ok: false, code }
  }
}
