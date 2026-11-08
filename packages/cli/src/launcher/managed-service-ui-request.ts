import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'
import { parseStartupUIRequest } from './startup-ui-rpc.js'
import type {
  ManagedServiceUIBindingRequest,
  ManagedServiceUIBridgeHandler,
  ManagedServiceUIOwner,
} from './managed-service-ui-rpc.js'
import { managedServiceUIBindingEqual as bindingEqual } from './managed-service-ui-binding.js'

interface RequestScope {
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly pluginGeneration: string
}

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PROVIDER_ID = /^(?:anthropic|codex|antigravity|kimi|xai|(?:plugin|custom):[a-z0-9][a-z0-9._-]{0,55})$/
const MAX_GESTURE_AGE_MS = 5 * 60 * 1_000
const MAX_GESTURE_FUTURE_MS = 30 * 1_000
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const result = object(value, label)
  const unknown = Object.keys(result).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
  return result
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOCAL_ID.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw new Error('managed service UI request id is invalid')
  return value
}

function sequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function scope(value: unknown, handler: ManagedServiceUIBridgeHandler, owner: ManagedServiceUIOwner): RequestScope {
  const result = exact(value, ['profileId', 'runtimeGeneration', 'pluginGeneration'], 'managed service UI scope')
  if (
    result.profileId !== handler.profileId || result.runtimeGeneration !== handler.generation
    || result.pluginGeneration !== owner.pluginGeneration
  ) throw new Error('managed service UI scope is stale or spoofed')
  return {
    profileId: handler.profileId,
    runtimeGeneration: handler.generation,
    pluginGeneration: owner.pluginGeneration,
  }
}

function binding(
  value: unknown,
  handler: ManagedServiceUIBridgeHandler,
  owner: ManagedServiceUIOwner,
): ManagedServiceBindingV1 {
  const result = exact(value, ['bindingId', 'identity', 'scope'], 'managed service UI binding')
  const identity = exact(result.identity, ['source', 'pluginId', 'serviceId'], 'managed service UI binding identity')
  const bindingScope = exact(result.scope, ['profileId', 'generation'], 'managed service UI binding scope')
  if (
    typeof result.bindingId !== 'string' || !OPAQUE_ID.test(result.bindingId)
    || identity.pluginId !== owner.pluginId || !LOCAL_ID.test(String(identity.serviceId))
    || bindingScope.profileId !== handler.profileId || bindingScope.generation !== handler.generation
    || (identity.source !== undefined
      && (typeof identity.source !== 'string' || !identity.source.startsWith('https://')))
  ) throw new Error('managed service UI binding is stale or spoofed')
  return result as unknown as ManagedServiceBindingV1
}

function explicitClick(value: unknown, now: number): void {
  const gesture = exact(value, ['kind', 'at'], 'managed service UI user gesture')
  const at = typeof gesture.at === 'string' ? Date.parse(gesture.at) : Number.NaN
  if (
    gesture.kind !== 'explicit-click' || !Number.isFinite(at)
    || at < now - MAX_GESTURE_AGE_MS || at > now + MAX_GESTURE_FUTURE_MS
  ) throw new Error('managed service UI operation requires a fresh explicit-click gesture')
}

function actionRequestBase(
  value: unknown,
  operation: string,
  allowed: readonly string[],
  schema: string,
  contract: string,
  currentBinding: ManagedServiceBindingV1,
  handler: ManagedServiceUIBridgeHandler,
  owner: ManagedServiceUIOwner,
  now: number,
): Record<string, unknown> {
  const request = exact(value, allowed, `managed service UI ${operation} request`)
  if (request.$schema !== schema || request.contract !== contract || request.schemaVersion !== 1) {
    throw new Error(`managed service UI ${operation} request contract is unsupported`)
  }
  requestId(request.requestId)
  explicitClick(request.userGesture, now)
  const requestBinding = binding(request.binding, handler, owner)
  if (!bindingEqual(requestBinding, currentBinding)) {
    throw new Error('managed service UI operation binding is stale or spoofed')
  }
  return request
}

function operationRequest(
  value: unknown,
  operation: string,
  currentBinding: ManagedServiceBindingV1,
  handler: ManagedServiceUIBridgeHandler,
  owner: ManagedServiceUIOwner,
  now: number,
): unknown {
  if (operation === 'authenticate') {
    const request = actionRequestBase(
      value,
      operation,
      ['$schema', 'contract', 'schemaVersion', 'requestId', 'binding', 'action', 'expectedSequence', 'userGesture'],
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
      'cordisx.managed-service-login-request/v1',
      currentBinding,
      handler,
      owner,
      now,
    )
    if (request.action !== 'login') throw new Error('managed service UI authentication action is invalid')
    sequence(request.expectedSequence, 'managed service UI expectedSequence')
    return request
  }
  if (operation === 'logout') {
    const request = actionRequestBase(
      value,
      operation,
      ['$schema', 'contract', 'schemaVersion', 'requestId', 'binding', 'action', 'expectedSequence', 'userGesture'],
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      'cordisx.managed-service-logout-request/v1',
      currentBinding,
      handler,
      owner,
      now,
    )
    if (request.action !== 'logout') throw new Error('managed service UI logout action is invalid')
    sequence(request.expectedSequence, 'managed service UI expectedSequence')
    return request
  }
  if (operation === 'toggleAccount') {
    const request = actionRequestBase(
      value,
      operation,
      [
        '$schema',
        'contract',
        'schemaVersion',
        'requestId',
        'binding',
        'accountId',
        'authIndex',
        'disabled',
        'expectedRevision',
        'userGesture',
      ],
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle.v1.schema.json',
      'cordisx.managed-service-cli-proxy-account-toggle/v1',
      currentBinding,
      handler,
      owner,
      now,
    )
    if (typeof request.accountId !== 'string' || !ACCOUNT_ID.test(request.accountId)) {
      throw new Error('managed service UI account id is invalid')
    }
    if (request.authIndex !== undefined && (typeof request.authIndex !== 'string' || request.authIndex.length > 64)) {
      throw new Error('managed service UI auth index is invalid')
    }
    if (typeof request.disabled !== 'boolean') throw new Error('managed service UI account disabled value is invalid')
    sequence(request.expectedRevision, 'managed service UI expectedRevision')
    return request
  }
  if (operation === 'startOAuth') {
    const request = actionRequestBase(
      value,
      operation,
      ['$schema', 'contract', 'schemaVersion', 'requestId', 'binding', 'provider', 'expectedRevision', 'userGesture'],
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-oauth-start.v1.schema.json',
      'cordisx.managed-service-cli-proxy-oauth-start/v1',
      currentBinding,
      handler,
      owner,
      now,
    )
    if (typeof request.provider !== 'string' || !PROVIDER_ID.test(request.provider)) {
      throw new Error('managed service UI OAuth provider is invalid')
    }
    sequence(request.expectedRevision, 'managed service UI expectedRevision')
    return request
  }
  if (operation === 'cancelOAuth') {
    const request = actionRequestBase(
      value,
      operation,
      ['$schema', 'contract', 'schemaVersion', 'requestId', 'binding', 'sessionId', 'expectedRevision', 'userGesture'],
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-oauth-cancel.v1.schema.json',
      'cordisx.managed-service-cli-proxy-oauth-cancel/v1',
      currentBinding,
      handler,
      owner,
      now,
    )
    requestId(request.sessionId)
    sequence(request.expectedRevision, 'managed service UI expectedRevision')
    return request
  }
  throw new Error('managed service UI operation is invalid')
}

function operationEnvelope(value: unknown, operation: unknown): void {
  const common = ['version', 'token', 'requestId', 'operation', 'scope', 'serviceId']
  const allowed = operation === 'get' || operation === 'nativeProviders'
    ? common
    : operation === 'readWebEntry' || operation === 'consoleView' || operation === 'consoleBrowser'
    ? [...common, 'binding', 'request']
    : operation === 'cancelWebEntry'
    ? [...common, 'binding', 'request', 'targetRequestId']
    : operation === 'snapshot' || operation === 'readCatalog' || operation === 'readAccounts'
    ? [...common, 'binding']
    : operation === 'subscribe'
    ? [...common, 'binding', 'afterSequence']
    : operation === 'next' || operation === 'pull' || operation === 'closed' || operation === 'unsubscribe'
    ? [...common, 'binding', 'subscriptionId']
    : operation === 'pollOAuth'
    ? [...common, 'binding', 'sessionId']
    : operation === 'authenticate' || operation === 'logout' || operation === 'toggleAccount'
        || operation === 'startOAuth'
        || operation === 'cancelOAuth'
    ? [...common, 'binding', 'request']
    : undefined
  if (allowed === undefined) throw new Error('managed service UI operation is invalid')
  exact(value, allowed, 'managed service UI request')
}

/** Parse a renderer request against a Host-selected plugin owner. The wire cannot choose pluginId. */
export function parseManagedServiceUIBindingRequest(
  value: unknown,
  handler: ManagedServiceUIBridgeHandler,
  owner: ManagedServiceUIOwner,
  now = Date.now(),
): ManagedServiceUIBindingRequest {
  id(owner.pluginId, 'managed service UI owner plugin id')
  if (typeof owner.pluginGeneration !== 'string' || owner.pluginGeneration.length === 0) {
    throw new Error('managed service UI owner generation is invalid')
  }
  const envelope = exact(
    value,
    [
      'version',
      'token',
      'requestId',
      'operation',
      'scope',
      'serviceId',
      'binding',
      'afterSequence',
      'subscriptionId',
      'request',
      'sessionId',
      'after',
      'targetRequestId',
    ],
    'managed service UI request',
  )
  if (envelope.version !== 1 || envelope.token !== handler.token) {
    throw new Error('managed service UI request is not authorized')
  }
  if (typeof envelope.operation === 'string' && envelope.operation.startsWith('startup')) {
    scope(envelope.scope, handler, owner)
    requestId(envelope.requestId)
    return parseStartupUIRequest(envelope)
  }
  operationEnvelope(value, envelope.operation)
  scope(envelope.scope, handler, owner)
  const common = {
    requestId: requestId(envelope.requestId),
    serviceId: id(envelope.serviceId, 'managed service UI service id'),
  }
  if (envelope.operation === 'get') return { ...common, operation: 'get' }
  if (envelope.operation === 'nativeProviders') return { ...common, operation: 'nativeProviders' }
  const currentBinding = binding(envelope.binding, handler, owner)
  if (currentBinding.identity.serviceId !== common.serviceId) {
    throw new Error('managed service UI binding service is stale or spoofed')
  }
  if (envelope.operation === 'consoleBrowser') {
    const raw = exact(envelope.request, ['viewId', 'serviceGeneration', 'action'], 'managed browser console')
    if (raw.action !== 'issue' && raw.action !== 'retire') throw new Error('Managed browser console action is invalid')
    return {
      ...common,
      operation: 'consoleBrowser',
      binding: currentBinding,
      request: {
        action: raw.action,
        viewId: requestId(raw.viewId),
        serviceGeneration: requestId(raw.serviceGeneration),
      },
    }
  }
  if (envelope.operation === 'consoleView') {
    const raw = exact(envelope.request, ['viewId', 'serviceGeneration', 'action', 'bounds'], 'managed console view')
    const viewId = requestId(raw.viewId)
    const serviceGeneration = requestId(raw.serviceGeneration)
    const base = { ...common, operation: 'consoleView' as const, binding: currentBinding }
    if ((raw.action === 'mount' || raw.action === 'dispose') && !Object.hasOwn(raw, 'bounds')) {
      return { ...base, request: { action: raw.action, viewId, serviceGeneration } }
    }
    if (raw.action !== 'update') throw new Error('Managed console action is invalid')
    const bounds = raw.bounds === null
      ? null
      : exact(raw.bounds, ['x', 'y', 'width', 'height'], 'managed console bounds')
    const parsed = bounds === null ? null : {
      x: sequence(bounds.x, 'console x'),
      y: sequence(bounds.y, 'console y'),
      width: sequence(bounds.width, 'console width'),
      height: sequence(bounds.height, 'console height'),
    }
    return { ...base, request: { action: 'update', viewId, serviceGeneration, bounds: parsed } }
  }
  if (envelope.operation === 'readWebEntry' || envelope.operation === 'cancelWebEntry') {
    const read = exact(envelope.request, ['contract', 'binding', 'serviceGeneration'], 'web entry read')
    const captured = binding(read.binding, handler, owner)
    if (
      read.contract !== 'cordisx.managed-service-web-entry-read/v1'
      || typeof read.serviceGeneration !== 'string' || !OPAQUE_ID.test(read.serviceGeneration)
      || !bindingEqual(captured, currentBinding)
    ) throw new Error('web entry read is invalid')
    const request = {
      contract: 'cordisx.managed-service-web-entry-read/v1' as const,
      binding: captured,
      serviceGeneration: read.serviceGeneration,
    }
    return envelope.operation === 'cancelWebEntry'
      ? {
        ...common,
        operation: 'cancelWebEntry',
        binding: captured,
        request,
        targetRequestId: requestId(envelope.targetRequestId),
      }
      : { ...common, operation: 'readWebEntry', binding: captured, request }
  }
  if (
    envelope.operation === 'snapshot' || envelope.operation === 'readCatalog' || envelope.operation === 'readAccounts'
  ) {
    return { ...common, operation: envelope.operation, binding: currentBinding }
  }
  if (envelope.operation === 'subscribe') {
    return {
      ...common,
      operation: 'subscribe',
      binding: currentBinding,
      afterSequence: envelope.afterSequence === undefined
        ? 0
        : sequence(envelope.afterSequence, 'managed service UI afterSequence'),
    }
  }
  if (
    envelope.operation === 'next' || envelope.operation === 'pull' || envelope.operation === 'closed'
    || envelope.operation === 'unsubscribe'
  ) {
    return {
      ...common,
      operation: envelope.operation,
      binding: currentBinding,
      subscriptionId: requestId(envelope.subscriptionId),
    }
  }
  if (envelope.operation === 'pollOAuth') {
    return {
      ...common,
      operation: 'pollOAuth',
      binding: currentBinding,
      sessionId: requestId(envelope.sessionId),
    }
  }
  if (
    envelope.operation === 'authenticate' || envelope.operation === 'logout' || envelope.operation === 'toggleAccount'
    || envelope.operation === 'startOAuth' || envelope.operation === 'cancelOAuth'
  ) {
    const request = operationRequest(envelope.request, envelope.operation, currentBinding, handler, owner, now)
    return {
      ...common,
      operation: envelope.operation,
      binding: currentBinding,
      request,
    } as ManagedServiceUIBindingRequest
  }
  throw new Error('managed service UI operation is invalid')
}
