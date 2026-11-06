import { ManagedServiceWebEntryRPC, type ManagedServiceWebEntryRPCRequest } from './managed-service-web-entry-rpc.js'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'
import { managedServiceUIBindingEqual as bindingEqual } from './managed-service-ui-binding.js'
export { parseManagedServiceUIBindingRequest } from './managed-service-ui-request.js'
import { createStartupHostUIBridgeHandler } from './startup-host-ui-rpc.js'
import type { StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import { createStartupUIRPC, type StartupUIObserverBinding, type StartupUIRequest } from './startup-ui-rpc.js'
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
  readonly webEntry?: ManagedServiceWebEntryReader
}

export type ManagedServiceUIBindingRequest =
  | StartupUIRequest
  | ManagedServiceWebEntryRPCRequest
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
  readonly hostStartup?: ReturnType<typeof createStartupHostUIBridgeHandler>
  handle(owner: ManagedServiceUIOwner, request: ManagedServiceUIBindingRequest): Promise<unknown>
  replaceServices?(owner: ManagedServiceUIOwner, services: readonly ManagedServiceUISourceBinding[]): Promise<void>
  disposeOwner(owner: ManagedServiceUIOwner): Promise<void>
  dispose(): Promise<void>
}

/** Factory-produced broker supports binding replacement; legacy wrappers need not implement it. */
export interface MutableManagedServiceUIBridgeHandler extends ManagedServiceUIBridgeHandler {
  replaceServices(owner: ManagedServiceUIOwner, services: readonly ManagedServiceUISourceBinding[]): Promise<void>
}

function validateLocalId(value: string, label: string): void {
  if (!LOCAL_ID.test(value)) throw new Error(`${label} is invalid`)
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
  readonly hostStartup?: { readonly token: string; readonly observer: StartupObserverV1 }
  readonly declaredServices?: readonly (ManagedServiceUIOwner & { readonly serviceId: string })[]
  readonly startupObservers?: readonly StartupUIObserverBinding[]
  readonly readNativeProviders?: () => Promise<readonly unknown[]>
}): MutableManagedServiceUIBridgeHandler {
  const hostStartup = input.hostStartup === undefined
    ? undefined
    : createStartupHostUIBridgeHandler({
      ...input.hostStartup,
      profileId: input.profileId,
      generation: input.generation,
    })
  const startup = createStartupUIRPC(input.startupObservers ?? [])
  const webEntries = new ManagedServiceWebEntryRPC(input.services)
  const services = new Map<string, ManagedServiceSourceV1>()
  const declaredServices = new Set(
    (input.declaredServices ?? input.services).map(service => serviceKey(service, service.serviceId)),
  )
  const loginTimeouts = new Map<string, number>()
  for (const service of input.services) {
    validateLocalId(service.pluginId, 'managed service UI source plugin id')
    validateLocalId(service.serviceId, 'managed service UI source service id')
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
  const ownerRevisions = new Map<string, number>()
  const revokedOwners = new Set<string>()

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
  const handler: MutableManagedServiceUIBridgeHandler = {
    token: input.token,
    profileId: input.profileId,
    generation: input.generation,
    ...(hostStartup ? { hostStartup } : {}),
    async handle(owner, request) {
      if (request.operation === 'readWebEntry' || request.operation === 'cancelWebEntry') {
        return clone(await webEntries.handle(owner, request))
      }
      if (
        request.operation === 'startupRead' || request.operation === 'startupSubscribe'
        || request.operation === 'startupNext' || request.operation === 'startupClose'
      ) {
        return clone(await startup.handle(owner, request))
      }
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
      if (
        request.operation === 'get' && !disposed && !services.has(serviceKey(owner, request.serviceId))
        && declaredServices.has(serviceKey(owner, request.serviceId))
      ) {
        return { status: 'unavailable', code: 'disposed', message: 'binding-unavailable' }
      }
      if (!('serviceId' in request)) throw new Error('managed service UI operation is invalid')
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
            ...(webEntries.descriptor(owner, request.serviceId) === undefined ? {} : {
              webEntry: webEntries.descriptor(owner, request.serviceId),
            }),
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
    async replaceServices(owner, replacements) {
      if (disposed) throw new Error('managed service UI bridge is disposed')
      if (revokedOwners.has(ownerKey(owner))) throw new Error('managed service UI owner was revoked')
      // Validate the complete candidate before retiring the old binding. No operation is replayed.
      const candidate = createManagedServiceUIBridgeHandler({
        token: input.token,
        profileId: input.profileId,
        generation: input.generation,
        services: replacements,
      })
      await candidate.dispose()
      if (disposed || revokedOwners.has(ownerKey(owner))) throw new Error('managed service UI owner was revoked')
      if (replacements.some(service => ownerKey(service) !== ownerKey(owner))) {
        throw new Error('replacement owner mismatch')
      }
      const key = ownerKey(owner)
      const revision = (ownerRevisions.get(key) ?? 0) + 1
      ownerRevisions.set(key, revision)
      webEntries.replace(owner, [])
      for (const service of services.keys()) if (service.startsWith(`${key}\u0000`)) services.delete(service)
      const owned = [...subscriptions.entries()].filter(([, state]) => state.ownerKey === key).map(([id]) => id)
      await Promise.allSettled(owned.map(id => unsubscribe(id)))
      if (disposed || ownerRevisions.get(key) !== revision) throw new Error('managed service UI owner was replaced')
      webEntries.replace(owner, replacements)
      for (const service of replacements) {
        const serviceId = serviceKey(owner, service.serviceId)
        services.set(serviceId, service.source)
        declaredServices.add(serviceId)
        if (service.loginTimeoutMs === undefined) loginTimeouts.delete(serviceId)
        else loginTimeouts.set(serviceId, service.loginTimeoutMs)
      }
    },
    async disposeOwner(owner) {
      webEntries.disposeOwner(owner)
      startup.disposeOwner(owner)
      const key = ownerKey(owner)
      revokedOwners.add(key)
      ownerRevisions.set(key, (ownerRevisions.get(key) ?? 0) + 1)
      for (const service of declaredServices) if (service.startsWith(`${key}\u0000`)) declaredServices.delete(service)
      for (const service of services.keys()) {
        if (service.startsWith(`${key}\u0000`)) services.delete(service)
      }
      const owned = [...subscriptions.entries()].filter(([, state]) => state.ownerKey === key).map(([id]) => id)
      await Promise.allSettled(owned.map(async subscriptionId => await unsubscribe(subscriptionId)))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      webEntries.dispose()
      startup.dispose()
      hostStartup?.dispose()
      await Promise.allSettled([...subscriptions.keys()].map(async subscriptionId => await unsubscribe(subscriptionId)))
      services.clear()
    },
  }
  const handleCurrent = handler.handle
  handler.handle = async (owner, request) => {
    const revision = ownerRevisions.get(ownerKey(owner)) ?? 0
    const result = await handleCurrent(owner, request)
    if (
      request.operation !== 'readWebEntry' && request.operation !== 'cancelWebEntry'
      && (request.operation === 'get' || 'binding' in request)
      && (disposed || revision !== (ownerRevisions.get(ownerKey(owner)) ?? 0))
    ) {
      throw new Error('managed service UI binding was replaced')
    }
    return result
  }
  return handler
}
