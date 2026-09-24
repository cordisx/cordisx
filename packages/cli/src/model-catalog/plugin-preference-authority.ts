import { createHash, randomUUID } from 'node:crypto'
import type {
  CatalogManagementCommand,
  CatalogManagementResult,
  CatalogManagementSnapshot,
  CatalogManagementView,
} from '../model-catalog-management.js'
import {
  ManagementOverlayError,
  ManagementOverlayStore,
  type ManagementPreferenceData,
  projectManagementOverlay,
} from './management-overlay.js'

export interface PluginPreferenceProvider {
  readonly providerId: string
  readonly pluginId: string
  /** Host-private source generation; changes retire commands even when membership is identical. */
  readonly sourceRevision?: string
  readonly title?: string
  readonly models: readonly {
    readonly id: string
    readonly label: string
    readonly selectable?: boolean
    readonly provenance?: CatalogManagementView['rows'][number]['provenance']
    readonly notListed?: boolean
  }[]
}

export interface PluginPreferenceCatalogProvider extends PluginPreferenceProvider {
  readonly managementBindingRef: string
}

interface PluginPreferenceAuthorityCommonOptions {
  readonly load: () => Promise<readonly PluginPreferenceProvider[]>
  readonly subscribeSource?: (listener: () => void) => () => void
  readonly sourceCurrent?: (
    provider: PluginPreferenceProvider,
    command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>,
  ) => boolean
}

export interface CatalogManagementAuthority {
  snapshot(): CatalogManagementSnapshot
  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult>
  subscribe(listener: () => void): () => void
  close?(): void
}

export type PluginPreferenceAuthorityOptions =
  & PluginPreferenceAuthorityCommonOptions
  & (
    | {
      readonly overlayStore: ManagementOverlayStore
      readonly persist?: never
      readonly initial?: never
    }
    | {
      readonly overlayStore?: never
      readonly persist: (
        preferences: ManagementPreferenceData,
        expectedRevision: number,
        authorized: () => boolean,
      ) => Promise<void>
      readonly initial?: unknown
    }
  )

export const pluginPreferenceBindingRef = (
  provider: Pick<PluginPreferenceProvider, 'pluginId' | 'providerId'>,
) => `plugin:${encodeURIComponent(provider.pluginId)}:${encodeURIComponent(provider.providerId)}`
const scopeRevision = (provider: PluginPreferenceProvider) =>
  createHash('sha256').update(JSON.stringify([
    'plugin-provider-v1',
    provider.pluginId,
    provider.providerId,
    provider.sourceRevision ?? null,
    provider.models.map(model => model.id).sort(),
  ])).digest('hex')
const revision = (provider: PluginPreferenceProvider, overlayRevision: string) =>
  createHash('sha256').update(JSON.stringify([scopeRevision(provider), overlayRevision])).digest('hex')
const bounded = (value: string, maximum = 512) =>
  value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)

function normalizeProviders(providers: readonly PluginPreferenceProvider[]): readonly PluginPreferenceProvider[] {
  const bindings = new Set<string>()
  return Object.freeze(providers.map(provider => {
    if (
      !bounded(provider.pluginId, 128) || !bounded(provider.providerId, 128)
      || provider.sourceRevision !== undefined && !bounded(provider.sourceRevision)
    ) {
      throw new ManagementOverlayError('source-invalid')
    }
    const ref = pluginPreferenceBindingRef(provider)
    if (bindings.has(ref)) throw new ManagementOverlayError('source-invalid')
    bindings.add(ref)
    const ids = new Set<string>()
    const models = provider.models.map(model => {
      if (!bounded(model.id) || !bounded(model.label, 256) || ids.has(model.id)) {
        throw new ManagementOverlayError('source-invalid')
      }
      ids.add(model.id)
      return Object.freeze({ ...model })
    })
    return Object.freeze({ ...provider, models: Object.freeze(models) })
  }))
}

/** Host-owned preferences over plugin catalogs. The plugin source remains read-only. */
export class PluginPreferenceAuthority {
  readonly #epoch = randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #overlay: ManagementOverlayStore
  #providers: readonly PluginPreferenceProvider[] = []
  #sequence = 0
  #closed = false
  #loading = false
  #available = true
  #loaded = false
  #persistError = false
  #refreshDirty = false
  #refreshing: Promise<void> | undefined
  #tail: Promise<unknown> = Promise.resolve()
  #unsubscribe: (() => void) | undefined

  private constructor(private readonly options: PluginPreferenceAuthorityOptions) {
    this.#overlay = options.overlayStore ?? new ManagementOverlayStore(
      async (preferences, expectedRevision, authorized) => {
        try {
          await options.persist(preferences, expectedRevision, () => !this.#closed && authorized())
          this.#persistError = false
        } catch (error) {
          this.#persistError = true
          throw error
        }
      },
      options.initial,
    )
  }

  static async open(options: PluginPreferenceAuthorityOptions): Promise<PluginPreferenceAuthority> {
    const authority = new PluginPreferenceAuthority(options)
    authority.#unsubscribe = options.subscribeSource?.(() => {
      authority.invalidateSource()
      void authority.refresh().catch(() => undefined)
    })
    try {
      await authority.refresh(true)
      return authority
    } catch (error) {
      authority.close()
      throw error
    }
  }

  static bindingRef = pluginPreferenceBindingRef

  preferences(): ManagementPreferenceData {
    return this.#overlay.snapshot()
  }

  private providerFor(command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>) {
    return this.#providers.find(provider => pluginPreferenceBindingRef(provider) === command.bindingRef)
  }

  private sourceAuthorized(
    provider: PluginPreferenceProvider,
    command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>,
  ): boolean {
    if (this.#closed || !this.#available) return false
    const current = this.providerFor(command)
    if (!current || scopeRevision(current) !== command.scopeRevision) return false
    if (command.operation === 'setOverlay' && !current.models.some(model => model.id === command.modelId)) return false
    try {
      return this.options.sourceCurrent?.(provider, command) ?? true
    } catch {
      return false
    }
  }

  catalog(): readonly PluginPreferenceCatalogProvider[] {
    if (this.#closed || !this.#available) return Object.freeze([])
    return Object.freeze(this.#providers.map(provider => {
      const { sourceRevision: _sourceRevision, ...catalogProvider } = provider
      const source = new Map(provider.models.map(model => [model.id, model]))
      const models = this.rows(provider).flatMap(row => {
        if (!row.present || !row.selectable) return []
        const model = source.get(row.id)
        return model === undefined ? [] : [model]
      })
      return Object.freeze({
        ...catalogProvider,
        managementBindingRef: pluginPreferenceBindingRef(provider),
        models: Object.freeze(models),
      })
    }))
  }

  private rows(provider: PluginPreferenceProvider) {
    const ref = pluginPreferenceBindingRef(provider)
    const projected = projectManagementOverlay(
      provider.models.map(model => ({ ...model, selectable: this.#available && model.selectable !== false })),
      this.#overlay.read(ref, scopeRevision(provider)),
    )
    return [
      ...projected.active.map(row =>
        Object.freeze({
          ...row,
          compatibility: 'supported' as const,
          provenance: row.provenance ?? [],
          notListed: row.notListed ?? false,
          ...(row.blocked ? { reason: 'blocked' as const } : !row.selectable ? { reason: 'permission' as const } : {}),
        })
      ),
      ...projected.dormant.map(row =>
        Object.freeze({
          ...row,
          compatibility: 'supported' as const,
          provenance: [] as const,
          notListed: false,
          reason: row.blocked ? 'blocked' as const : 'removed' as const,
        })
      ),
    ]
  }

  snapshot(): CatalogManagementSnapshot {
    const views = this.#providers.map((provider): CatalogManagementView => {
      const ref = pluginPreferenceBindingRef(provider)
      const scope = scopeRevision(provider)
      const overlay = this.#overlay.read(ref, scope)
      const rows = this.rows(provider)
      const preferences = ['setOverlay', 'resetOrder', 'restoreBlocked'] as const
      return Object.freeze({
        bindingRef: ref,
        providerId: provider.providerId,
        title: provider.title ?? provider.providerId,
        scopeRevision: scope,
        revision: revision(provider, overlay.revision),
        sourceKind: 'plugin',
        mode: 'only',
        freshness: this.#available ? 'fresh' : 'stale',
        activity: this.#loading ? 'loading' : 'idle',
        outcome: this.#available ? rows.length === 0 ? 'empty' : 'ok' : 'error',
        autoPaused: false,
        sourceCount: rows.filter(row => row.present && row.compatibility === 'supported').length,
        selectableCount: rows.filter(row => row.selectable).length,
        rows,
        supplement: [],
        sourceCapabilities: [],
        preferenceCapabilities: preferences,
        capabilities: preferences,
        diagnostics: Object.freeze({
          scopeConfirmed: true as const,
          targetState: this.#available && !this.#persistError ? 'applied' as const : 'unavailable' as const,
          ...(!this.#available ? { code: 'unavailable' as const } : this.#persistError
            ? { code: 'persist-failed' as const }
            : {}),
        }),
      })
    })
    return Object.freeze({ epoch: this.#epoch, sequence: this.#sequence, views: Object.freeze(views) })
  }

  refresh(failOnInitialInvalid = false): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#refreshDirty = true
    if (this.#refreshing) return this.#refreshing
    const run = this.refreshLoop(failOnInitialInvalid)
    this.#refreshing = run.finally(() => {
      this.#refreshing = undefined
      if (this.#refreshDirty && !this.#closed) void this.refresh().catch(() => undefined)
    })
    return this.#refreshing
  }

  private invalidateSource(): void {
    if (this.#closed) return
    this.#available = false
    this.changed()
  }

  private async refreshLoop(failOnInitialInvalid: boolean): Promise<void> {
    while (this.#refreshDirty && !this.#closed) {
      this.#refreshDirty = false
      this.#loading = true
      this.changed()
      try {
        const providers = normalizeProviders(await this.options.load())
        if (this.#closed) return
        this.#providers = providers
        this.#available = true
        this.#loaded = true
      } catch (error) {
        if (this.#closed) return
        this.#available = false
        if (failOnInitialInvalid && !this.#loaded && error instanceof ManagementOverlayError) throw error
      } finally {
        this.#loading = false
        this.changed()
      }
    }
  }

  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult> {
    const execute = async (): Promise<CatalogManagementResult> => {
      if (this.#closed || !authorized()) return { status: 'rejected', code: 'permission' }
      if (command.operation === 'createConnection') return { status: 'rejected', code: 'unsupported' }
      if (!['setOverlay', 'resetOrder', 'restoreBlocked'].includes(command.operation)) {
        return { status: 'rejected', code: 'unsupported' }
      }
      const provider = this.providerFor(command)
      if (!provider || command.scopeRevision !== scopeRevision(provider)) {
        return { status: 'conflict', code: 'scope-changed' }
      }
      const overlay = this.#overlay.read(command.bindingRef, command.scopeRevision)
      if (command.expectedRevision !== revision(provider, overlay.revision)) {
        return { status: 'conflict', code: 'conflict' }
      }
      const stillAuthorized = () => authorized() && this.sourceAuthorized(provider, command)
      if (!stillAuthorized()) return { status: 'rejected', code: 'permission' }
      try {
        const scope = {
          bindingRef: command.bindingRef,
          scopeRevision: command.scopeRevision,
          expectedRevision: overlay.revision,
        }
        if (command.operation === 'setOverlay') {
          await this.#overlay.mutate(
            {
              ...scope,
              operation: 'setOverlay',
              modelId: command.modelId,
              ...(command.blocked === undefined ? {} : { blocked: command.blocked }),
              ...(command.pinned === undefined ? {} : { pinned: command.pinned }),
            },
            provider.models.map(model => model.id),
            stillAuthorized,
          )
        } else if (command.operation === 'resetOrder' || command.operation === 'restoreBlocked') {
          await this.#overlay.mutate(
            { ...scope, operation: command.operation },
            provider.models.map(model => model.id),
            stillAuthorized,
          )
        } else {
          return { status: 'rejected', code: 'unsupported' }
        }
        if (!stillAuthorized()) return { status: 'rejected', code: 'permission' }
        this.changed()
        return { status: 'applied', snapshot: this.snapshot() }
      } catch (error) {
        if (!stillAuthorized()) return { status: 'rejected', code: 'permission' }
        return {
          status: 'rejected',
          code: error instanceof ManagementOverlayError ? error.code : 'unavailable',
        }
      }
    }
    const result = this.#tail.then(execute)
    this.#tail = result.catch(() => undefined)
    return result
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    this.#closed = true
    this.#unsubscribe?.()
    this.#listeners.clear()
  }

  private changed(): void {
    this.#sequence++
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }
}

/** Adds plugin preference views and commands to an existing Host-private management channel. */
export class PluginPreferenceManagementAdapter implements CatalogManagementAuthority {
  readonly #epoch = randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribes: (() => void)[]
  #sequence = 0

  constructor(
    private readonly base: CatalogManagementAuthority,
    private readonly plugins: PluginPreferenceAuthority,
  ) {
    this.#unsubscribes = [base.subscribe(() => this.changed()), plugins.subscribe(() => this.changed())]
  }

  snapshot(): CatalogManagementSnapshot {
    const base = this.base.snapshot()
    return Object.freeze({
      epoch: this.#epoch,
      sequence: this.#sequence,
      views: Object.freeze([...base.views, ...this.plugins.snapshot().views]),
      ...(base.canCreateConnection === undefined ? {} : { canCreateConnection: base.canCreateConnection }),
    })
  }

  catalog(): readonly PluginPreferenceCatalogProvider[] {
    return this.plugins.catalog()
  }

  catalogSubscribe(listener: () => void): () => void {
    return this.plugins.subscribe(listener)
  }

  async command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult> {
    const owner = command.operation !== 'createConnection' && command.bindingRef.startsWith('plugin:')
      ? this.plugins
      : this.base
    const result = await owner.command(command, authorized)
    return result.snapshot === undefined ? result : { ...result, snapshot: this.snapshot() }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#listeners.clear()
    this.plugins.close()
    this.base.close?.()
  }

  private changed(): void {
    this.#sequence++
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }
}
