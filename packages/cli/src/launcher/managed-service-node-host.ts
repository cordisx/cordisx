import type {
  ManagedServiceContextBindingV1,
  ManagedServiceContextProviderRootV1,
  ManagedServiceContextProviderV1,
  ManagedServiceNodeModuleV1,
  ManagedServiceNodeUISourceExtensionV1,
} from '@cordisx/protocol/managed-service-context/v1'
import type {
  ManagedServiceIdentityV1,
  ManagedServiceServiceContextV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { Context, Inject, type Plugin } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'
import {
  type ManagedServiceActivationBinding,
  type ManagedServiceContextAuthorityV1,
  ManagedServiceRuntime,
} from './managed-service-runtime.js'
import { createManagedServiceSource, type ManagedServiceNodeSourceBinding } from './managed-service-ui-source.js'

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
  readonly binding: ManagedServiceActivationBinding
  readonly controller: AbortController
}

export interface ManagedServiceNodeActivation {
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

  constructor(
    private readonly runtime: ManagedServiceRuntime,
    private readonly profileId: string = 'default',
    private readonly runtimeGeneration: string = randomUUID(),
  ) {}

  async replace(accesses: readonly ManagedBackendRuntimeServiceModuleAccess[]): Promise<ManagedServiceNodeActivation> {
    const operation = this.transition.then(async () => {
      const previous = this.current
      this.current = undefined
      await previous?.dispose()
      const activation = await this.activate(accesses)
      this.current = activation
      return activation
    })
    this.transition = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async dispose(): Promise<void> {
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
  ): Promise<ManagedServiceNodeActivation> {
    const rootContext = new Context()
    const states: ModuleState[] = []
    const providers = new Map<string, ProviderState>()
    const cleanup: (() => void | Promise<void>)[] = [async () => await rootContext.fiber.dispose()]
    const inFlight = new Set<Promise<void>>()
    let cleanupPromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        for (const state of states) state.controller.abort(new Error('managed service activation disposed'))
        await Promise.allSettled([...inFlight])
        await settleCleanup([...cleanup].reverse())
      })()
      return cleanupPromise
    }
    const startBatch = async (batch: readonly ModuleState[]): Promise<void> => {
      const pending = batch.map(state => this.startModule(rootContext, state, providers, cleanup))
      for (const promise of pending) inFlight.add(promise)
      await Promise.all(pending)
      for (const promise of pending) inFlight.delete(promise)
    }
    try {
      for (const access of accesses) {
        if (!access.pluginIdentity.source.startsWith('https://')) {
          throw new Error('managed backend packages require a canonical HTTPS source')
        }
        const controller = new AbortController()
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
        }, controller.signal)
        const state: ModuleState = { access, module: undefined, binding, controller }
        states.push(state)
        cleanup.push(async () => await binding.dispose())
        const imported = await import(
          `${pathToFileURL(modulePath(access)).href}?generation=${encodeURIComponent(access.pluginIdentity.generation)}`
        ) as Record<string, unknown>
        if ('inject' in imported) throw new Error('managed backend service module-level inject is invalid')
        if (typeof imported.apply !== 'function') throw new Error('managed backend service exports no apply function')
        state.module = imported as unknown as ManagedServiceNodeModuleV1
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
      for (const state of providers.values()) {
        const root = await state.provider.create({
          target: state.module.binding.authority,
          signal: state.module.controller.signal,
        })
        if (
          root === null || typeof root !== 'object' || typeof root.bind !== 'function'
          || typeof root.dispose !== 'function'
        ) {
          if (root !== null && typeof root === 'object' && typeof root.dispose === 'function') await root.dispose()
          throw new Error(`managed context service ${state.provider.service} returned an invalid root`)
        }
        state.root = root
        cleanup.push(async () => await root.dispose())
      }
      const providerOwners = new Set([...providers.values()].map(provider => provider.module))
      await startBatch(states.filter(state => !providerOwners.has(state)))
      for (const batch of this.providerOwnerBatches(states, providers)) await startBatch(batch)
      inFlight.clear()
      const sources: ManagedServiceNodeSourceBinding[] = []
      for (const state of states) {
        const identity: ManagedServiceIdentityV1 = {
          source: state.access.pluginIdentity.source as `https://${string}`,
          pluginId: state.access.pluginIdentity.pluginId,
          serviceId: state.access.declaration.id,
        }
        const handle = this.runtime.getRegistrationHandle(identity)
        if (handle === undefined) continue
        const authMode = this.runtime.getAuthenticationMode(identity) ?? 'none'
        const declaration = state.access.declaration
        const sourceOptions = {
          profileId: this.profileId,
          runtimeGeneration: this.runtimeGeneration,
          registrationHandle: handle,
          healthIntervalMs: this.runtime.getHealthIntervalMs(identity) ?? 30_000,
          displayName: declaration.id,
          serviceKind: 'managed-backend',
          pluginId: identity.pluginId,
          pluginGeneration: state.access.pluginIdentity.generation,
          serviceId: identity.serviceId,
          source: identity.source,
          authenticationMode: authMode,
          logoutAvailable: this.runtime.supportsLogout(identity),
          ...(state.module!.managedServiceUI === undefined
            ? {}
            : {
              extensionFactory: (
                binding: Parameters<
                  NonNullable<ManagedServiceNodeModuleV1['managedServiceUI']>['create']
                >[0]['binding'],
              ) => {
                const ui = state.module!.managedServiceUI!
                if (ui.serviceId !== identity.serviceId || typeof ui.create !== 'function') {
                  throw new Error('managed service UI source declaration is invalid')
                }
                const extension: ManagedServiceNodeUISourceExtensionV1 = ui.create({
                  binding,
                  registration: handle,
                  client: state.binding.client,
                  signal: state.binding.signal,
                })
                if (extension === null || typeof extension !== 'object') {
                  throw new Error('managed service UI source extension is invalid')
                }
                return extension
              },
            }),
        }
        const source = createManagedServiceSource(sourceOptions)
        const loginTimeoutMs = this.runtime.getLoginTimeoutMs(identity)
        sources.push(Object.freeze({
          pluginId: identity.pluginId,
          pluginGeneration: state.access.pluginIdentity.generation,
          serviceId: identity.serviceId,
          ...(loginTimeoutMs === undefined ? {} : { loginTimeoutMs }),
          source,
        }))
      }

      const runtime = this.runtime
      const nativeSessions = new Set<NativeManagedGatewayConnectionSession>()
      cleanup.push(() => {
        for (const session of nativeSessions) session.dispose()
        nativeSessions.clear()
      })
      return Object.freeze({
        hostGeneration: accesses[0]?.hostGeneration ?? randomUUID(),
        authorities: Object.freeze(states.map(state => state.binding.authority)),
        sources: Object.freeze(sources),
        get nativeProviderIds() {
          return runtime.listNativeProviderIds()
        },
        subscribeNativeProviders: listener => runtime.subscribeNativeProviders(listener),
        prepareNativeConnection: (providerId: string) => {
          if (!PROVIDER_ID.test(providerId) || cleanupPromise !== undefined) {
            throw new Error('native managed gateway provider is unavailable')
          }
          const session = this.runtime.preparePublishedNativeConnection(providerId)
          nativeSessions.add(session)
          return Object.freeze({
            value: session.value,
            dispose: () => {
              nativeSessions.delete(session)
              session.dispose()
            },
          })
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
      await apply(context as unknown as ManagedServiceServiceContextV1, {
        owner: state.binding.owner,
        client: state.binding.client,
        signal: state.binding.signal,
      })
    }
    plugin.inject = ['managedServices', ...requested.filter(service => service !== 'managedServices')]
    const fiber = scope.plugin(plugin)
    cleanup.push(async () => await fiber.dispose())
    await fiber
  }
}
