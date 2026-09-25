import { randomBytes } from 'node:crypto'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  ManagedServiceUICapabilityMutation,
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle-model.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import {
  createManagedServiceUIBridgeHandler,
  type ManagedServiceUIBridgeHandler,
  type ManagedServiceUIOwner,
  MAX_MANAGED_SERVICE_UI_REQUEST_BYTES,
  parseManagedServiceUIBindingRequest,
} from './managed-service-ui-rpc.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { safeDiagnosticMessage } from './diagnostic-redaction.js'

interface ManagedServiceOwnerRoute {
  readonly key: string
  readonly token: string
  readonly owner: ManagedServiceUIOwner
  readonly handler: ManagedServiceUIBridgeHandler
}

interface ManagedServiceFleet {
  readonly activation: ManagedServiceNodeActivation | undefined
  readonly routes: ReadonlyMap<string, ManagedServiceOwnerRoute>
}

interface ManagedServiceTransaction {
  readonly previous: ManagedServiceFleet
  readonly candidate: ManagedServiceFleet
  readonly newCapabilities: readonly ManagedServiceUICapabilityMutation[]
  published: boolean
}

export interface ManagedServicePluginLifecycleOptions {
  readonly runtime: PluginLifecycleRuntime
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly activate: (activation: CordisXPluginActivationRecordV1) => Promise<ManagedServiceNodeActivation | undefined>
  readonly createToken?: () => string
}

export interface ManagedServiceNativeActivation
  extends Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>
{
  subscribeNativeProviders(listener: () => void): () => void
}

function ownerKey(owner: ManagedServiceUIOwner): string {
  return `${owner.pluginId}\u0000${owner.pluginGeneration}`
}

function safeMessage(error: unknown): string {
  return safeDiagnosticMessage(error)
}

/** Adds managed-backend fleets to the durable plugin generation transaction. */
export class ManagedServicePluginLifecycleRuntime implements PluginLifecycleRuntime {
  private readonly runtime: PluginLifecycleRuntime
  private readonly createToken: () => string
  private readonly routesByToken = new Map<string, ManagedServiceOwnerRoute>()
  private readonly transactions = new Map<string, ManagedServiceTransaction>()
  private readonly nativeProviderListeners = new Set<() => void>()
  private active: ManagedServiceFleet | undefined

  constructor(private readonly options: ManagedServicePluginLifecycleOptions) {
    this.runtime = options.runtime
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('hex'))
  }

  async initialize(activation: CordisXPluginActivationRecordV1): Promise<void> {
    if (this.active !== undefined) throw new Error('managed service lifecycle is already initialized')
    const fleet = await this.createFleet(activation)
    this.active = fleet
    for (const route of fleet.routes.values()) this.routesByToken.set(route.token, route)
  }

  capabilities(): readonly ManagedServiceUICapabilityMutation[] {
    return Object.freeze([...this.requireActive().routes.values()].map(route =>
      Object.freeze({
        ...route.owner,
        token: route.token,
      })
    ))
  }

  readonly managedServiceUI = {
    handleBindingValue: async (value: string): Promise<Record<string, unknown>> => await this.handleBindingValue(value),
  }

  nativeActivation(): ManagedServiceNativeActivation {
    const owner = this
    return Object.freeze({
      get nativeProviderIds(): readonly string[] {
        return owner.requireActive().activation?.nativeProviderIds ?? []
      },
      prepareNativeConnection(providerId: string) {
        const activation = owner.requireActive().activation
        if (activation === undefined) throw new Error('native managed provider activation is unavailable')
        return activation.prepareNativeConnection(providerId)
      },
      subscribeNativeProviders(listener: () => void) {
        owner.nativeProviderListeners.add(listener)
        return () => owner.nativeProviderListeners.delete(listener)
      },
    })
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.runtime.prepare === undefined) throw new Error('plugin lifecycle prepare is unavailable')
    return this.runtime.prepare(transactionId)
  }

  async prepareBrowserGraph(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence> {
    if (this.runtime.prepareBrowserGraph === undefined) throw new Error('browser graph preparation is unavailable')
    return await this.runtime.prepareBrowserGraph(transactionId, active)
  }

  async stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation> {
    if (this.transactions.has(mutation.transactionId)) {
      throw new Error('managed service lifecycle transaction already exists')
    }
    const previous = this.requireActive()
    let activationFailure: unknown
    const candidate = await this.createFleet(mutation.candidate, previous).catch(error => {
      activationFailure = error
      return { activation: undefined, routes: new Map() }
    })
    const newCapabilities = [...candidate.routes.values()].flatMap(route =>
      previous.routes.has(route.key) ? [] : [{ ...route.owner, token: route.token }]
    )
    const transaction: ManagedServiceTransaction = {
      previous,
      candidate,
      newCapabilities: Object.freeze(newCapabilities),
      published: false,
    }
    this.transactions.set(mutation.transactionId, transaction)
    for (const route of candidate.routes.values()) {
      if (!previous.routes.has(route.key)) this.routesByToken.set(route.token, route)
    }
    const staged = await this.runtime.stage({
      ...mutation,
      managedServiceUICapabilities: transaction.newCapabilities,
    }).catch(error => {
      if (activationFailure !== undefined) {
        throw new Error(`managed service candidate activation failed: ${safeMessage(activationFailure)}`)
      }
      throw error
    })
    if (activationFailure !== undefined) {
      throw new Error(`managed service candidate activation failed: ${safeMessage(activationFailure)}`)
    }
    return staged
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const transaction = this.transaction(transactionId)
    for (const route of transaction.candidate.routes.values()) this.routesByToken.set(route.token, route)
    this.active = transaction.candidate
    this.changedNativeProviders()
    transaction.published = true
    if (this.runtime.publish === undefined) throw new Error('plugin lifecycle publication is unavailable')
    return await this.runtime.publish(transactionId)
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.complete === undefined) throw new Error('plugin lifecycle cleanup is unavailable')
    return await this.runtime.complete(transactionId)
  }

  async finalize(transactionId: string): Promise<void> {
    const transaction = this.transaction(transactionId)
    await this.runtime.finalize?.(transactionId)
    await this.disposeFleet(transaction.previous)
    for (const route of transaction.previous.routes.values()) {
      if (!transaction.candidate.routes.has(route.key) && this.routesByToken.get(route.token) === route) {
        this.routesByToken.delete(route.token)
      }
    }
    this.transactions.delete(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.rollback === undefined) throw new Error('plugin lifecycle rollback is unavailable')
    const observation = await this.runtime.rollback(transactionId)
    const transaction = this.transactions.get(transactionId)
    if (transaction !== undefined) await this.rollbackManaged(transactionId, transaction)
    return observation
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (this.runtime.recoverRollback === undefined) throw new Error('plugin lifecycle recovery is unavailable')
    return await this.runtime.recoverRollback(plan)
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    await this.runtime.adoptRecoveredActivation?.(active, registryEpoch)
  }

  async commit(transactionId: string): Promise<void> {
    const transaction = this.transaction(transactionId)
    for (const route of transaction.candidate.routes.values()) this.routesByToken.set(route.token, route)
    this.active = transaction.candidate
    this.changedNativeProviders()
    transaction.published = true
    await this.runtime.commit(transactionId)
    await this.disposeFleet(transaction.previous)
    this.transactions.delete(transactionId)
  }

  async abort(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId)
    await this.runtime.abort(transactionId)
    if (transaction !== undefined) await this.rollbackManaged(transactionId, transaction)
  }

  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    await this.runtime.reload(input)
  }

  terminal(error: unknown): void {
    this.runtime.terminal?.(error)
  }

  async dispose(): Promise<void> {
    const fleets = new Set<ManagedServiceFleet>()
    if (this.active !== undefined) fleets.add(this.active)
    for (const transaction of this.transactions.values()) {
      fleets.add(transaction.previous)
      fleets.add(transaction.candidate)
    }
    this.transactions.clear()
    this.routesByToken.clear()
    await Promise.allSettled([...fleets].map(async fleet => await this.disposeFleet(fleet)))
    this.active = undefined
    this.changedNativeProviders()
    this.nativeProviderListeners.clear()
  }

  private async createFleet(
    record: CordisXPluginActivationRecordV1,
    previous?: ManagedServiceFleet,
  ): Promise<ManagedServiceFleet> {
    const activation = await this.options.activate(record)
    if (activation === undefined) return { activation: undefined, routes: new Map() }
    const routes = new Map<string, ManagedServiceOwnerRoute>()
    const readNativeProviders = nativeModelProviderCatalog(activation)
    const sourcesByOwner = new Map<string, typeof activation.sources>()
    for (const source of activation.sources) {
      const owner = { pluginId: source.pluginId, pluginGeneration: source.pluginGeneration }
      const key = ownerKey(owner)
      const sources = sourcesByOwner.get(key) ?? []
      sourcesByOwner.set(key, [...sources, source])
    }
    try {
      for (const [key, sources] of sourcesByOwner) {
        const owner = { pluginId: sources[0]!.pluginId, pluginGeneration: sources[0]!.pluginGeneration }
        const token = previous?.routes.get(key)?.token ?? this.uniqueToken()
        const handler = createManagedServiceUIBridgeHandler({
          token,
          profileId: this.options.profileId,
          generation: this.options.runtimeGeneration,
          readNativeProviders,
          services: sources,
        })
        routes.set(key, { key, token, owner, handler })
      }
      return { activation, routes }
    } catch (error) {
      await Promise.allSettled([...routes.values()].map(async route => await route.handler.dispose()))
      await activation.dispose().catch(() => undefined)
      throw error
    }
  }

  private uniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.createToken()
      if (token.length >= 32 && !this.routesByToken.has(token)) return token
    }
    throw new Error('managed service UI token generation failed')
  }

  private async handleBindingValue(value: string): Promise<Record<string, unknown>> {
    let requestId = 'invalid'
    try {
      if (Buffer.byteLength(value) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) {
        throw new Error('managed service UI request exceeds maximum size')
      }
      const envelope = JSON.parse(value) as { readonly requestId?: unknown; readonly token?: unknown }
      if (typeof envelope.requestId === 'string') requestId = envelope.requestId
      if (typeof envelope.token !== 'string') throw new Error('managed service UI request is not authorized')
      const route = this.routesByToken.get(envelope.token)
      if (route === undefined) throw new Error('managed service UI request is not authorized')
      const request = parseManagedServiceUIBindingRequest(envelope, route.handler, route.owner)
      return { requestId, ok: true, value: await route.handler.handle(route.owner, request) }
    } catch (error) {
      const message = safeMessage(error)
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

  private async rollbackManaged(
    transactionId: string,
    transaction: ManagedServiceTransaction,
  ): Promise<void> {
    for (const route of transaction.previous.routes.values()) this.routesByToken.set(route.token, route)
    for (const route of transaction.candidate.routes.values()) {
      if (!transaction.previous.routes.has(route.key) && this.routesByToken.get(route.token) === route) {
        this.routesByToken.delete(route.token)
      }
    }
    if (transaction.published) {
      this.active = transaction.previous
      this.changedNativeProviders()
    }
    await this.disposeFleet(transaction.candidate)
    this.transactions.delete(transactionId)
  }

  private async disposeFleet(fleet: ManagedServiceFleet): Promise<void> {
    await Promise.allSettled([...fleet.routes.values()].map(async route => await route.handler.dispose()))
    await fleet.activation?.dispose()
  }

  private requireActive(): ManagedServiceFleet {
    if (this.active === undefined) throw new Error('managed service lifecycle is not initialized')
    return this.active
  }

  private changedNativeProviders(): void {
    for (const listener of this.nativeProviderListeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }

  private transaction(transactionId: string): ManagedServiceTransaction {
    const transaction = this.transactions.get(transactionId)
    if (transaction === undefined) throw new Error('managed service lifecycle transaction is unavailable')
    return transaction
  }
}
