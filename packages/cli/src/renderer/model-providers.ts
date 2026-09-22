import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import type {
  ModelProviderModelV1,
  ModelProviderPresentationV1,
  ModelProviderSelectorEntryV1,
  ModelProvidersV1,
  ModelProviderV1,
} from '@cordisx/protocol/model-providers/v1'
import type { NotificationsV1 } from '../notification-contracts.js'
import type { ModelBrandChoice, ProviderBrandChoice, ProviderBrandProjection } from '../model-selector-branding.js'
import { isModelBrandChoice, isProviderBrandChoice } from '../model-selector-branding.js'
import type { GenerationVisibilityCoordinator, PluginGenerationEffectIdentity } from './generation-visibility.js'
import { ModelCatalogClient } from './model-catalog-client.js'

export interface NativeProviderProjection {
  readonly providerId: string
  readonly pluginId: string
  readonly title?: string
  readonly selectorBrand?: ProviderBrandProjection
  readonly models: readonly HostModelProviderModel[]
  readonly defaultModelId?: string
}

export interface HostModelProviderModel extends ModelProviderModelV1 {
  readonly selectorBrand?: ModelBrandChoice
  readonly provenance?: readonly ('auto' | 'native' | 'manual' | 'manual-supplement' | 'script' | 'script-supplement')[]
  readonly notListed?: boolean
}

export interface HostModelProvider extends Omit<ModelProviderV1, 'models'> {
  readonly models: readonly HostModelProviderModel[]
  readonly selectorBrand?: ProviderBrandChoice
}

export interface ModelProviderSnapshot {
  readonly providers: readonly HostModelProvider[]
  readonly entries: readonly {
    readonly key: string
    readonly entry: ModelProviderSelectorEntryV1
    readonly notifications?: NotificationsV1
  }[]
  readonly loading: boolean
  readonly error?: string
}

export function nativeModelProviderRegistry(managed?: {
  nativeProviders(): Promise<readonly NativeProviderProjection[]>
}): ModelProviderRegistry {
  const channel = (globalThis as typeof globalThis & {
    __cordisxNativeProviderCommandChannel?:
      import('./native-provider-selection-client.js').NativeProviderSelectionCommandChannel
  }).__cordisxNativeProviderCommandChannel
  const registry = new ModelProviderRegistry(async () =>
    channel?.catalogSnapshotRead !== undefined
      ? (await channel.catalogSnapshotRead()).providers
      : channel?.catalogRead === undefined
      ? await managed?.nativeProviders() ?? []
      : await channel.catalogRead()
  )
  if (channel?.catalogSubscribe) registry.connectSource(channel.catalogSubscribe)
  if (channel?.catalogManagementRead && channel.catalogManagementSubscribe && channel.catalogManagementCommand) {
    registry.management = new ModelCatalogClient({
      catalogManagementRead: () => channel.catalogManagementRead!(),
      catalogManagementSubscribe: listener => channel.catalogManagementSubscribe!(listener),
      catalogManagementCommand: command => channel.catalogManagementCommand!(command),
    })
  }
  return registry
}

function modelIdentities(model: ModelProviderModelV1): ReadonlySet<string> {
  const separator = model.id.indexOf('/')
  const providerPrefix = separator > 0 ? model.id.slice(0, separator).toLowerCase() : undefined
  const identities = [model.id, ...model.aliases ?? []].flatMap(identity => {
    const normalized = identity.trim().toLowerCase()
    const local = providerPrefix !== undefined && normalized.startsWith(`${providerPrefix}/`)
      ? normalized.slice(providerPrefix.length + 1)
      : normalized
    return providerPrefix !== undefined && local.startsWith(`${providerPrefix}-`)
      ? [normalized, local, local.slice(providerPrefix.length + 1)]
      : [normalized, local]
  })
  return new Set(identities.filter(identity => identity.length > 0))
}

export function equivalentModel(
  current: ModelProviderModelV1,
  models: readonly ModelProviderModelV1[],
): ModelProviderModelV1 | undefined {
  const exact = models.find(model => model.id === current.id)
  if (exact) return exact
  const identities = modelIdentities(current)
  const matches = models.filter(model => [...modelIdentities(model)].some(identity => identities.has(identity)))
  return matches.length === 1 ? matches[0] : undefined
}

function label(value: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error('Invalid model provider label')
  }
  return value
}

export class ModelProviderRegistry {
  management?: ModelCatalogClient
  private disconnectSource?: () => void
  private sourceReconcile?: ReturnType<typeof setInterval>

  hasLiveSource(): boolean {
    return this.disconnectSource !== undefined
  }

  connectSource(subscribe: (listener: () => void) => () => void): void {
    if (this.disposed) return
    this.disconnectSource?.()
    if (this.sourceReconcile) clearInterval(this.sourceReconcile)
    const refresh = () => {
      void this.refresh()
    }
    this.disconnectSource = subscribe(refresh)
    // Full snapshots also repair missed invalidations and read/subscribe races.
    this.sourceReconcile = setInterval(refresh, 30_000)
    this.sourceReconcile.unref?.()
    refresh()
  }
  private projections: readonly NativeProviderProjection[] = []
  private readonly presentations = new Map<
    string,
    {
      key: string
      owner: string
      generation: PluginGenerationEffectIdentity
      value: ModelProviderPresentationV1
    }
  >()
  private readonly entries = new Map<
    string,
    {
      key: string
      owner: string
      generation: PluginGenerationEffectIdentity
      value: ModelProviderSelectorEntryV1
      abort: AbortController
      notifications?: NotificationsV1
    }
  >()
  private readonly listeners = new Set<() => void>()
  private state: ModelProviderSnapshot = { providers: [], entries: [], loading: false }
  private revision = 0
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(
    private readonly load: () => Promise<readonly NativeProviderProjection[]>,
    private readonly visibility?: GenerationVisibilityCoordinator,
  ) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.emit() })
  }

  snapshot = (): ModelProviderSnapshot => this.state
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  refresh = async (): Promise<void> => {
    if (this.disposed) return
    const revision = ++this.revision
    this.emit(true)
    try {
      const projections = await this.load()
      if (this.disposed || revision !== this.revision) return
      this.projections = projections.map(provider =>
        Object.freeze({
          providerId: label(provider.providerId),
          pluginId: label(provider.pluginId),
          ...(provider.title === undefined ? {} : { title: label(provider.title) }),
          ...(isProviderBrandChoice(provider.selectorBrand?.brand)
              && (provider.selectorBrand?.source === 'override' || provider.selectorBrand?.source === 'inferred')
            ? { selectorBrand: Object.freeze({ ...provider.selectorBrand }) }
            : {}),
          ...(provider.defaultModelId === undefined ? {} : { defaultModelId: label(provider.defaultModelId, 512) }),
          models: Object.freeze(provider.models.map(model =>
            Object.freeze({
              id: label(model.id, 512),
              label: label(model.label),
              ...(model.aliases === undefined
                ? {}
                : { aliases: Object.freeze(model.aliases.map(alias => label(alias))) }),
              ...(model.group === undefined ? {} : { group: label(model.group) }),
              ...(isModelBrandChoice(model.selectorBrand) ? { selectorBrand: model.selectorBrand } : {}),
              ...(model.provenance === undefined ? {} : {
                provenance: Object.freeze(
                  model.provenance.filter(value =>
                    ['auto', 'native', 'manual', 'manual-supplement', 'script', 'script-supplement'].includes(value)
                  ),
                ),
              }),
              ...(model.notListed === true ? { notListed: true } : {}),
            })
          )),
        })
      )
      this.emit(false)
    } catch {
      if (!this.disposed && revision === this.revision) {
        // Failed readback cannot leave stale providers selectable.
        this.projections = []
        this.emit(false, 'provider-catalog-unavailable')
      }
    }
  }

  bind(pluginId: string, generation: string, live: () => boolean, notifications?: NotificationsV1): {
    readonly facade: ModelProvidersV1
    dispose(): void
  } {
    const owner = JSON.stringify([pluginId, generation])
    const generationIdentity = Object.freeze({ pluginId, moduleGeneration: generation })
    let disposed = false
    const cleanups = new Set<() => void>()
    const assertLive = () => {
      if (disposed || this.disposed || !live()) throw new Error('Model provider contribution owner is unavailable')
    }
    const own = (cleanup: () => void) => {
      let removed = false
      const dispose = () => {
        if (removed) return
        removed = true
        cleanups.delete(dispose)
        cleanup()
      }
      cleanups.add(dispose)
      return dispose
    }
    return {
      facade: {
        contract: 'cordisx.model-providers/v1',
        list: () => {
          assertLive()
          return this.state.providers
        },
        refresh: async () => {
          assertLive()
          await this.refresh()
        },
        subscribe: listener => {
          assertLive()
          return own(this.subscribe(listener))
        },
        present: input => {
          assertLive()
          const providerId = label(input.providerId)
          const key = JSON.stringify([pluginId, providerId])
          const physicalKey = JSON.stringify([key, generation])
          if (this.presentations.has(physicalKey)) throw new Error('Duplicate model provider presentation')
          this.presentations.set(physicalKey, {
            key,
            owner,
            generation: generationIdentity,
            value: Object.freeze({
              providerId,
              title: label(input.title),
              icon: cloneBrandIconV1(input.icon),
              ...(input.models === undefined ? {} : {
                models: Object.freeze(input.models.map(model =>
                  Object.freeze({
                    id: label(model.id, 512),
                    label: label(model.label),
                    ...(model.group === undefined ? {} : { group: label(model.group) }),
                    ...(model.aliases === undefined
                      ? {}
                      : { aliases: Object.freeze(model.aliases.map(alias => label(alias))) }),
                  })
                )),
              }),
            }),
          })
          if (this.visibility?.visible(generationIdentity) ?? true) this.emit()
          return {
            dispose: own(() => {
              if (this.presentations.get(physicalKey)?.owner === owner) this.presentations.delete(physicalKey)
              if (this.visibility?.visible(generationIdentity) ?? true) this.emit()
            }),
          }
        },
        insert: input => {
          assertLive()
          const key = JSON.stringify([pluginId, label(input.id)])
          const physicalKey = JSON.stringify([key, generation])
          if (this.entries.has(physicalKey)) throw new Error('Duplicate model provider selector entry')
          if (typeof input.action.run !== 'function') throw new Error('Provider action is required')
          const abort = new AbortController()
          const value = Object.freeze({
            id: label(input.id),
            label: label(input.label),
            icon: cloneBrandIconV1(input.icon),
            action: Object.freeze({
              label: label(input.action.label),
              icon: cloneBrandIconV1(input.action.icon),
              run: async (signal: AbortSignal) => {
                assertLive()
                this.visibility?.assertCallable(generationIdentity)
                if (abort.signal.aborted) throw new Error('Provider action was removed')
                await input.action.run(AbortSignal.any([signal, abort.signal]))
              },
            }),
          })
          this.entries.set(physicalKey, {
            key,
            owner,
            generation: generationIdentity,
            value,
            abort,
            ...(notifications === undefined ? {} : { notifications }),
          })
          if (this.visibility?.visible(generationIdentity) ?? true) this.emit()
          return {
            dispose: own(() => {
              abort.abort()
              if (this.entries.get(physicalKey)?.owner === owner) this.entries.delete(physicalKey)
              if (this.visibility?.visible(generationIdentity) ?? true) this.emit()
            }),
          }
        },
      },
      dispose: () => {
        disposed = true
        for (const cleanup of [...cleanups]) cleanup()
      },
    }
  }

  dispose(): void {
    this.management?.dispose()
    this.disconnectSource?.()
    if (this.sourceReconcile) clearInterval(this.sourceReconcile)
    this.disposed = true
    this.revision++
    this.disconnectVisibility?.()
    for (const entry of this.entries.values()) entry.abort.abort()
    this.entries.clear()
    this.presentations.clear()
    this.projections = []
    this.listeners.clear()
  }

  private emit(loading = this.state.loading, error?: string): void {
    if (this.disposed) return
    this.state = Object.freeze({
      providers: Object.freeze(this.projections.map(provider => {
        const key = JSON.stringify([provider.pluginId, provider.providerId])
        const presentation = [...this.presentations.values()].find(item =>
          item.key === key && (this.visibility?.visible(item.generation) ?? true)
        )?.value
        const projectedBrand = isProviderBrandChoice(provider.selectorBrand?.brand)
            && (provider.selectorBrand?.source === 'override' || provider.selectorBrand?.source === 'inferred')
          ? provider.selectorBrand
          : undefined
        const selectorBrand = projectedBrand?.source === 'override'
          ? projectedBrand.brand
          : presentation === undefined
          ? projectedBrand?.brand
          : undefined
        return Object.freeze({
          providerId: provider.providerId,
          title: presentation?.title ?? provider.title ?? provider.providerId,
          icon: presentation?.icon ?? 'host:settings',
          ...(selectorBrand === undefined ? {} : { selectorBrand }),
          models: Object.freeze(provider.models.map(model => {
            const metadata = presentation?.models?.find(item => item.id === model.id)
            return metadata ? Object.freeze({ ...model, ...metadata }) : model
          })),
          ...(provider.defaultModelId === undefined ? {} : { defaultModelId: provider.defaultModelId }),
        })
      })),
      entries: Object.freeze(
        [...this.entries.values()]
          .filter(item => this.visibility?.visible(item.generation) ?? true)
          .map(item =>
            Object.freeze({
              key: item.key,
              entry: item.value,
              ...(item.notifications === undefined ? {} : { notifications: item.notifications }),
            })
          ),
      ),
      loading,
      ...(error === undefined ? {} : { error }),
    })
    for (const listener of this.listeners) listener()
  }
}
