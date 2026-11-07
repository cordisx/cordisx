import { waitForStartupOperation } from './managed-service-startup-operation.js'
import type { StartupCapabilityDeclarationV1, StartupCapabilityRefV1 } from '@cordisx/protocol/startup/v1'
import type {
  StartupManagedServiceConfigurationV1,
  StartupManagedServiceNodeModuleV1,
} from '@cordisx/protocol/startup-runtime/v1'
import type { ManagedServiceServiceContextV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceActivationBinding, ManagedServiceRuntime } from './managed-service-runtime.js'
import { ManagedServiceStartupAuthority, type StartupServiceOwner } from './managed-service-startup-authority.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'

export interface StartupPreparedModule {
  readonly configuration?: StartupManagedServiceConfigurationV1
  readonly access: ManagedBackendRuntimeServiceModuleAccess
  readonly binding: ManagedServiceActivationBinding
  readonly controller: AbortController
  readonly module: StartupManagedServiceNodeModuleV1
  readonly context: ManagedServiceServiceContextV1
}

interface Preparation {
  readonly module: StartupPreparedModule
  readonly capability: StartupCapabilityDeclarationV1
  readonly owner: StartupServiceOwner
  controller: AbortController
  pending: Promise<void> | undefined
}
const key = (ref: StartupCapabilityRefV1) => `${ref.pluginId}\u0000${ref.capabilityId}`

/** Owns background callbacks; the Cordis component continues to own all cleanup. */
export class ManagedServiceStartupPreparation {
  private readonly preparations = new Map<string, Preparation>()
  private readonly stop: (() => void)[] = []
  private readonly owners: Map<string, string>
  private syncing = false
  private readonly inFlight = new Map<Promise<void>, StartupPreparedModule>()

  constructor(
    readonly authority: ManagedServiceStartupAuthority,
    private readonly runtime: ManagedServiceRuntime,
    accesses: readonly ManagedBackendRuntimeServiceModuleAccess[],
  ) {
    this.owners = new Map(authority.ownerSelections())
    for (const access of accesses) this.owners.set(access.pluginIdentity.pluginId, access.pluginIdentity.generation)
    this.stop.push(
      runtime.subscribeServices(() => this.sync()),
      runtime.subscribeNativeProviders(() => this.sync()),
      authority.subscribe(() => {
        this.revokeInvalidPublications()
        runtime.refreshNativeProviders()
      }),
    )
  }

  /** Register all adopted siblings before scheduling any callback. */
  adopt(modules: readonly StartupPreparedModule[]): void {
    for (const module of modules) {
      const owner = module.binding.authority
      const registration = this.runtime.getRegistrationHandle(this.identity(module))
      if (registration === undefined) throw new Error('progressive service apply did not register its definition')
      for (const capability of module.access.startup?.startup.capabilities ?? []) {
        if (capability.serviceId !== module.access.serviceId) continue
        this.preparations.set(key({ pluginId: owner.pluginId, capabilityId: capability.id }), {
          module,
          capability,
          owner,
          controller: new AbortController(),
          pending: undefined,
        })
      }
      this.authority.adopt(owner)
    }
    this.sync()
    for (const module of modules) {
      for (const preparation of this.preparations.values()) {
        if (preparation.module === module) this.schedule(preparation)
      }
    }
  }

  retry(ref: StartupCapabilityRefV1): void {
    const preparation = this.preparations.get(key(ref))
    if (preparation === undefined || preparation.module.controller.signal.aborted) {
      throw new Error('startup target is unavailable')
    }
    preparation.controller.abort(new Error('startup preparation replaced'))
    preparation.controller = new AbortController()
    this.schedule(preparation)
  }

  private schedule(preparation: Preparation): void {
    const { module, capability, owner } = preparation
    const signal = AbortSignal.any([module.controller.signal, preparation.controller.signal])
    const attempt = this.authority.beginAttempt(owner, capability.id, signal)
    const operation = (async () => {
      try {
        await Promise.all(capability.dependsOn.map(ref => this.authority.waitForDependency(ref, this.owners, signal)))
        signal.throwIfAborted()
        const registration = this.runtime.getRegistrationHandle(this.identity(module))!
        if (registration.binding.serviceGeneration !== owner.serviceGeneration) {
          throw new Error('startup registration replaced')
        }
        // A package callback may ignore abort; cleanup waits only for this attempt.
        // The waiter still observes a late callback rejection without restoring authority.
        await waitForStartupOperation(
          Promise.resolve(module.module.prepare(module.context, {
            ...(module.configuration === undefined ? {} : { configuration: module.configuration }),
            owner: module.binding.owner,
            client: module.binding.client,
            signal,
            capability: structuredClone(capability),
            registration: Object.freeze<typeof registration>({
              ...registration,
              get binding() {
                return registration.binding
              },
              ensureReady: options => {
                const waiterSignal = options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal])
                waiterSignal.throwIfAborted()
                return waitForStartupOperation(
                  registration.ensureReady({ ...options, signal: module.controller.signal }),
                  waiterSignal,
                )
              },
              authenticate: (action, options) =>
                registration.authenticate(action, {
                  ...options,
                  signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
                }),
              restart: options =>
                registration.restart({
                  ...options,
                  signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
                }),
              publishNativeProvider: (input, options) =>
                registration.publishNativeProvider(input, {
                  ...options,
                  signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
                }),
            }),
            generation: {
              host: module.access.hostGeneration,
              plugin: owner.pluginGeneration,
              service: owner.serviceGeneration,
            },
            startup: attempt.reporter,
          })),
          signal,
        )
        signal.throwIfAborted()
        this.sync()
        attempt.finish()
      } catch {
        const current = attempt.current()
        attempt.finish(true)
        if (current && capability.kind === 'provider') {
          this.runtime.revokeNativeProvider(this.identity(module), capability.providerId)
        }
      }
    })()
    preparation.pending = operation
    this.inFlight.set(operation, module)
    void operation.then(() => {
      this.inFlight.delete(operation)
      if (preparation.pending === operation) preparation.pending = undefined
    })
  }

  /** Abort/fence before waiting; late callback results have no authority. */
  async disposeModules(modules: readonly { readonly binding: ManagedServiceActivationBinding }[]): Promise<void> {
    const bindings = new Set(modules.map(module => module.binding))
    const disposing = [...this.preparations.values()].filter(preparation => bindings.has(preparation.module.binding))
    for (const preparation of disposing) {
      preparation.controller.abort(new Error('startup component disposed'))
      this.authority.revoke(preparation.owner)
      this.preparations.delete(key({ pluginId: preparation.owner.pluginId, capabilityId: preparation.capability.id }))
    }
    await Promise.allSettled(
      [...this.inFlight].filter(([, module]) => bindings.has(module.binding)).map(([operation]) => operation),
    )
  }

  dispose(): void {
    for (const stop of this.stop.splice(0)) stop()
  }

  private identity(module: StartupPreparedModule) {
    return {
      source: module.access.pluginIdentity.source as `https://${string}`,
      pluginId: module.access.pluginIdentity.pluginId,
      serviceId: module.access.serviceId,
    }
  }

  sync(): void {
    if (this.syncing) return
    this.syncing = true
    try {
      for (const preparation of this.preparations.values()) {
        const { owner, module, capability } = preparation
        if (module.controller.signal.aborted) continue
        const identity = this.identity(module)
        const projection = this.runtime.serviceProjection(identity)
        if (projection !== undefined) {
          this.authority.updateService(owner, projection, this.runtime.getAuthenticationMode(identity) === 'cli')
        }
        if (capability.kind !== 'provider') continue
        const publication = this.runtime.nativePublication(capability.providerId)
        this.authority.publication(
          owner,
          capability.providerId,
          publication === undefined ? undefined : {
            state: 'known',
            generation: publication.catalog.generation,
            modelIds: publication.catalog.routes.map(route => route.alias),
            gatewayModelIds: publication.catalog.routes.map(route => route.gatewayModelId),
          },
        )
      }
    } finally {
      this.syncing = false
    }
    this.revokeInvalidPublications()
  }

  private revokeInvalidPublications(): void {
    for (const preparation of this.preparations.values()) {
      if (preparation.capability.kind !== 'provider') continue
      const publication = this.runtime.nativePublication(preparation.capability.providerId)
      if (
        publication !== undefined
        && !this.authority.acceptsPublication(
          preparation.owner,
          publication.providerId,
          publication.compositionOrigin,
          publication.catalog,
        )
      ) {
        this.runtime.revokeNativeProvider(this.identity(preparation.module), publication.providerId)
      }
    }
  }
}
