import { ManagedConsoleBrowserLaunch } from './managed-console-browser-launch.js'
import { ManagerServiceAuth, type ManagerServiceAuthOperation } from './manager-service-auth.js'
import type { NativeManagedConsoleAdapter } from '../shortcuts/managed-console-agent.js'
import { managedServiceLiveHandler } from './managed-service-live-handler.js'
import {
  captureManagedServiceUISources,
  type ManagedServiceUISourceSnapshot,
  observeManagedServiceUISources,
  sameManagedServiceUISources,
} from './managed-service-ui-fence-sources.js'
import { ManagedServiceStartupTombstones } from './managed-service-startup-tombstones.js'
import { ManagedServiceEndpointReservations } from './managed-service-endpoint-reservations.js'
import type { StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import { ManagedServiceStartupAuthority } from './managed-service-startup-authority.js'
import type { StartupPluginAdmission } from './managed-service-startup-admission.js'
import {
  type ManagedServiceStartupSession,
  readStartupAdmissions,
  startupRecordOwners,
} from './managed-service-startup-lifecycle.js'
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
import {
  managedServiceFleetActivation,
  type ManagedServiceFleetLease,
  managedServiceLeases,
  unchangedManagedServiceLease,
} from './managed-service-fleet.js'
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
  readonly startup?: true
  readonly handler: ManagedServiceUIBridgeHandler
}

interface ManagedServiceFleet {
  readonly leases: readonly ManagedServiceFleetLease[]
  readonly activation: ManagedServiceNodeActivation | undefined
  readonly record?: CordisXPluginActivationRecordV1
  readonly routes: ReadonlyMap<string, ManagedServiceOwnerRoute>
}

interface ManagedServiceTransaction {
  readonly previous: ManagedServiceFleet
  readonly candidate: ManagedServiceFleet
  readonly newCapabilities: readonly ManagedServiceUICapabilityMutation[]
  published: boolean
}

interface ManagedServiceUIRecovery {
  readonly stamp: number
  readonly registryEpoch: number
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly plugins: string
}

export interface ManagedServicePluginLifecycleOptions {
  readonly runtime: PluginLifecycleRuntime
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly homeDir?: string
  readonly validateInitialActivation?: (record: CordisXPluginActivationRecordV1) => Promise<void>
  readonly readStartupAdmissions?: (
    record: CordisXPluginActivationRecordV1,
  ) => Promise<readonly StartupPluginAdmission[]>
  readonly activate: (
    activation: CordisXPluginActivationRecordV1,
    options: {
      readonly signal?: AbortSignal
      readonly endpointReservations?: ManagedServiceEndpointReservations
      readonly startupAuthority?: ManagedServiceStartupAuthority
      readonly isolateStartupFailures: boolean
      readonly pluginIds: readonly string[]
      readonly reservedLoopbackPorts?: readonly number[]
      readonly reservedServiceKeys?: readonly string[]
    },
  ) => Promise<ManagedServiceNodeActivation | undefined>
  readonly createToken?: () => string
  readonly nativeManagedConsole?: () => NativeManagedConsoleAdapter | undefined
}

export interface ManagedServiceNativeActivation
  extends Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>
{
  readonly startup: ManagedServiceStartupAuthority
  readonly startupObserver: StartupObserverV1
  readonly revision: number
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
  private stopNativeProviders: (() => void) | undefined
  private stopUISources: (() => void) | undefined
  private nativeRevision = 0
  private mutation: Promise<unknown> = Promise.resolve()
  private disposed = false
  private uiFenceEpoch = 0
  private uiFenceBusy = 0
  private uiFenceFailed = false
  private uiFenceSourceObservationFailed = false
  private uiFenceSources: readonly ManagedServiceUISourceSnapshot[] | undefined
  private readonly uiFencePending = new Map<string, number>()
  private readonly uiFenceRecovery = new Map<string, ManagedServiceUIRecovery>()
  readonly startup: ManagedServiceStartupAuthority
  readonly startupObserver: StartupObserverV1
  readonly browserConsoleLaunch = new ManagedConsoleBrowserLaunch()
  private initialized = false
  private readonly lifecycle = new AbortController()
  private readonly startupTombstones: ManagedServiceStartupTombstones
  private readonly endpointReservations = new ManagedServiceEndpointReservations()
  private readonly managerServiceAuth: ManagerServiceAuth

  get preflight(): PluginLifecycleRuntime['preflight'] {
    return this.runtime.preflight?.bind(this.runtime)
  }

  get requiresBrowserArtifacts(): PluginLifecycleRuntime['requiresBrowserArtifacts'] {
    return this.runtime.requiresBrowserArtifacts?.bind(this.runtime)
  }

  get browserArtifactServer(): PluginLifecycleRuntime['browserArtifactServer'] {
    return this.runtime.browserArtifactServer?.bind(this.runtime)
  }

  constructor(private readonly options: ManagedServicePluginLifecycleOptions) {
    this.managerServiceAuth = new ManagerServiceAuth({
      profileId: options.profileId,
      generation: options.runtimeGeneration,
      withRoute: async (pluginId, callback) =>
        await this.enqueue(async () => {
          // Do not start a login during a staged update or against a candidate route.
          const routes = this.transactions.size === 0 ? this.active?.routes : undefined
          const matching = [...(routes?.values() ?? [])].filter(route => route.owner.pluginId === pluginId)
          return await callback(matching.length === 1 ? matching[0] : undefined)
        }),
      targets: async () =>
        await this.enqueue(async () => {
          if (this.transactions.size > 0 || !this.active) return undefined
          if (!this.active.activation) return this.active.routes.size === 0 ? [] : undefined
          return this.active.activation.sources.map(({ pluginId, serviceId }) => ({ pluginId, serviceId }))
        }),
    })
    this.startupTombstones = new ManagedServiceStartupTombstones(options.profileId, options.runtimeGeneration)
    this.runtime = options.runtime
    this.startup = new ManagedServiceStartupAuthority({
      profileId: options.profileId,
      hostGeneration: options.runtimeGeneration,
    })
    this.startupObserver = this.startup.observer({ scopeId: 'host-providers', authorize: () => true })
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('hex'))
  }

  async initialize(activation: CordisXPluginActivationRecordV1): Promise<ManagedServiceStartupSession> {
    if (this.initialized || this.disposed) throw new Error('managed service lifecycle already initialized or disposed')
    this.beginUIFenceBoundary()
    try {
      const session = await this.initializeNow(activation)
      // A progressive startup can return the observation session before source
      // adoption. The owner cannot issue a stable UI fence until both settle.
      void Promise.all([session.coreReady, session.adopted]).then(
        () => this.endUIFenceBoundary(),
        () => {
          this.uiFenceFailed = true
          this.endUIFenceBoundary()
        },
      )
      return session
    } catch (error) {
      this.uiFenceFailed = true
      this.endUIFenceBoundary()
      throw error
    }
  }

  private async initializeNow(activation: CordisXPluginActivationRecordV1): Promise<ManagedServiceStartupSession> {
    this.initialized = true
    await this.options.validateInitialActivation?.(activation)
    const admissions = await this.resolveAdmissions(activation)
    this.startup.admit(admissions)
    this.startup.selectOwners(startupRecordOwners(activation))
    if (admissions.length > 0) {
      const routes = new Map<string, ManagedServiceOwnerRoute>()
      for (const admission of admissions) {
        const owner = { pluginId: admission.pluginId, pluginGeneration: admission.pluginGeneration }
        const key = ownerKey(owner)
        const token = this.uniqueToken()
        const observer = this.startup.observer({
          scopeId: `plugin:${owner.pluginId}:${owner.pluginGeneration}`,
          owner,
          authorize: ref => ref.pluginId === owner.pluginId,
        })
        const handlerOptions = {
          token,
          profileId: this.options.profileId,
          generation: this.options.runtimeGeneration,
          ...(this.options.nativeManagedConsole === undefined
            ? {}
            : { nativeManagedConsole: this.options.nativeManagedConsole }),
          services: [],
          declaredServices: admission.services.map(service => ({ ...owner, serviceId: service.id })),
          startupObservers: [{ ...owner, observer }],
        }
        const route = {
          key,
          token,
          owner,
          handler: createManagedServiceUIBridgeHandler(handlerOptions),
          startup: true as const,
        }
        routes.set(key, route)
        this.routesByToken.set(token, route)
      }
      this.setActive({ record: activation, leases: [], activation: undefined, routes })
    }
    // Queue adoption, but return the stable observation authority before it settles.
    const published = this.enqueue(async () => {
      const provisional = this.active
      const fleet = await this.createFleet(activation)
      if (provisional !== undefined) {
        for (const route of provisional.routes.values()) {
          if (!fleet.routes.has(route.key)) await route.handler.dispose()
        }
      }
      this.setActive(fleet)
      for (const route of fleet.routes.values()) this.routesByToken.set(route.token, route)
      if (admissions.length > 0) this.changedNativeProviders()
      return fleet
    })
    const coreReady = published.then(async fleet => {
      await (fleet.activation?.coreReady ?? fleet.activation?.adopted)
      this.lifecycle.signal.throwIfAborted()
    })
    const adopted = this.enqueue(async () => {
      const fleet = await published
      await fleet.activation?.adopted
      this.lifecycle.signal.throwIfAborted()
    })
    void coreReady.catch(() => undefined)
    void adopted.catch(() => undefined)
    if (admissions.length === 0) await adopted // Preserve legacy blocking callers.
    return { authority: this.startup, coreReady, adopted, observer: this.startupObserver }
  }

  private async resolveAdmissions(record: CordisXPluginActivationRecordV1): Promise<readonly StartupPluginAdmission[]> {
    return this.options.readStartupAdmissions?.(record)
      ?? (this.options.homeDir === undefined ? [] : await readStartupAdmissions(this.options.homeDir, record))
  }

  capabilities(): readonly ManagedServiceUICapabilityMutation[] {
    return Object.freeze([...this.requireActive().routes.values()].map(route =>
      Object.freeze({
        ...route.owner,
        ...(route.startup === true ? { startup: true } : {}),
        token: route.token,
      })
    ))
  }

  /**
   * Owner-only authority for renderer UI projections. The epoch is local to
   * this runtime instance and never reuses a value after rollback. A caller
   * must also verify the enclosing owner/session identity before and after I/O.
   * Undefined includes startup, any unresolved transaction, missing source
   * observation, cleanup failure, terminal failure, and disposal.
   */
  readManagedServiceUIFence(): number | undefined {
    const fleet = this.active
    if (
      !this.initialized || this.disposed || this.uiFenceFailed || this.uiFenceSourceObservationFailed
      || this.uiFenceBusy !== 0
      || this.uiFencePending.size !== 0 || this.transactions.size !== 0 || fleet === undefined
      || fleet.leases.some(lease => typeof lease.activation.subscribeSources !== 'function')
    ) return undefined
    try {
      const captured = captureManagedServiceUISources(fleet.activation?.sources ?? [])
      if (
        this.active !== fleet || this.disposed || this.uiFenceFailed || this.uiFenceSourceObservationFailed
        || this.uiFenceBusy !== 0 || this.uiFencePending.size !== 0 || this.transactions.size !== 0
      ) return undefined
      const previous = this.uiFenceSources
      if (previous !== undefined && !sameManagedServiceUISources(previous, captured)) this.advanceUIFence()
      this.uiFenceSources = captured
    } catch {
      this.uiFenceSourceObservationFailed = true
      return undefined
    }
    if (this.uiFenceFailed) return undefined
    return this.uiFenceEpoch
  }

  /** Host bootstrap passes this only to B's dedicated Host transport, never plugin metadata. */
  hostStartupCapability(): { readonly token: string; readonly observer: StartupObserverV1 } {
    return this.hostStartupInput ??= { token: this.uniqueToken(), observer: this.startupObserver }
  }
  private hostStartupInput: { readonly token: string; readonly observer: StartupObserverV1 } | undefined

  readonly managedServiceUI = {
    handleBindingValue: async (value: string, documentSignal?: AbortSignal): Promise<Record<string, unknown>> =>
      await this.handleBindingValue(value, documentSignal),
  }

  /** The local manager owns its browser session; no plugin token crosses this boundary. */
  async managerAuth(operation: ManagerServiceAuthOperation): Promise<unknown> {
    return await this.managerServiceAuth.handle(operation)
  }

  /** Fence a private Host action against plugin disable/replacement transactions. */
  async withActivePlugin<T>(
    identity: {
      readonly id: string
      readonly moduleGeneration: string
      readonly digest: string
      readonly version: string
      readonly canonicalSource?: string
    },
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    return await this.enqueue(async () => {
      const plugin = this.active?.record?.plugins.find(item => item.id === identity.id)
      if (
        this.transactions.size > 0 || !plugin?.enabled || plugin.moduleGeneration !== identity.moduleGeneration
        || plugin.digest !== identity.digest || plugin.version !== identity.version
        || plugin.canonicalSource !== identity.canonicalSource
      ) return undefined
      return await action()
    })
  }

  nativeActivation(): ManagedServiceNativeActivation {
    const owner = this
    return Object.freeze({
      startup: owner.startup,
      startupObserver: owner.startupObserver,
      get revision(): number {
        return owner.nativeRevision
      },
      get nativeProviderIds(): readonly string[] {
        return owner.active?.activation?.nativeProviderIds ?? []
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
    const key = `transaction:${transactionId}`
    const stamp = this.beginUIFenceBoundary(key)
    try {
      if (this.runtime.prepare === undefined) throw new Error('plugin lifecycle prepare is unavailable')
      return this.runtime.prepare(transactionId)
    } finally {
      this.endUIFenceBoundary(key, stamp)
    }
  }

  async prepareBrowserGraph(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence> {
    return await this.withUITransaction(transactionId, false, async () => {
      if (this.runtime.prepareBrowserGraph === undefined) throw new Error('browser graph preparation is unavailable')
      return await this.runtime.prepareBrowserGraph(transactionId, active)
    })
  }

  async stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation> {
    return await this.withUITransaction(
      mutation.transactionId,
      false,
      async () => await this.enqueue(() => this.stageNow(mutation)),
    )
  }

  private async stageNow(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation> {
    if (this.transactions.size > 0) {
      throw new Error('managed service lifecycle transaction already exists')
    }
    const previous = this.requireActive()
    let activationFailure: unknown
    const candidate = await this.createFleet(mutation.candidate, previous).catch(error => {
      activationFailure = error
      return { activation: undefined, leases: [], routes: new Map() }
    })
    const newCapabilities = [...candidate.routes.values()].flatMap(route =>
      previous.routes.has(route.key)
        ? []
        : [{ ...route.owner, token: route.token, ...(route.startup === true ? { startup: true } : {}) }]
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
    return await this.withUITransaction(
      transactionId,
      false,
      async () => await this.enqueue(() => this.publishNow(transactionId)),
    )
  }

  private async publishNow(transactionId: string): Promise<RuntimePublicationObservation> {
    const transaction = this.transaction(transactionId)
    for (const route of transaction.candidate.routes.values()) this.routesByToken.set(route.token, route)
    this.setActive(transaction.candidate)
    this.changedNativeProviders()
    transaction.published = true
    if (this.runtime.publish === undefined) throw new Error('plugin lifecycle publication is unavailable')
    return await this.runtime.publish(transactionId)
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    return await this.withUITransaction(
      transactionId,
      false,
      async () => await this.enqueue(() => this.completeNow(transactionId)),
    )
  }

  private async completeNow(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.complete === undefined) throw new Error('plugin lifecycle cleanup is unavailable')
    return await this.runtime.complete(transactionId)
  }

  async finalize(transactionId: string): Promise<void> {
    return await this.withUITransaction(
      transactionId,
      true,
      async () => await this.enqueue(() => this.finalizeNow(transactionId)),
    )
  }

  private async finalizeNow(transactionId: string): Promise<void> {
    const transaction = this.transaction(transactionId)
    await this.runtime.finalize?.(transactionId)
    await this.disposeFleet(transaction.previous, transaction.candidate)
    for (const route of transaction.previous.routes.values()) {
      if (!transaction.candidate.routes.has(route.key) && this.routesByToken.get(route.token) === route) {
        this.routesByToken.delete(route.token)
      }
    }
    this.transactions.delete(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    return await this.withUITransaction(
      transactionId,
      true,
      async () => await this.enqueue(() => this.rollbackNow(transactionId)),
    )
  }

  private async rollbackNow(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.rollback === undefined) throw new Error('plugin lifecycle rollback is unavailable')
    const observation = await this.runtime.rollback(transactionId)
    const transaction = this.transactions.get(transactionId)
    if (transaction !== undefined) await this.rollbackManaged(transactionId, transaction)
    return observation
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    const key = `transaction:${plan.transactionId}`
    const stamp = this.beginUIFenceBoundary(key)
    this.uiFenceRecovery.delete(key)
    try {
      if (this.runtime.recoverRollback === undefined) throw new Error('plugin lifecycle recovery is unavailable')
      const observation = await this.runtime.recoverRollback(plan)
      try {
        const target = plan.rollbackTarget
        const plugins = JSON.stringify(target.plugins)
        if (
          this.uiFencePending.get(key) === stamp
          && observation.transactionId === plan.transactionId && observation.transactionEpoch === plan.transactionEpoch
          && observation.registryEpoch === plan.rollbackRegistryEpoch
          && observation.active.profileId === target.profileId
          && observation.active.runtimeGeneration === target.runtimeGeneration
          && JSON.stringify(observation.active.plugins) === plugins
          && JSON.stringify(observation.disposedAfter.plugins) === JSON.stringify(plan.expectedPublished.plugins)
        ) {
          this.uiFenceRecovery.set(key, {
            stamp,
            registryEpoch: plan.rollbackRegistryEpoch,
            profileId: target.profileId,
            runtimeGeneration: target.runtimeGeneration,
            plugins,
          })
        }
      } catch { /* An unverifiable observation must not reopen the fence. */ }
      return observation
    } finally {
      // The coordinator must also adopt the recovered authority before this
      // owner can claim that a recovered route is stable.
      this.endUIFenceBoundary(key, stamp)
    }
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const key = 'operation:adopt-recovered'
    const stamp = this.beginUIFenceBoundary(key)
    const recovery = new Map(this.uiFenceRecovery)
    let settled = false
    try {
      await this.runtime.adoptRecoveredActivation?.(active, registryEpoch)
      // The adoption API has no transaction ID, so it cannot certify which
      // recovery it completed when multiple recoveries are outstanding.
      // Preserve the legacy optional call while keeping that case fenced.
      const recovered = [...recovery.values()][0]
      let verified = recovered === undefined
      try {
        if (recovered !== undefined) {
          verified = this.runtime.adoptRecoveredActivation !== undefined && registryEpoch === recovered.registryEpoch
            && active.profileId === recovered.profileId && active.runtimeGeneration === recovered.runtimeGeneration
            && JSON.stringify(active.plugins) === recovered.plugins
        }
      } catch { /* Unverifiable adoption cannot reopen the fence. */ }
      if (recovery.size <= 1 && verified) {
        for (const [transactionKey, transaction] of recovery) {
          if (this.uiFenceRecovery.get(transactionKey) !== transaction) continue
          this.uiFenceRecovery.delete(transactionKey)
          if (this.uiFencePending.get(transactionKey) === transaction.stamp) this.uiFencePending.delete(transactionKey)
        }
        settled = true
      }
    } finally {
      this.endUIFenceBoundary(key, stamp, settled)
    }
  }

  async commit(transactionId: string): Promise<void> {
    return await this.withUITransaction(
      transactionId,
      true,
      async () => await this.enqueue(() => this.commitNow(transactionId)),
    )
  }

  private async commitNow(transactionId: string): Promise<void> {
    const transaction = this.transaction(transactionId)
    for (const route of transaction.candidate.routes.values()) this.routesByToken.set(route.token, route)
    this.setActive(transaction.candidate)
    this.changedNativeProviders()
    transaction.published = true
    await this.runtime.commit(transactionId)
    await this.disposeFleet(transaction.previous, transaction.candidate)
    this.transactions.delete(transactionId)
  }

  async abort(transactionId: string): Promise<void> {
    return await this.withUITransaction(
      transactionId,
      true,
      async () => await this.enqueue(() => this.abortNow(transactionId)),
    )
  }

  private async abortNow(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId)
    await this.runtime.abort(transactionId)
    if (transaction !== undefined) await this.rollbackManaged(transactionId, transaction)
  }

  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    const key = 'operation:reload'
    const stamp = this.beginUIFenceBoundary(key)
    let settled = false
    try {
      await this.runtime.reload(input)
      settled = true
    } finally {
      this.endUIFenceBoundary(key, stamp, settled)
    }
  }

  terminal(error: unknown): void {
    this.advanceUIFence()
    this.uiFenceFailed = true
    this.runtime.terminal?.(error)
  }

  async dispose(): Promise<void> {
    this.advanceUIFence()
    this.uiFenceFailed = true
    this.managerServiceAuth.close()
    if (this.disposed) return await this.mutation.then(() => undefined)
    this.disposed = true
    this.lifecycle.abort(new Error('managed service lifecycle disposed'))
    const disposal = this.mutation.then(() => this.disposeNow())
    this.mutation = disposal.catch(() => undefined)
    return await disposal
  }

  private async disposeNow(): Promise<void> {
    const fleets = new Set<ManagedServiceFleet>()
    if (this.active !== undefined) fleets.add(this.active)
    for (const transaction of this.transactions.values()) {
      fleets.add(transaction.previous)
      fleets.add(transaction.candidate)
    }
    for (const fleet of fleets) for (const route of fleet.routes.values()) this.retireRoute(route, 'host-replaced')
    this.startup.dispose()
    this.setActive(undefined)
    this.transactions.clear()
    this.routesByToken.clear()
    const routes = new Set([...fleets].flatMap(fleet => [...fleet.routes.values()]))
    const groups = new Set([...fleets].flatMap(fleet => fleet.leases.map(lease => lease.activation)))
    await Promise.allSettled([...routes].map(async route => await route.handler.dispose()))
    await Promise.allSettled([...groups].map(async group => await group.dispose()))
    this.changedNativeProviders()
    this.nativeProviderListeners.clear()
    this.startup.dispose()
  }

  private async createFleet(
    record: CordisXPluginActivationRecordV1,
    previous?: ManagedServiceFleet,
  ): Promise<ManagedServiceFleet> {
    const admissions = await this.resolveAdmissions(record)
    this.startup.admit(admissions)
    const retained = previous?.leases.filter(lease => unchangedManagedServiceLease(lease, record)) ?? []
    for (const lease of previous?.leases ?? []) {
      if (retained.includes(lease)) continue
      if (lease.plugins.some(plugin => unchangedManagedServiceLease({ ...lease, plugins: [plugin] }, record))) {
        throw new Error('managed service update requires restart: dependency component contains an unchanged owner')
      }
    }
    const retainedIds = new Set(retained.flatMap(lease => lease.activation.pluginIds))
    const changed = {
      ...record,
      plugins: record.plugins.filter(plugin => plugin.enabled && !retainedIds.has(plugin.id)),
    }
    const activated = changed.plugins.length === 0 ? undefined : await this.options.activate(record, {
      startupAuthority: this.startup,
      signal: this.lifecycle.signal,
      endpointReservations: this.endpointReservations,
      pluginIds: changed.plugins.map(plugin => plugin.id),
      isolateStartupFailures: previous === undefined,
      ...(previous === undefined ? {} : {
        reservedLoopbackPorts: previous.leases.flatMap(lease => lease.activation.activeLoopbackPorts),
        reservedServiceKeys: previous.leases.flatMap(lease => lease.activation.exclusiveServiceKeys),
      }),
    })
    if (previous !== undefined) {
      try {
        await activated?.adopted
      } catch (error) {
        await activated?.dispose().catch(() => undefined)
        throw error
      }
    }
    const created = managedServiceLeases(activated, changed)
    const leases = [...retained, ...created]
    const activation = managedServiceFleetActivation(leases)
    if (activation === undefined && admissions.length === 0) {
      return { record, activation: undefined, leases, routes: new Map() }
    }
    const routes = new Map<string, ManagedServiceOwnerRoute>()
    const readNativeProviders = activation === undefined ? async () => [] : nativeModelProviderCatalog(activation)
    const ownerKeys = new Set((activation?.sources ?? []).map(source => ownerKey(source)))
    for (const lease of leases) {
      for (const plugin of lease.plugins) {
        ownerKeys.add(ownerKey({ pluginId: plugin.id, pluginGeneration: plugin.moduleGeneration }))
      }
    }
    for (const admission of admissions) ownerKeys.add(ownerKey(admission))
    try {
      for (const key of ownerKeys) {
        const declaration = admissions.find(admission => ownerKey(admission) === key)
        const plugin = record.plugins.find(plugin =>
          ownerKey({ pluginId: plugin.id, pluginGeneration: plugin.moduleGeneration }) === key
        )!
        const owner = { pluginId: plugin.id, pluginGeneration: plugin.moduleGeneration }
        const existing = previous?.routes.get(key)
        if (existing !== undefined && retainedIds.has(owner.pluginId)) {
          routes.set(key, existing)
          continue
        }
        const early = previous === undefined
          ? [...this.routesByToken.values()].find(route => route.key === key)
          : undefined
        const observer = declaration === undefined || early !== undefined
          ? undefined
          : this.startup.observer({
            scopeId: `plugin:${owner.pluginId}:${owner.pluginGeneration}`,
            owner,
            authorize: ref => ref.pluginId === owner.pluginId,
          })
        const token = early?.token ?? this.uniqueToken()
        const handlerOptions = {
          token,
          profileId: this.options.profileId,
          generation: this.options.runtimeGeneration,
          readNativeProviders,
          ...(this.options.nativeManagedConsole === undefined
            ? {}
            : { nativeManagedConsole: this.options.nativeManagedConsole }),
          services: [],
          ...(declaration === undefined
            ? {}
            : { declaredServices: declaration.services.map(service => ({ ...owner, serviceId: service.id })) }),
          ...(observer === undefined ? {} : { startupObservers: [{ ...owner, observer }] }),
        }
        const handler = managedServiceLiveHandler(
          early?.handler ?? createManagedServiceUIBridgeHandler(handlerOptions),
          () => activation?.sources.filter(source => ownerKey(source) === key) ?? [],
          readNativeProviders,
          this.options.nativeManagedConsole,
          this.browserConsoleLaunch.boundary,
        )
        routes.set(key, { key, token, owner, handler, ...(declaration === undefined ? {} : { startup: true }) })
      }
      void activation?.nativeProviderIds // Reject cross-component provider collisions before publication.
      return { record, activation, leases, routes }
    } catch (error) {
      await Promise.allSettled(
        [...routes.values()].filter(route => previous?.routes.get(route.key) !== route)
          .map(async route => await route.handler.dispose()),
      )
      await Promise.allSettled(created.map(async lease => await lease.activation.dispose()))
      throw error
    }
  }

  private uniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.createToken()
      if (
        token.length >= 32 && !this.routesByToken.has(token) && !this.startupTombstones.contains(token)
        && token !== this.hostStartupInput?.token
      ) return token
    }
    throw new Error('managed service UI token generation failed')
  }

  private async handleBindingValue(value: string, documentSignal?: AbortSignal): Promise<Record<string, unknown>> {
    let requestId = 'invalid'
    let envelope: Record<string, unknown> | undefined
    try {
      if (Buffer.byteLength(value) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) {
        throw new Error('managed service UI request exceeds maximum size')
      }
      envelope = JSON.parse(value) as Record<string, unknown>
      if (typeof envelope.requestId === 'string') requestId = envelope.requestId
      if (typeof envelope.token !== 'string') throw new Error('managed service UI request is not authorized')
      const terminated = this.startupTombstones.result(envelope)
      if (terminated !== undefined) return { requestId, ok: true, value: terminated }
      const route = this.routesByToken.get(envelope.token)
      if (route === undefined) throw new Error('managed service UI request is not authorized')
      const request = parseManagedServiceUIBindingRequest(envelope, route.handler, route.owner)
      if (request.operation === 'consoleBrowser' && (!documentSignal || documentSignal.aborted)) {
        return { requestId, ok: true, value: { status: 'unavailable', reason: 'owner-unavailable' } }
      }
      return { requestId, ok: true, value: await route.handler.handle(route.owner, request, documentSignal) }
    } catch (error) {
      const terminated = envelope === undefined ? undefined : this.startupTombstones.result(envelope)
      if (terminated !== undefined) return { requestId, ok: true, value: terminated }
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
      this.setActive(transaction.previous)
      this.changedNativeProviders()
    }
    await this.disposeFleet(transaction.candidate, transaction.previous)
    this.transactions.delete(transactionId)
  }

  private retireRoute(route: ManagedServiceOwnerRoute, reason: 'scope-revoked' | 'host-replaced'): void {
    if (route.startup === true) this.startupTombstones.retire(route.token, route.owner, reason)
    if (this.routesByToken.get(route.token) === route) this.routesByToken.delete(route.token)
  }

  private async disposeFleet(fleet: ManagedServiceFleet, retained?: ManagedServiceFleet): Promise<void> {
    for (const route of fleet.routes.values()) {
      if (retained?.routes.get(route.key) !== route) this.retireRoute(route, 'scope-revoked')
    }
    for (const plugin of fleet.record?.plugins ?? []) {
      if (
        !retained?.record?.plugins.some(item =>
          item.enabled && item.id === plugin.id && item.moduleGeneration === plugin.moduleGeneration
        )
      ) {
        this.startup.retireOwner(plugin.id, plugin.moduleGeneration)
      }
    }
    await Promise.allSettled(
      [...fleet.routes.values()]
        .filter(route => retained?.routes.get(route.key) !== route)
        .map(async route => await route.handler.dispose()),
    )
    const borrowed = new Set(retained?.leases.map(lease => lease.activation))
    await Promise.all(
      fleet.leases.filter(lease => !borrowed.has(lease.activation))
        .map(async lease => await lease.activation.dispose()),
    )
  }

  private advanceUIFence(): number {
    if (this.uiFenceEpoch === Number.MAX_SAFE_INTEGER) {
      // Exhaustion is practically unreachable, but reuse would make ABA unsafe.
      this.uiFenceFailed = true
    } else this.uiFenceEpoch += 1
    return this.uiFenceEpoch
  }

  /** Synchronous: invalidate the old value before queuing or starting work. */
  private beginUIFenceBoundary(key?: string): number {
    const stamp = this.advanceUIFence()
    this.uiFenceBusy += 1
    if (key !== undefined) this.uiFencePending.set(key, stamp)
    return stamp
  }

  private endUIFenceBoundary(key?: string, stamp?: number, settled = false): void {
    if (key !== undefined) {
      if (settled && this.uiFencePending.get(key) === stamp) this.uiFencePending.delete(key)
      else if (!settled && !this.uiFencePending.has(key)) {
        // A later abort/retry can finish before an older operation. It cannot
        // certify work that is still running, so reinstate uncertainty when
        // that older operation eventually returns or fails.
        this.uiFencePending.set(key, this.advanceUIFence())
      }
    }
    this.uiFenceBusy -= 1
  }

  private async withUITransaction<T>(
    transactionId: string,
    settles: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `transaction:${transactionId}`
    const stamp = this.beginUIFenceBoundary(key)
    let settled = false
    try {
      const result = await operation()
      settled = settles
      if (settled && this.uiFencePending.get(key) === stamp) this.uiFenceRecovery.delete(key)
      return result
    } finally {
      // A failure can have partially changed a route. Keep it unavailable
      // until a later confirmed abort, rollback or finalization succeeds.
      this.endUIFenceBoundary(key, stamp, settled)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('managed service lifecycle is disposed'))
    const next = this.mutation.then(operation)
    this.mutation = next.catch(() => undefined)
    return next
  }

  private requireActive(): ManagedServiceFleet {
    if (this.active === undefined) throw new Error('managed service lifecycle is not initialized')
    return this.active
  }

  private setActive(fleet: ManagedServiceFleet | undefined): void {
    this.advanceUIFence()
    this.uiFenceSources = undefined
    this.stopNativeProviders?.()
    this.stopNativeProviders = undefined
    try {
      this.stopUISources?.()
    } catch {
      // A failed unsubscribe makes source-observation ownership uncertain.
      this.uiFenceFailed = true
    }
    this.stopUISources = undefined
    this.uiFenceSourceObservationFailed = false
    this.active = fleet
    if (fleet?.record !== undefined) this.startup.selectOwners(startupRecordOwners(fleet.record))
    // Subscribe before readers can take their next snapshot. Retained components
    // are observed through the new fleet only; late callbacks from old bindings
    // cannot advance the active revision.
    this.stopNativeProviders = fleet?.activation?.subscribeNativeProviders?.(() => {
      if (this.active === fleet) this.changedNativeProviders()
    })
    const observation = observeManagedServiceUISources(fleet?.leases.map(lease => lease.activation) ?? [], () => {
      // Node host source publication and notification are synchronous.
      if (this.active === fleet) this.advanceUIFence()
    })
    this.uiFenceSourceObservationFailed = !observation.available
    this.stopUISources = observation.stop
  }

  private changedNativeProviders(): void {
    this.nativeRevision += 1
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
