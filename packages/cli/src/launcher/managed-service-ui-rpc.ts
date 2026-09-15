import type {
  ManagedServiceBindingV1,
  ManagedServiceCliProxyAccountToggleRequestV1,
  ManagedServiceCliProxyOAuthCancelRequestV1,
  ManagedServiceCliProxyOAuthStartRequestV1,
  ManagedServiceLoginRequestV1,
  ManagedServiceLogoutRequestV1,
  ManagedServiceSourceV1,
  ManagedServiceSubscriptionClosedV1,
  ManagedServiceSubscriptionV1,
} from '@cordisx/protocol/managed-service/v1'

export const MANAGED_SERVICE_UI_BINDING = '__cordisxManagedServiceUIRequestV1'
export const MANAGED_SERVICE_UI_RECEIVER = '__cordisxManagedServiceUIReceiveV1'
export const MAX_MANAGED_SERVICE_UI_REQUEST_BYTES = 256 * 1024

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PROVIDER_ID = /^(?:anthropic|codex|antigravity|kimi|xai|(?:plugin|custom):[a-z0-9][a-z0-9._-]{0,55})$/
const MAX_GESTURE_AGE_MS = 5 * 60 * 1_000
const MAX_GESTURE_FUTURE_MS = 30 * 1_000
const PROHIBITED_RESPONSE_KEYS =
  /^(?:secret|secrets|password|credential|credentials|port|runtimeHandle|runtimeHandles)$/iu

export interface ManagedServiceUIOwner {
  readonly pluginId: string
  readonly pluginGeneration: string
}

export interface ManagedServiceUISourceBinding extends ManagedServiceUIOwner {
  readonly serviceId: string
  readonly loginTimeoutMs?: number
  readonly source: ManagedServiceSourceV1
}

interface RequestScope {
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly pluginGeneration: string
}

export type ManagedServiceUIBindingRequest =
  | { readonly requestId: string; readonly operation: 'nativeProviders'; readonly serviceId: string }
  | { readonly requestId: string; readonly operation: 'get'; readonly serviceId: string }
  | {
    readonly requestId: string
    readonly operation: 'snapshot'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
  }
  | {
    readonly requestId: string
    readonly operation: 'subscribe'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly afterSequence: number
  }
  | {
    readonly requestId: string
    readonly operation: 'next' | 'pull'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly subscriptionId: string
  }
  | {
    readonly requestId: string
    readonly operation: 'closed'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly subscriptionId: string
  }
  | {
    readonly requestId: string
    readonly operation: 'unsubscribe'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly subscriptionId: string
  }
  | {
    readonly requestId: string
    readonly operation: 'authenticate'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly request: ManagedServiceLoginRequestV1
  }
  | {
    readonly requestId: string
    readonly operation: 'logout'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly request: ManagedServiceLogoutRequestV1
  }
  | {
    readonly requestId: string
    readonly operation: 'readCatalog'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
  }
  | {
    readonly requestId: string
    readonly operation: 'readAccounts'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
  }
  | {
    readonly requestId: string
    readonly operation: 'toggleAccount'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly request: ManagedServiceCliProxyAccountToggleRequestV1
  }
  | {
    readonly requestId: string
    readonly operation: 'startOAuth'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly request: ManagedServiceCliProxyOAuthStartRequestV1
  }
  | {
    readonly requestId: string
    readonly operation: 'pollOAuth'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly sessionId: string
  }
  | {
    readonly requestId: string
    readonly operation: 'cancelOAuth'
    readonly serviceId: string
    readonly binding: ManagedServiceBindingV1
    readonly request: ManagedServiceCliProxyOAuthCancelRequestV1
  }

interface SubscriptionState {
  readonly ownerKey: string
  readonly serviceKey: string
  readonly source: ManagedServiceSourceV1
  readonly subscription: ManagedServiceSubscriptionV1
  readonly pages: AsyncIterator<unknown>
}

export interface ManagedServiceUIBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  handle(owner: ManagedServiceUIOwner, request: ManagedServiceUIBindingRequest): Promise<unknown>
  disposeOwner(owner: ManagedServiceUIOwner): Promise<void>
  dispose(): Promise<void>
}

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
    ],
    'managed service UI request',
  )
  if (envelope.version !== 1 || envelope.token !== handler.token) {
    throw new Error('managed service UI request is not authorized')
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

function bindingEqual(left: ManagedServiceBindingV1, right: ManagedServiceBindingV1): boolean {
  return left.bindingId === right.bindingId
    && left.identity.pluginId === right.identity.pluginId
    && left.identity.serviceId === right.identity.serviceId
    && left.identity.source === right.identity.source
    && left.scope.profileId === right.scope.profileId
    && left.scope.generation === right.scope.generation
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (PROHIBITED_RESPONSE_KEYS.test(key)) {
      throw new Error(`managed service UI response contains prohibited field ${key}`)
    }
    return item
  })) as Value
}

function ownerKey(owner: ManagedServiceUIOwner): string {
  return `${owner.pluginId}\u0000${owner.pluginGeneration}`
}

function serviceKey(owner: ManagedServiceUIOwner, serviceId: string): string {
  return `${ownerKey(owner)}\u0000${serviceId}`
}

/** Create the Node-side broker for renderer-safe managed service projections. */
export function createManagedServiceUIBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly services: readonly ManagedServiceUISourceBinding[]
  readonly readNativeProviders?: () => Promise<readonly unknown[]>
}): ManagedServiceUIBridgeHandler {
  const services = new Map<string, ManagedServiceSourceV1>()
  const loginTimeouts = new Map<string, number>()
  for (const service of input.services) {
    id(service.pluginId, 'managed service UI source plugin id')
    id(service.serviceId, 'managed service UI source service id')
    if (
      service.source.binding.identity.pluginId !== service.pluginId
      || service.source.binding.identity.serviceId !== service.serviceId
      || service.source.binding.scope.profileId !== input.profileId
      || service.source.binding.scope.generation !== input.generation
    ) throw new Error('managed service UI source binding is outside the active scope')
    const key = serviceKey(service, service.serviceId)
    if (services.has(key)) throw new Error('managed service UI source is duplicated')
    services.set(key, service.source)
    if (service.loginTimeoutMs !== undefined) {
      if (
        !Number.isSafeInteger(service.loginTimeoutMs) || service.loginTimeoutMs < 100
        || service.loginTimeoutMs > 300_000
      ) {
        throw new Error('managed service UI login timeout is invalid')
      }
      loginTimeouts.set(key, service.loginTimeoutMs)
    }
  }
  const subscriptions = new Map<string, SubscriptionState>()
  const closedSubscriptions = new Map<string, ManagedServiceSubscriptionClosedV1>()
  let disposed = false

  const resolve = (owner: ManagedServiceUIOwner, serviceId: string, expected?: ManagedServiceBindingV1) => {
    if (disposed) throw new Error('managed service UI bridge is disposed')
    const key = serviceKey(owner, serviceId)
    const source = services.get(key)
    if (source === undefined) throw new Error('managed service UI service is not declared for this owner')
    if (expected !== undefined && !bindingEqual(source.binding, expected)) {
      throw new Error('managed service UI binding was replaced')
    }
    return { key, source }
  }
  const unsubscribe = async (subscriptionId: string): Promise<ManagedServiceSubscriptionClosedV1> => {
    const prior = closedSubscriptions.get(subscriptionId)
    if (prior !== undefined) return prior
    const state = subscriptions.get(subscriptionId)
    if (state === undefined) throw new Error('managed service UI subscription is unavailable')
    const closed = clone(await state.subscription.unsubscribe())
    subscriptions.delete(subscriptionId)
    closedSubscriptions.set(subscriptionId, closed)
    return closed
  }
  const handler: ManagedServiceUIBridgeHandler = {
    token: input.token,
    profileId: input.profileId,
    generation: input.generation,
    async handle(owner, request) {
      if (request.operation === 'nativeProviders') {
        if (disposed) throw new Error('managed service UI is disposed')
        if (![...services.keys()].some(key => key.startsWith(`${ownerKey(owner)}\u0000`))) {
          throw new Error('managed service UI owner is unavailable')
        }
        const providers = await input.readNativeProviders?.() ?? []
        return clone(providers.filter(provider =>
          provider !== null && typeof provider === 'object'
          && (provider as Record<string, unknown>).pluginId === owner.pluginId
        ))
      }
      const resolved = resolve(owner, request.serviceId, request.operation === 'get' ? undefined : request.binding)
      if (request.operation === 'get') {
        return clone({
          status: 'available',
          service: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription.v1.schema.json',
            contract: 'cordisx.managed-service/v1',
            schemaVersion: 1,
            binding: resolved.source.binding,
            ...(loginTimeouts.has(resolved.key) ? { authenticationTimeoutMs: loginTimeouts.get(resolved.key) } : {}),
            capabilities: {
              logout: typeof resolved.source.logout === 'function',
              readCatalog: typeof resolved.source.readCatalog === 'function',
              accountControl: [
                resolved.source.readAccounts,
                resolved.source.toggleAccount,
                resolved.source.startOAuth,
                resolved.source.pollOAuth,
                resolved.source.cancelOAuth,
              ].every(value => typeof value === 'function'),
            },
          },
        })
      }
      if (request.operation === 'snapshot') return clone(await resolved.source.snapshot())
      if (request.operation === 'authenticate') return clone(await resolved.source.authenticate(request.request))
      if (request.operation === 'logout') {
        return clone(await resolved.source.logout(request.request))
      }
      if (request.operation === 'readCatalog') {
        if (resolved.source.readCatalog === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.readCatalog())
      }
      if (request.operation === 'readAccounts') {
        if (resolved.source.readAccounts === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.readAccounts())
      }
      if (request.operation === 'toggleAccount') {
        if (resolved.source.toggleAccount === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.toggleAccount(request.request))
      }
      if (request.operation === 'startOAuth') {
        if (resolved.source.startOAuth === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.startOAuth(request.request))
      }
      if (request.operation === 'pollOAuth') {
        if (resolved.source.pollOAuth === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.pollOAuth(request.sessionId))
      }
      if (request.operation === 'cancelOAuth') {
        if (resolved.source.cancelOAuth === undefined) throw new Error('managed service UI operation is unsupported')
        return clone(await resolved.source.cancelOAuth(request.request))
      }
      if (request.operation === 'subscribe') {
        const result = await resolved.source.subscribe(request.afterSequence)
        if (result.status !== 'subscribed') return clone(result)
        const subscriptionId = result.subscription.descriptor.subscriptionId
        if (
          !OPAQUE_ID.test(subscriptionId) || subscriptions.has(subscriptionId)
          || closedSubscriptions.has(subscriptionId)
        ) {
          await result.subscription.unsubscribe().catch(() => undefined)
          throw new Error('managed service UI subscription id is invalid or duplicated')
        }
        if (!bindingEqual(result.subscription.descriptor.binding, resolved.source.binding)) {
          await result.subscription.unsubscribe().catch(() => undefined)
          throw new Error('managed service UI subscription binding is stale')
        }
        subscriptions.set(subscriptionId, {
          ownerKey: ownerKey(owner),
          serviceKey: resolved.key,
          source: resolved.source,
          subscription: result.subscription,
          pages: result.subscription.pages[Symbol.asyncIterator](),
        })
        void result.subscription.closed.then(closed => {
          if (subscriptions.get(subscriptionId)?.subscription === result.subscription) {
            subscriptions.delete(subscriptionId)
          }
          closedSubscriptions.set(subscriptionId, clone(closed))
        }, () => {
          if (subscriptions.get(subscriptionId)?.subscription === result.subscription) {
            subscriptions.delete(subscriptionId)
          }
        })
        return clone({ status: 'subscribed', subscription: result.subscription.descriptor })
      }
      const state = subscriptions.get(request.subscriptionId)
      const priorClosed = closedSubscriptions.get(request.subscriptionId)
      if (state === undefined) {
        if (priorClosed !== undefined && (request.operation === 'closed' || request.operation === 'unsubscribe')) {
          return clone(priorClosed)
        }
        throw new Error('managed service UI subscription is unavailable')
      }
      if (
        state.ownerKey !== ownerKey(owner) || state.serviceKey !== resolved.key || state.source !== resolved.source
        || !bindingEqual(state.subscription.descriptor.binding, request.binding)
      ) throw new Error('managed service UI subscription is outside the current owner binding')
      if (request.operation === 'unsubscribe') return await unsubscribe(request.subscriptionId)
      if (request.operation === 'closed') return clone(await state.subscription.closed)
      const page = await state.pages.next()
      if (!page.done) return clone({ status: 'page', page: page.value })
      subscriptions.delete(request.subscriptionId)
      const closed = clone(await state.subscription.closed)
      closedSubscriptions.set(request.subscriptionId, closed)
      return { status: 'closed', closed }
    },
    async disposeOwner(owner) {
      const key = ownerKey(owner)
      for (const service of services.keys()) {
        if (service.startsWith(`${key}\u0000`)) services.delete(service)
      }
      const owned = [...subscriptions.entries()].filter(([, state]) => state.ownerKey === key).map(([id]) => id)
      await Promise.allSettled(owned.map(async subscriptionId => await unsubscribe(subscriptionId)))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.allSettled([...subscriptions.keys()].map(async subscriptionId => await unsubscribe(subscriptionId)))
      services.clear()
    },
  }
  return handler
}
