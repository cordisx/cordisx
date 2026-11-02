import { resolveManagedServiceConfiguration } from './managed-service-configuration-policy.js'
import { snapshotManagedServiceConfigurations } from './managed-service-instance-configuration.js'
import type {
  StartupManagedServiceApplyInputV1,
  StartupManagedServiceConfigurationV1,
  StartupManagedServiceNodeModuleV1,
} from '@cordisx/protocol/startup-runtime/v1'
import { ManagedServiceStartupAuthority } from './managed-service-startup-authority.js'
import { ManagedServiceStartupPreparation } from './managed-service-startup-preparation.js'
import type {
  ManagedServiceContextProviderRootV1,
  ManagedServiceContextProviderV1,
  ManagedServiceNodeModuleV1,
} from '@cordisx/protocol/managed-service-context/v1'
import type { ManagedServiceServiceContextV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { Context, Inject, type Plugin } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'
import {
  type ManagedServiceActivationBinding,
  type ManagedServiceContextAuthorityV1,
  ManagedServiceRuntime,
} from './managed-service-runtime.js'
import type { ManagedServiceNodeSourceBinding } from './managed-service-ui-source.js'
import { adoptedManagedServiceSource } from './managed-service-adopted-source.js'
import { managedServiceStartupGroups } from './managed-service-startup-groups.js'
import { reportManagedServiceStartup } from './managed-service-startup-diagnostic.js'

const SERVICE_NAME = /^[a-z][A-Za-z0-9]{0,95}$/
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/

interface ProviderState {
  readonly module: ModuleState
  readonly provider: ManagedServiceContextProviderV1
  root: ManagedServiceContextProviderRootV1 | undefined
}

interface ModuleState {
  readonly access: ManagedBackendRuntimeServiceModuleAccess
  module: ManagedServiceNodeModuleV1 | undefined
  configuration?: StartupManagedServiceConfigurationV1
  context?: ManagedServiceServiceContextV1
  readonly binding: ManagedServiceActivationBinding
  readonly controller: AbortController
}

export interface ManagedServiceNodeActivationGroup extends Omit<ManagedServiceNodeActivation, 'groups'> {
  readonly pluginIds: readonly string[]
  readonly activeLoopbackPorts: readonly number[]
  readonly exclusiveServiceKeys: readonly string[]
}

export interface ManagedServiceNodeActivation {
  /** Internal dependency-component cleanup boundaries, never renderer capabilities. */
  readonly groups?: readonly ManagedServiceNodeActivationGroup[]
  /** Full base adoption, including background components; transactions await this. */
  readonly adopted?: Promise<void>
  /** Base adoption of legacy components and their atomic context dependency closure. */
  readonly coreReady?: Promise<void>
  /** Sources/authorities are live and change atomically per component. */
  readonly subscribeSources?: (listener: () => void) => () => void
  readonly startup?: ManagedServiceStartupAuthority
  readonly retryStartup?: (ref: import('@cordisx/protocol/startup/v1').StartupCapabilityRefV1) => void
  readonly hostGeneration: string
  readonly authorities: readonly ManagedServiceContextAuthorityV1[]
  readonly sources: readonly ManagedServiceNodeSourceBinding[]
  /** Available native managed gateway provider IDs. */
  readonly nativeProviderIds: readonly string[]
  subscribeNativeProviders(listener: () => void): () => void
  prepareNativeConnection(providerId: string): NativeManagedGatewayConnectionSession
  dispose(): Promise<void>
}

function injectionNames(apply: ManagedServiceNodeModuleV1['apply']): readonly string[] {
  return Object.keys(Inject.resolve(apply.inject))
}

function isReservedService(root: Context, service: string): boolean {
  if (service === 'managedServices') return true
  let value: object | null = root
  while (value !== null) {
    if (Object.prototype.hasOwnProperty.call(value, service)) return true
    value = Object.getPrototypeOf(value) as object | null
  }
  return false
}

function providerRoot(state: ProviderState): ManagedServiceContextProviderRootV1 {
  if (state.root === undefined) throw new Error(`managed context service ${state.provider.service} has no root`)
  return state.root
}

/** V15 metadata also carries Config for services that retain legacy blocking adoption. */
function blocksCoreReadiness(state: ModuleState): boolean {
  return !state.access.startup?.startup.capabilities.some(capability => capability.serviceId === state.access.serviceId)
}

function modulePath(access: ManagedBackendRuntimeServiceModuleAccess): string {
  const root = path.resolve(access.artifactDirectory)
  const file = path.resolve(root, access.runtimeEntry)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('managed backend service entry escapes its artifact')
  return file
}

async function settleCleanup(actions: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'managed service cleanup failed')
}

export class ManagedServiceNodeHost {
  private current: ManagedServiceNodeActivation | undefined
  private transition: Promise<void> = Promise.resolve()
  private activating: AbortController | undefined

  constructor(
    private readonly runtime: ManagedServiceRuntime,
    private readonly profileId: string = 'default',
    private readonly runtimeGeneration: string = randomUUID(),
    private readonly startupAuthority?: ManagedServiceStartupAuthority,
  ) {}

  async replace(
    accesses: readonly ManagedBackendRuntimeServiceModuleAccess[],
    options: { readonly isolateStartupFailures?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedServiceNodeActivation> {
    const selectedAccesses = snapshotManagedServiceConfigurations(accesses)
    const operation = this.transition.then(async () => {
      const previous = this.current
      this.current = undefined
      await previous?.dispose()
      const controller = new AbortController()
      this.activating = controller
      let activation: ManagedServiceNodeActivation
      try {
        activation = await this.activate(
          selectedAccesses,
          options.isolateStartupFailures === true,
          options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
        )
      } finally {
        if (this.activating === controller) this.activating = undefined
      }
      this.current = activation
      return activation
    })
    this.transition = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async dispose(): Promise<void> {
    this.activating?.abort(new Error('managed service host disposed'))
    const operation = this.transition.then(async () => {
      const current = this.current
      this.current = undefined
      await current?.dispose()
    })
    this.transition = operation.then(() => undefined, () => undefined)
    await operation
  }

  private async activate(
    accesses: readonly ManagedBackendRuntimeServiceModuleAccess[],
    isolateStartupFailures: boolean,
    signal: AbortSignal,
  ): Promise<ManagedServiceNodeActivation> {
    const authority = this.startupAuthority
      ?? new ManagedServiceStartupAuthority({
        profileId: this.profileId,
        hostGeneration: accesses[0]?.hostGeneration ?? this.runtimeGeneration,
      })
    for (const access of accesses) {
      if (access.hostGeneration !== authority.options.hostGeneration) {
        throw new Error('startup Host generation mismatch')
      }
      if (
        access.startup !== undefined && (access.startup.pluginId !== access.pluginIdentity.pluginId
          || access.startup.pluginGeneration !== access.pluginIdentity.generation
          || access.startup.source !== access.pluginIdentity.source
          || access.startup.sourceRevision !== access.packageIdentity.integrity)
      ) throw new Error('startup declaration owner mismatch')
    }
    const admissions = [
      ...new Map(
        accesses.flatMap(access =>
          access.startup === undefined ? [] : [[access.pluginIdentity.pluginId, access.startup] as const]
        ),
      ).values(),
    ]
    authority.admit(admissions)
    if (this.startupAuthority === undefined) {
      authority.selectOwners(
        accesses.map(access => ({
          pluginId: access.pluginIdentity.pluginId,
          pluginGeneration: access.pluginIdentity.generation,
        })),
      )
    }
    const preparation = new ManagedServiceStartupPreparation(authority, this.runtime, accesses)
    const rootContext = new Context()
    const states: ModuleState[] = []
    const providers = new Map<string, ProviderState>()
    const cleanup: (() => void | Promise<void>)[] = [async () => await rootContext.fiber.dispose()]
    const inFlight = new Set<Promise<void>>()
    let cleanupPromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        for (const state of states) state.controller.abort(new Error('managed service activation disposed'))
        await preparation.disposeModules(states)
        preparation.dispose()
        if (this.startupAuthority === undefined) authority.dispose()
        await Promise.allSettled([...inFlight])
        await settleCleanup([...cleanup].reverse())
      })()
      return cleanupPromise
    }
    try {
      for (const access of accesses) {
        if (!access.pluginIdentity.source.startsWith('https://')) {
          throw new Error('managed backend packages require a canonical HTTPS source')
        }
        signal.throwIfAborted()
        const controller = new AbortController()
        const abort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', abort), { once: true })
        cleanup.push(() => signal.removeEventListener('abort', abort))
        const owner = Object.freeze({
          ownerHandle: `mso_${randomUUID().replaceAll('-', '')}` as const,
          pluginId: access.pluginIdentity.pluginId,
          sourceDigest: access.packageIdentity.integrity,
          hostGeneration: access.hostGeneration,
          pluginGeneration: access.pluginIdentity.generation,
        })
        const binding = this.runtime.bind({
          owner,
          source: access.pluginIdentity.source as `https://${string}`,
          declaration: access.declaration,
          artifactDirectory: access.artifactDirectory,
          ...(access.runtimeResources === undefined ? {} : { runtimeResources: access.runtimeResources }),
          ...(access.startup === undefined ? {} : {
            publicationExecutable: providerId => {
              const capability = access.startup!.startup.capabilities.find(capability =>
                capability.kind === 'provider' && capability.providerId === providerId
              )
              return capability !== undefined
                && authority.availability(
                  { pluginId: owner.pluginId, capabilityId: capability.id },
                  undefined,
                  new Map([
                    ...authority.ownerSelections(),
                    ...accesses.map(item => [item.pluginIdentity.pluginId, item.pluginIdentity.generation] as const),
                  ]),
                ).available
            },
            publicationAllowed: (input, current) =>
              authority.acceptsPublication(
                {
                  pluginId: owner.pluginId,
                  pluginGeneration: owner.pluginGeneration,
                  serviceId: access.serviceId,
                  serviceGeneration: current.serviceGeneration,
                },
                input.providerId,
                input.compositionOrigin,
                input.catalog,
              ),
          }),
        }, controller.signal)
        const state: ModuleState = { access, module: undefined, binding, controller }
        states.push(state)
        if (access.startup !== undefined) authority.bindService(binding.authority)
        cleanup.push(async () => await binding.dispose())
        const imported = await import(
          `${pathToFileURL(modulePath(access)).href}?generation=${encodeURIComponent(access.pluginIdentity.generation)}`
        ) as Record<string, unknown>
        if ('inject' in imported) throw new Error('managed backend service module-level inject is invalid')
        if (typeof imported.apply !== 'function') throw new Error('managed backend service exports no apply function')
        state.module = imported as unknown as ManagedServiceNodeModuleV1
        if (access.startup !== undefined) {
          const configuration = resolveManagedServiceConfiguration(access.selectedConfiguration, imported.Config)
          if (configuration !== undefined) state.configuration = configuration
        }
        if (
          access.startup?.startup.capabilities.some(capability => capability.serviceId === access.serviceId)
          && typeof imported.prepare !== 'function'
        ) throw new Error('progressive managed service exports no prepare function')
      }
      const configurations = new Map<string, StartupManagedServiceConfigurationV1 | undefined>()
      for (const state of states) {
        if (state.access.startup === undefined) continue
        const owner = JSON.stringify([
          state.access.pluginIdentity.source,
          state.access.pluginIdentity.pluginId,
          state.access.pluginIdentity.generation,
        ])
        if (configurations.has(owner) && !isDeepStrictEqual(configurations.get(owner), state.configuration)) {
          throw new Error('managed service Config differs within one plugin generation')
        }
        if (!configurations.has(owner)) configurations.set(owner, state.configuration)
        const configuration = configurations.get(owner)
        if (configuration !== undefined) state.configuration = configuration
      }
      for (const state of states) {
        const module = state.module!
        if (module.contextServices !== undefined && !Array.isArray(module.contextServices)) {
          throw new Error('managed backend service contextServices export is invalid')
        }
        for (const provider of module.contextServices ?? []) {
          if (
            provider === null || typeof provider !== 'object' || typeof provider.create !== 'function'
            || !SERVICE_NAME.test(provider.service) || isReservedService(rootContext, provider.service)
            || providers.has(provider.service)
          ) throw new Error(`managed context service ${provider.service} is invalid or duplicated or reserved`)
          providers.set(provider.service, { module: state, provider, root: undefined })
        }
      }
      this.validateDependencies(states, providers)
      const groups = managedServiceStartupGroups(
        states,
        state => `${state.access.pluginIdentity.source}\u0000${state.access.pluginIdentity.pluginId}`,
        state =>
          injectionNames(state.module!.apply).flatMap(name => {
            const provider = providers.get(name)
            return provider === undefined ? [] : [provider.module]
          }),
      )
      const groupDisposals = new Map<readonly ModuleState[], () => Promise<void>>()
      const adoptedSources = new Map<readonly ModuleState[], readonly ManagedServiceNodeSourceBinding[]>()
      const sourceListeners = new Set<() => void>()
      const changedSources = () => {
        for (const listener of sourceListeners) {
          try {
            listener()
          } catch { /* Reader isolation. */ }
        }
      }
      const subscribeSources = (listener: () => void) => {
        sourceListeners.add(listener)
        return () => {
          sourceListeners.delete(listener)
        }
      }
      const pendingGroups = groups.map(async group => {
        const groupProviders = new Map([...providers].filter(([, provider]) => group.includes(provider.module)))
        const groupCleanup: (() => void | Promise<void>)[] = []
        const pending = new Set<Promise<void>>()
        let groupDisposal: Promise<void> | undefined
        const disposeGroup = (): Promise<void> => {
          groupDisposal ??= (async () => {
            for (const state of group) state.controller.abort(new Error('managed service activation disposed'))
            adoptedSources.delete(group)
            changedSources()
            await preparation.disposeModules(group)
            await Promise.allSettled([...pending])
            await settleCleanup([
              ...groupCleanup.slice().reverse(),
              ...group.map(state => () => state.binding.dispose()),
            ])
          })()
          return groupDisposal
        }
        groupDisposals.set(group, disposeGroup)
        cleanup.push(disposeGroup)
        const startBatch = async (batch: readonly ModuleState[]): Promise<void> => {
          const operations = batch.map(state => this.startModule(rootContext, state, groupProviders, groupCleanup))
          for (const operation of operations) pending.add(operation)
          await Promise.all(operations)
          for (const operation of operations) pending.delete(operation)
        }
        try {
          for (const state of groupProviders.values()) {
            const creating = (async () => {
              const root = await state.provider.create({
                target: state.module.binding.authority,
                signal: state.module.controller.signal,
              })
              if (
                root === null || typeof root !== 'object' || typeof root.bind !== 'function'
                || typeof root.dispose !== 'function'
              ) {
                if (root !== null && typeof root === 'object' && typeof root.dispose === 'function') {
                  await root.dispose()
                }
                throw new Error(`managed context service ${state.provider.service} returned an invalid root`)
              }
              state.root = root
              groupCleanup.push(async () => await root.dispose())
              state.module.controller.signal.throwIfAborted()
            })()
            pending.add(creating)
            await creating
            pending.delete(creating)
          }
          const providerOwners = new Set([...groupProviders.values()].map(provider => provider.module))
          await startBatch(group.filter(state => !providerOwners.has(state)))
          for (const batch of this.providerOwnerBatches(group, groupProviders)) await startBatch(batch)
          for (const state of group) state.controller.signal.throwIfAborted()
          const sources = group.flatMap(state => {
            const source = adoptedManagedServiceSource(state, this.runtime, this.profileId, this.runtimeGeneration)
            return source === undefined ? [] : [source]
          })
          preparation.adopt(
            group.filter(state =>
              state.access.startup?.startup.capabilities.some(capability =>
                capability.serviceId === state.access.serviceId
              )
            )
              .map(state => ({
                ...state,
                module: state.module as StartupManagedServiceNodeModuleV1,
                context: state.context!,
              })),
          )
          adoptedSources.set(group, Object.freeze(sources))
          changedSources()
        } catch (error) {
          const canceled = group.some(state => state.controller.signal.aborted)
          await disposeGroup()
          if (canceled) {
            for (const state of group) authority.revoke(state.binding.authority)
            throw error
          }
          signal.throwIfAborted()
          if (!isolateStartupFailures) throw error
          for (const state of group) {
            if (state.access.startup !== undefined) authority.settled(state.binding.authority, true)
            reportManagedServiceStartup({
              pluginId: state.access.pluginIdentity.pluginId,
              serviceId: state.access.serviceId,
              reason: 'activation-failed',
            })
          }
        }
      })
      for (const operation of pendingGroups) inFlight.add(operation)
      const adopted = Promise.all(pendingGroups).then(() => {
        signal.throwIfAborted()
      })
      const coreReady = Promise.all(
        pendingGroups.filter((_, index) => groups[index]!.some(blocksCoreReadiness)),
      ).then(() => {
        signal.throwIfAborted()
      })
      void adopted.catch(() => undefined)
      void coreReady.catch(() => undefined)

      const runtime = this.runtime
      let remainingGroups = groups.length
      const activations = groups.map((group, index) => {
        const pluginIds = Object.freeze([...new Set(group.map(state => state.access.pluginIdentity.pluginId))])
        const nativeSessions = new Set<NativeManagedGatewayConnectionSession>()
        let groupDisposal: Promise<void> | undefined
        const disposeActivation = (): Promise<void> => {
          groupDisposal ??= (async () => {
            for (const session of nativeSessions) session.dispose()
            nativeSessions.clear()
            try {
              await groupDisposals.get(group)!()
            } finally {
              remainingGroups -= 1
              if (remainingGroups === 0) {
                sourceListeners.clear()
                preparation.dispose()
                if (this.startupAuthority === undefined) authority.dispose()
                await rootContext.fiber.dispose()
              }
            }
          })()
          return groupDisposal
        }
        const value: ManagedServiceNodeActivationGroup = Object.freeze({
          pluginIds,
          adopted: pendingGroups[index]!,
          coreReady: group.some(blocksCoreReadiness)
            ? pendingGroups[index]!
            : Promise.resolve(),
          subscribeSources,
          startup: authority,
          retryStartup: (ref: import('@cordisx/protocol/startup/v1').StartupCapabilityRefV1) => preparation.retry(ref),
          get exclusiveServiceKeys() {
            return runtime.exclusiveServiceKeys(pluginIds)
          },
          get activeLoopbackPorts() {
            return runtime.activeLoopbackPorts(pluginIds)
          },
          hostGeneration: group[0]?.access.hostGeneration ?? randomUUID(),
          get authorities() {
            return adoptedSources.has(group) ? group.map(state => state.binding.authority) : []
          },
          get sources() {
            return adoptedSources.get(group) ?? []
          },
          get nativeProviderIds() {
            return adoptedSources.has(group) ? runtime.listNativeProviderIds(pluginIds) : []
          },
          subscribeNativeProviders: (listener: () => void) => {
            const stopRuntime = runtime.subscribeNativeProviders(listener)
            const stopSources = subscribeSources(listener)
            return () => {
              stopRuntime()
              stopSources()
            }
          },
          prepareNativeConnection: (providerId: string) => {
            if (
              !PROVIDER_ID.test(providerId) || groupDisposal !== undefined || !adoptedSources.has(group)
              || !runtime.listNativeProviderIds(pluginIds).includes(providerId)
            ) {
              throw new Error('native managed gateway provider is unavailable')
            }
            const session = runtime.preparePublishedNativeConnection(providerId)
            nativeSessions.add(session)
            return Object.freeze({
              value: session.value,
              dispose: () => {
                nativeSessions.delete(session)
                session.dispose()
              },
            })
          },
          dispose: disposeActivation,
        })
        return value
      })
      cleanup.push(async () => {
        await Promise.all(activations.map(group => group.dispose()))
      })
      if (admissions.length === 0) await adopted
      return Object.freeze({
        adopted,
        coreReady,
        subscribeSources,
        groups: Object.freeze(activations),
        startup: authority,
        retryStartup: (ref: import('@cordisx/protocol/startup/v1').StartupCapabilityRefV1) => preparation.retry(ref),
        hostGeneration: accesses[0]?.hostGeneration ?? randomUUID(),
        get authorities() {
          return activations.flatMap(group => group.authorities)
        },
        get sources() {
          return activations.flatMap(group => group.sources)
        },
        get nativeProviderIds() {
          return activations.flatMap(group => group.nativeProviderIds)
        },
        subscribeNativeProviders: (listener: () => void) => {
          const stopRuntime = runtime.subscribeNativeProviders(listener)
          const stopSources = subscribeSources(listener)
          return () => {
            stopRuntime()
            stopSources()
          }
        },
        prepareNativeConnection: (providerId: string) => {
          const group = activations.find(group => group.nativeProviderIds.includes(providerId))
          if (group === undefined || cleanupPromise !== undefined) {
            throw new Error('native managed gateway provider is unavailable')
          }
          return group.prepareNativeConnection(providerId)
        },
        dispose,
      })
    } catch (error) {
      await dispose().catch(() => undefined)
      throw error
    }
  }

  private validateDependencies(states: readonly ModuleState[], providers: ReadonlyMap<string, ProviderState>): void {
    const graph = new Map<ModuleState, Set<ModuleState>>(states.map(state => [state, new Set()]))
    for (const state of states) {
      for (const service of injectionNames(state.module!.apply)) {
        if (service === 'managedServices') continue
        const provider = providers.get(service)
        if (provider === undefined) throw new Error(`managed context service ${service} is unavailable`)
        if (provider.module !== state) graph.get(state)!.add(provider.module)
      }
    }
    const visiting = new Set<ModuleState>()
    const visited = new Set<ModuleState>()
    const visit = (state: ModuleState): void => {
      if (visiting.has(state)) throw new Error('managed context service dependency cycle')
      if (visited.has(state)) return
      visiting.add(state)
      for (const dependency of graph.get(state)!) visit(dependency)
      visiting.delete(state)
      visited.add(state)
    }
    for (const state of states) visit(state)
  }

  private providerOwnerBatches(
    states: readonly ModuleState[],
    providers: ReadonlyMap<string, ProviderState>,
  ): readonly (readonly ModuleState[])[] {
    const owners = new Set([...providers.values()].map(provider => provider.module))
    const remaining = new Set(owners)
    const batches: ModuleState[][] = []
    while (remaining.size > 0) {
      const batch = states.filter(state =>
        remaining.has(state)
        && ![...remaining].some(consumer =>
          consumer !== state
          && injectionNames(consumer.module!.apply).some(service => providers.get(service)?.module === state)
        )
      )
      if (batch.length === 0) throw new Error('managed context service dependency cycle')
      batches.push(batch)
      for (const state of batch) remaining.delete(state)
    }
    return batches
  }

  private async startModule(
    root: Context,
    state: ModuleState,
    providers: ReadonlyMap<string, ProviderState>,
    cleanup: (() => void | Promise<void>)[],
  ): Promise<void> {
    state.controller.signal.throwIfAborted()
    const apply = state.module!.apply
    const requested = injectionNames(apply)
    const values = new Map<string, unknown>([['managedServices', state.binding.registry]])
    for (const provider of providers.values()) {
      if (provider.module === state) values.set(provider.provider.service, providerRoot(provider).providerValue)
    }
    for (const service of requested) {
      if (service === 'managedServices') continue
      const provider = providers.get(service)
      if (provider === undefined) throw new Error(`managed context service ${service} is unavailable`)
      if (provider.module === state) continue
      const binding = await providerRoot(provider).bind({
        producer: {
          pluginId: state.access.pluginIdentity.pluginId,
          pluginGeneration: state.access.pluginIdentity.generation,
        },
        target: provider.module.binding.authority,
        signal: state.controller.signal,
      })
      if (binding === null || typeof binding !== 'object' || typeof binding.dispose !== 'function') {
        throw new Error(`managed context service ${service} returned an invalid binding`)
      }
      if (state.controller.signal.aborted) {
        await binding.dispose()
        throw state.controller.signal.reason ?? new Error('managed service activation disposed')
      }
      cleanup.push(async () => await binding.dispose())
      values.set(service, binding.value)
    }
    let scope = root
    for (const service of values.keys()) scope = scope.isolate(service)
    const provide: Plugin.Function = context => {
      for (const [service, value] of values) context.provide(service, value)
    }
    const providerFiber = scope.plugin(provide)
    cleanup.push(async () => await providerFiber.dispose())
    await providerFiber
    const plugin: Plugin.Function = async context => {
      state.controller.signal.throwIfAborted()
      state.context = context as unknown as ManagedServiceServiceContextV1
      const input: StartupManagedServiceApplyInputV1 = {
        ...(state.configuration === undefined ? {} : { configuration: state.configuration }),
        owner: state.binding.owner,
        client: state.binding.client,
        signal: state.binding.signal,
      }
      await apply(state.context, input)
    }
    plugin.inject = ['managedServices', ...requested.filter(service => service !== 'managedServices')]
    const fiber = scope.plugin(plugin)
    cleanup.push(async () => await fiber.dispose())
    await fiber
    state.controller.signal.throwIfAborted()
  }
}
