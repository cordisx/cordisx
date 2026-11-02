import { createBrowserStartupObserver, StartupObservationTerminated } from './startup-ui-observer.js'
import type {
  ManagedServiceBindingV1,
  ManagedServiceCliProxyAccountControlV1,
  ManagedServiceCliProxyAccountToggleRequestV1,
  ManagedServiceCliProxyOAuthCancelRequestV1,
  ManagedServiceCliProxyOAuthStartRequestV1,
  ManagedServiceLoginRequestV1,
  ManagedServiceLogoutRequestV1,
  ManagedServiceSubscriptionClosedV1,
  ManagedServiceSubscriptionDescriptorV1,
  ManagedServiceSubscriptionPageV1,
  ManagedServiceSubscriptionV1,
  ManagedServiceUIGetResultV1,
  ManagedServiceUIRegistryV1,
  ManagedServiceV1,
} from '@cordisx/protocol/managed-service-ui/v1'
import type { StartupUIPrincipal } from '../launcher/startup-ui-rpc.js'
import type { ManagedServiceUIBindingRequest, ManagedServiceUIOwner } from '../launcher/managed-service-ui-rpc.js'
import type { NativeProviderProjection } from './model-providers.js'

const MANAGED_SERVICE_UI_BINDING = '__cordisxManagedServiceUIRequestV1'
const MANAGED_SERVICE_UI_RECEIVER = '__cordisxManagedServiceUIReceiveV1'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_AUTHENTICATION_TIMEOUT_MS = 300_000
const AUTHENTICATION_RESPONSE_GRACE_MS = REQUEST_TIMEOUT_MS

type Binding = (payload: string) => void
interface Pending {
  readonly observation: boolean
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup?: () => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

export interface ManagedServiceUICapability extends ManagedServiceUIOwner {
  readonly token: string
  readonly startup?: boolean
}

interface AvailableServiceDescriptor {
  readonly $schema: ManagedServiceV1['$schema']
  readonly contract: ManagedServiceV1['contract']
  readonly schemaVersion: 1
  readonly binding: ManagedServiceBindingV1
  readonly authenticationTimeoutMs?: number
  readonly capabilities: {
    readonly logout: boolean
    readonly readCatalog: boolean
    readonly accountControl: boolean
  }
}

declare global {
  var __cordisxManagedServiceUIRequestV1: Binding | undefined
  var __cordisxManagedServiceUIReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

function ownerKey(owner: StartupUIPrincipal): string {
  if ('kind' in owner) return JSON.stringify(['host', owner.hostGeneration])
  return `${owner.pluginId}\u0000${owner.pluginGeneration}`
}

function nextRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `managed-service-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Renderer transport. Only owner-bound registries receive a capability token. */
export class BrowserManagedServiceUIBridge {
  private readonly pending = new Map<string, Pending>()
  private readonly capabilities = new Map<
    string,
    { token: string; startup?: boolean; state: 'active' | 'staged' | 'retiring' }
  >()
  private readonly transactions = new Map<string, {
    readonly affectedPluginIds: ReadonlySet<string>
    readonly candidateKeys: ReadonlySet<string>
    published: boolean
  }>()
  private readonly revokedStartupOwners = new Set<string>()
  private readonly startupObservers = new Map<string, ReturnType<typeof createBrowserStartupObserver>>()
  private closed = false
  private disposing = false
  private transportControlSequence = 0

  private constructor(
    capabilities: readonly ManagedServiceUICapability[],
    private readonly profileId: string,
    private readonly generation: string,
    hostCapability?: { readonly token: string },
  ) {
    for (const capability of capabilities) {
      this.capabilities.set(ownerKey(capability), {
        token: capability.token,
        ...(capability.startup ? { startup: true } : {}),
        state: 'active',
      })
    }
    if (hostCapability) {
      this.capabilities.set(ownerKey({ kind: 'host', hostGeneration: generation }), {
        token: hostCapability.token,
        startup: true,
        state: 'active',
      })
    }
    globalThis[MANAGED_SERVICE_UI_RECEIVER] = this.receive
  }

  static connect(
    capabilities: readonly ManagedServiceUICapability[],
    profileId: string,
    generation: string,
    hostCapability?: { readonly token: string },
  ): BrowserManagedServiceUIBridge {
    return new BrowserManagedServiceUIBridge(capabilities, profileId, generation, hostCapability)
  }

  bind(owner: ManagedServiceUIOwner): ManagedServiceUIRegistryV1 | undefined {
    if (this.closed || this.disposing) return undefined
    const capability = this.capabilities.get(ownerKey(owner))
    if (capability === undefined) return undefined
    return new BrowserManagedServiceUIRegistry(this, owner, capability.token)
  }

  bindHostStartup() {
    return this.startupFor({ kind: 'host', hostGeneration: this.generation })
  }

  bindStartup(owner: ManagedServiceUIOwner) {
    return this.startupFor(owner)
  }

  private startupFor(owner: StartupUIPrincipal) {
    const key = ownerKey(owner)
    const capability = this.capabilities.get(key)
    if (!capability?.startup || this.closed || this.disposing || this.revokedStartupOwners.has(key)) return undefined
    let binding = this.startupObservers.get(key)
    if (!binding) {
      binding = createBrowserStartupObserver(async (request, signal) => {
        const result = await this.request(owner, capability.token, request, REQUEST_TIMEOUT_MS, signal)
        const terminal = result as { status?: string; reason?: string } | null
        if (
          terminal?.status === 'startup-terminated'
          && (terminal.reason === 'scope-revoked' || terminal.reason === 'host-replaced')
        ) {
          throw new StartupObservationTerminated(terminal.reason)
        }
        return result
      })
      this.startupObservers.set(key, binding)
    }
    return binding.observer
  }

  disposeStartupOwner(owner: ManagedServiceUIOwner): void {
    const key = ownerKey(owner)
    this.revokedStartupOwners.add(key)
    this.startupObservers.get(key)?.dispose()
    this.startupObservers.delete(key)
  }

  private removeCapability(key: string): void {
    this.startupObservers.get(key)?.dispose()
    this.startupObservers.delete(key)
    this.capabilities.delete(key)
  }

  stage(
    transactionId: string,
    affectedPluginIds: readonly string[],
    capabilities: readonly ManagedServiceUICapability[],
  ): void {
    if (this.closed || this.disposing) throw new Error('managed service UI bridge is unavailable')
    if (this.transactions.has(transactionId)) {
      throw new Error('managed service UI capability transaction already exists')
    }
    const candidateKeys = new Set<string>()
    for (const capability of capabilities) {
      const key = ownerKey(capability)
      if (this.capabilities.has(key)) throw new Error('managed service UI capability generation already exists')
      candidateKeys.add(key)
      this.capabilities.set(key, {
        token: capability.token,
        ...(capability.startup ? { startup: true } : {}),
        state: 'staged',
      })
    }
    this.transactions.set(transactionId, {
      affectedPluginIds: new Set(affectedPluginIds),
      candidateKeys,
      published: false,
    })
  }

  publish(transactionId: string): void {
    if (this.closed || this.disposing) throw new Error('managed service UI bridge is unavailable')
    const transaction = this.transactions.get(transactionId)
    if (transaction === undefined) throw new Error('managed service UI capability transaction is unavailable')
    if (transaction.published) return
    for (const [key, capability] of this.capabilities) {
      const pluginId = key.split('\u0000', 1)[0]!
      if (transaction.affectedPluginIds.has(pluginId) && !transaction.candidateKeys.has(key)) {
        capability.state = 'retiring'
      }
    }
    for (const key of transaction.candidateKeys) this.capabilities.get(key)!.state = 'active'
    transaction.published = true
  }

  complete(transactionId: string): void {
    const transaction = this.transactions.get(transactionId)
    if (transaction === undefined) return
    if (!transaction.published) throw new Error('managed service UI capability transaction is not published')
    for (const [key, capability] of this.capabilities) {
      if (capability.state === 'retiring' && transaction.affectedPluginIds.has(key.split('\u0000', 1)[0]!)) {
        this.removeCapability(key)
      }
    }
    this.transactions.delete(transactionId)
  }

  rollback(transactionId: string): void {
    const transaction = this.transactions.get(transactionId)
    if (transaction === undefined) return
    if (transaction.published) {
      for (const key of transaction.candidateKeys) this.capabilities.get(key)!.state = 'retiring'
      for (const [key, capability] of this.capabilities) {
        if (transaction.affectedPluginIds.has(key.split('\u0000', 1)[0]!) && capability.state === 'retiring') {
          if (!transaction.candidateKeys.has(key)) capability.state = 'active'
        }
      }
      return
    }
    for (const key of transaction.candidateKeys) this.removeCapability(key)
    this.transactions.delete(transactionId)
  }

  completeRollback(transactionId: string): void {
    const transaction = this.transactions.get(transactionId)
    if (transaction === undefined) return
    for (const key of transaction.candidateKeys) this.removeCapability(key)
    this.transactions.delete(transactionId)
  }

  async nativeProviders(): Promise<readonly NativeProviderProjection[]> {
    const catalogs = await Promise.all([...this.capabilities.entries()].flatMap(([key, capability]) => {
      if (capability.state !== 'active' || key === ownerKey({ kind: 'host', hostGeneration: this.generation })) {
        return []
      }
      const [pluginId, pluginGeneration] = key.split('\u0000') as [string, string]
      return [this.request({ pluginId, pluginGeneration }, capability.token, {
        requestId: nextRequestId(),
        operation: 'nativeProviders',
        serviceId: 'catalog',
      }) as Promise<readonly NativeProviderProjection[]>]
    }))
    const providers = new Map<string, NativeProviderProjection>()
    for (const provider of catalogs.flat()) {
      if (providers.has(provider.providerId)) {
        throw new Error(`native model provider ${provider.providerId} is duplicated`)
      }
      providers.set(provider.providerId, provider)
    }
    return Object.freeze([...providers.values()])
  }

  dispose(): void {
    if (this.closed || this.disposing) return
    this.disposing = true
    // Dispatch the owner-bound close requests while the transport can still send them.
    for (const observer of this.startupObservers.values()) observer.dispose('host-replaced')
    this.startupObservers.clear()
    this.closed = true
    if (globalThis[MANAGED_SERVICE_UI_RECEIVER] === this.receive) {
      globalThis[MANAGED_SERVICE_UI_RECEIVER] = undefined
    }
    for (const pending of this.pending.values()) {
      pending.cleanup?.()
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(new Error('managed service UI bridge was disposed'))
    }
    this.pending.clear()
  }

  /** Host/CDP transport owner signals a real disconnect; idle observation never expires. */
  transportDisconnected(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.observation) continue
      pending.cleanup?.()
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('startup transport disconnected'))
    }
  }

  async request(
    owner: StartupUIPrincipal,
    token: string,
    request: ManagedServiceUIBindingRequest,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const capability = this.capabilities.get(ownerKey(owner))
    if (signal?.aborted) throw new Error('startup request was aborted')
    if (this.closed || (this.disposing && request.operation !== 'startupClose') || capability?.token !== token) {
      throw new Error('managed service UI bridge is unavailable')
    }
    const binding = globalThis[MANAGED_SERVICE_UI_BINDING]
    if (typeof binding !== 'function') throw new Error('managed service UI bridge is unavailable')
    return await new Promise((resolve, reject) => {
      const timer =
        request.operation === 'next' || request.operation === 'closed' || request.operation === 'startupNext'
          ? undefined
          : setTimeout(() => {
            this.pending.get(request.requestId)?.cleanup?.()
            this.pending.delete(request.requestId)
            reject(new Error('managed service UI bridge request timed out'))
          }, timeoutMs)
      const abort = (): void => {
        cleanup()
        this.pending.delete(request.requestId)
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(new Error('startup request was aborted'))
      }
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(request.requestId, {
        resolve,
        reject,
        timer,
        cleanup,
        observation: request.operation.startsWith('startup'),
      })
      try {
        const payload: Record<string, unknown> = {
          version: 1,
          token,
          requestId: request.requestId,
          operation: request.operation,
          scope: {
            profileId: this.profileId,
            runtimeGeneration: this.generation,
            ...('kind' in owner ? {} : { pluginGeneration: owner.pluginGeneration }),
          },
          ...('serviceId' in request ? { serviceId: request.serviceId } : {}),
        }
        if ('binding' in request) payload.binding = request.binding
        if (request.operation === 'startupSubscribe') {
          payload.subscriptionId = request.subscriptionId
          if (request.after !== undefined) payload.after = request.after
        }
        if (request.operation === 'startupNext' || request.operation === 'startupClose') {
          payload.subscriptionId = request.subscriptionId
        }
        if (request.operation === 'subscribe') payload.afterSequence = request.afterSequence
        if (
          request.operation === 'next' || request.operation === 'pull' || request.operation === 'closed'
          || request.operation === 'unsubscribe'
        ) payload.subscriptionId = request.subscriptionId
        if (
          request.operation === 'authenticate' || request.operation === 'logout'
          || request.operation === 'toggleAccount'
          || request.operation === 'startOAuth' || request.operation === 'cancelOAuth'
        ) payload.request = request.request
        if (request.operation === 'pollOAuth') payload.sessionId = request.sessionId
        binding(JSON.stringify(payload))
      } catch (error) {
        cleanup()
        this.pending.delete(request.requestId)
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      }
    })
  }

  private readonly receive = (payload: string): void => {
    let response: { requestId?: unknown; ok?: unknown; value?: unknown; code?: unknown }
    try {
      response = JSON.parse(payload) as typeof response
    } catch {
      return
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) return
    if (this.receiveTransportControl(response as Record<string, unknown>)) return
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    pending.cleanup?.()
    this.pending.delete(response.requestId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(clone(response.value))
    else {
      pending.reject(
        new Error(typeof response.code === 'string' ? response.code : 'managed-service-ui-unavailable'),
      )
    }
  }

  private receiveTransportControl(value: Record<string, unknown>): boolean {
    if (value.contract !== 'cordisx.startup-transport-control/v1') return false
    if (this.closed || Object.keys(value).sort().join(',') !== 'contract,phase,scope,sequence,token') return true
    const host = this.capabilities.get(ownerKey({ kind: 'host', hostGeneration: this.generation }))
    const scope = value.scope as Record<string, unknown> | undefined
    if (
      !host || value.token !== host.token || !scope || Array.isArray(scope)
      || Object.keys(scope).sort().join(',') !== 'profileId,runtimeGeneration'
      || scope.profileId !== this.profileId || scope.runtimeGeneration !== this.generation
      || !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= this.transportControlSequence
      || (value.phase !== 'disconnected' && value.phase !== 'reconnected')
    ) return true
    this.transportControlSequence = value.sequence as number
    // A recovered CDP transport cannot deliver the old pending RPC; resume from the retained cursor.
    this.transportDisconnected()
    return true
  }
}

class BrowserManagedServiceUIRegistry implements ManagedServiceUIRegistryV1 {
  constructor(
    private readonly bridge: BrowserManagedServiceUIBridge,
    private readonly owner: ManagedServiceUIOwner,
    private readonly token: string,
  ) {}

  async get(request: { readonly serviceId: string }): Promise<ManagedServiceUIGetResultV1> {
    try {
      const result = await this.bridge.request(this.owner, this.token, {
        requestId: nextRequestId(),
        operation: 'get',
        serviceId: request.serviceId,
      }) as { readonly status: 'available'; readonly service: AvailableServiceDescriptor }
      if (result.status !== 'available') return result as unknown as ManagedServiceUIGetResultV1
      return { status: 'available', service: this.service(request.serviceId, result.service) }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'disposed'
      const supported = ['stale-generation', 'service-not-declared', 'binding-replaced', 'disposed'] as const
      const unavailableCode = supported.find(candidate => candidate === code) ?? 'disposed'
      return {
        status: 'unavailable',
        code: unavailableCode,
        message: code,
      }
    }
  }

  private service(serviceId: string, descriptor: AvailableServiceDescriptor): ManagedServiceV1 {
    const invoke = async (request: ManagedServiceUIBindingRequest, timeoutMs?: number): Promise<unknown> =>
      await this.bridge.request(this.owner, this.token, request, timeoutMs)
    const authenticationActionTimeoutMs = Number.isSafeInteger(descriptor.authenticationTimeoutMs)
        && descriptor.authenticationTimeoutMs! >= 100
        && descriptor.authenticationTimeoutMs! <= MAX_AUTHENTICATION_TIMEOUT_MS
      ? descriptor.authenticationTimeoutMs
      : undefined
    const authenticationTimeoutMs = authenticationActionTimeoutMs === undefined
      ? REQUEST_TIMEOUT_MS
      : authenticationActionTimeoutMs + AUTHENTICATION_RESPONSE_GRACE_MS
    const accountControl: ManagedServiceCliProxyAccountControlV1 | undefined = descriptor.capabilities.accountControl
      ? {
        readAccounts: async () =>
          await invoke({
            requestId: nextRequestId(),
            operation: 'readAccounts',
            serviceId,
            binding: descriptor.binding,
          }) as Awaited<ReturnType<ManagedServiceCliProxyAccountControlV1['readAccounts']>>,
        toggleAccount: async (request: ManagedServiceCliProxyAccountToggleRequestV1) =>
          await invoke({
            requestId: nextRequestId(),
            operation: 'toggleAccount',
            serviceId,
            binding: descriptor.binding,
            request,
          }) as Awaited<ReturnType<ManagedServiceCliProxyAccountControlV1['toggleAccount']>>,
        startOAuth: async (request: ManagedServiceCliProxyOAuthStartRequestV1) =>
          await invoke({
            requestId: nextRequestId(),
            operation: 'startOAuth',
            serviceId,
            binding: descriptor.binding,
            request,
          }) as Awaited<ReturnType<ManagedServiceCliProxyAccountControlV1['startOAuth']>>,
        pollOAuth: async sessionId =>
          await invoke({
            requestId: nextRequestId(),
            operation: 'pollOAuth',
            serviceId,
            binding: descriptor.binding,
            sessionId,
          }) as Awaited<ReturnType<ManagedServiceCliProxyAccountControlV1['pollOAuth']>>,
        cancelOAuth: async (request: ManagedServiceCliProxyOAuthCancelRequestV1) =>
          await invoke({
            requestId: nextRequestId(),
            operation: 'cancelOAuth',
            serviceId,
            binding: descriptor.binding,
            request,
          }) as Awaited<ReturnType<ManagedServiceCliProxyAccountControlV1['cancelOAuth']>>,
      }
      : undefined
    return {
      $schema: descriptor.$schema,
      contract: descriptor.contract,
      schemaVersion: 1,
      binding: descriptor.binding,
      snapshot: async () =>
        await invoke({
          requestId: nextRequestId(),
          operation: 'snapshot',
          serviceId,
          binding: descriptor.binding,
        }) as Awaited<ReturnType<ManagedServiceV1['snapshot']>>,
      subscribe: async (afterSequence = 0) => {
        const result = await invoke({
          requestId: nextRequestId(),
          operation: 'subscribe',
          serviceId,
          binding: descriptor.binding,
          afterSequence,
        }) as
          | { readonly status: 'subscribed'; readonly subscription: ManagedServiceSubscriptionDescriptorV1 }
          | Exclude<Awaited<ReturnType<ManagedServiceV1['subscribe']>>, { readonly status: 'subscribed' }>
        if (result.status !== 'subscribed') return result
        return {
          status: 'subscribed',
          subscription: this.subscription(serviceId, descriptor.binding, result.subscription),
        }
      },
      authenticate: async (request: ManagedServiceLoginRequestV1) =>
        await invoke({
          requestId: nextRequestId(),
          operation: 'authenticate',
          serviceId,
          binding: descriptor.binding,
          request,
        }, authenticationTimeoutMs) as Awaited<ReturnType<ManagedServiceV1['authenticate']>>,
      logout: async (request: ManagedServiceLogoutRequestV1) =>
        await invoke({
          requestId: nextRequestId(),
          operation: 'logout',
          serviceId,
          binding: descriptor.binding,
          request,
        }) as Awaited<ReturnType<ManagedServiceV1['logout']>>,
      ...(descriptor.capabilities.readCatalog
        ? {
          readCatalog: async () =>
            await invoke({
              requestId: nextRequestId(),
              operation: 'readCatalog',
              serviceId,
              binding: descriptor.binding,
            }) as Awaited<ReturnType<NonNullable<ManagedServiceV1['readCatalog']>>>,
        }
        : {}),
      ...(accountControl === undefined ? {} : { accountControl }),
    } as ManagedServiceV1
  }

  private subscription(
    serviceId: string,
    binding: ManagedServiceBindingV1,
    descriptor: ManagedServiceSubscriptionDescriptorV1,
  ): ManagedServiceSubscriptionV1 {
    let resolveClosed!: (closed: ManagedServiceSubscriptionClosedV1) => void
    const closed = new Promise<ManagedServiceSubscriptionClosedV1>(resolve => {
      resolveClosed = resolve
    })
    const operation = async (name: 'next' | 'closed' | 'unsubscribe'): Promise<unknown> =>
      await this.bridge.request(this.owner, this.token, {
        requestId: nextRequestId(),
        operation: name,
        serviceId,
        binding,
        subscriptionId: descriptor.subscriptionId,
      })
    const pages: AsyncIterable<ManagedServiceSubscriptionPageV1> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const result = await operation('next') as
            | { readonly status: 'page'; readonly page: ManagedServiceSubscriptionPageV1 }
            | { readonly status: 'closed'; readonly closed: ManagedServiceSubscriptionClosedV1 }
          if (result.status === 'page') return { done: false, value: result.page }
          resolveClosed(result.closed)
          return { done: true, value: undefined }
        },
      }),
    }
    void operation('closed').then(value => resolveClosed(value as ManagedServiceSubscriptionClosedV1), () => undefined)
    return {
      descriptor,
      pages,
      closed,
      unsubscribe: async () => {
        const result = await operation('unsubscribe') as ManagedServiceSubscriptionClosedV1
        resolveClosed(result)
        return result
      },
    } as ManagedServiceSubscriptionV1
  }
}
