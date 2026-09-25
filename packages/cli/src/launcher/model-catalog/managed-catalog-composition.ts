import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import type {
  CatalogManagementCommand,
  CatalogManagementResult,
  CatalogManagementSnapshot,
  CatalogManagementView,
} from '../../model-catalog-management.js'
import {
  emptyManagementPreferenceData,
  type ManagementOverlay,
  ManagementOverlayError,
  ManagementOverlayStore,
  parseManagementOverlayData,
  projectManagementOverlay,
} from '../../model-catalog/management-overlay.js'
import { resolveNativeModelEligibility } from '../../renderer/native-provider-submission-policy.js'
import type { NativeModelProviderCatalogEntry } from '../native-model-provider-catalog.js'
import { builtinDiscoveryRegistry } from './builtin-registry.js'
import { type CatalogBinding, CatalogError, type CatalogSnapshot, object } from './contracts.js'
import { ManagedProviderOwner } from './managed-provider-owner.js'
import { managedProviderSettings, type ManagedProviderView } from './managed-provider-schema.js'
import { captureManagedProviderCredential } from './managed-provider-capture.js'
import { ModelCatalogService } from './service.js'
import { ScriptSourceRuntime } from './script-runtime.js'
import { parseScriptSourceConfig } from './script-schema.js'
import { composeScriptMembers } from './script-composition.js'
import { type ScriptSourceConfig, ScriptSourceError } from './script-types.js'
import { withAbort } from './abort.js'
import type { ProviderSyncConnectionDefinition } from '../provider-profile-sync-contracts.js'

type ScriptSetting = {
  scopeRevision: string
  strategy: string
  mode: 'replace' | 'supplement'
  config: ScriptSourceConfig
}
type StoredState = {
  version: 1
  overlays?: unknown
  modelPreferences?: unknown
  scripts: Record<string, ScriptSetting>
  caches: Record<string, CatalogSnapshot>
  readonly [key: string]: unknown
}
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function readLegacyNativePreferences(file: string | undefined): Promise<unknown> {
  if (file === undefined) return undefined
  try {
    const metadata = await lstat(file)
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0
    ) return undefined
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    if (isMissing(error)) return undefined
    return undefined
  }
}

async function importLegacyNativePreferences(
  state: StoredState,
  file: string | undefined,
): Promise<StoredState> {
  const current = state.modelPreferences === undefined
    ? state.overlays === undefined ? emptyManagementPreferenceData() : parseManagementOverlayData(state.overlays)
    : parseManagementOverlayData(state.modelPreferences)
  let legacy
  try {
    const raw = await readLegacyNativePreferences(file)
    legacy = raw === undefined ? undefined : parseManagementOverlayData(raw)
  } catch {
    return state.modelPreferences === undefined && state.overlays !== undefined
      ? { ...state, modelPreferences: current }
      : state
  }
  if (legacy === undefined && (state.modelPreferences !== undefined || state.overlays === undefined)) return state
  const existing = new Set(current.bindings.map(binding => binding.bindingRef))
  return {
    ...state,
    modelPreferences: {
      schemaVersion: 3,
      revision: Math.max(current.revision, legacy?.revision ?? 0),
      bindings: [
        ...current.bindings,
        ...(legacy?.bindings.filter(binding => !existing.has(binding.bindingRef)) ?? []),
      ],
    },
  }
}
const providerId = (id: string) => `cordisx-${id}`
const scriptStrategy = (view: ManagedProviderView) =>
  view.settings.strategy.kind === 'auto' ? 'auto' : JSON.stringify(view.settings.strategy)
const authority = (view: ManagedProviderView) =>
  createHash('sha256')
    .update(JSON.stringify([view.scopeRevision, view.settings.strategy])).digest('hex')
const binding = (view: ManagedProviderView): CatalogBinding => ({
  bindingRef: view.id,
  scopeRevision: view.scopeRevision,
  authorityRevision: authority(view),
  strategy: view.settings.strategy,
})

/** One profile-owned composition; its owner and all secret/configuration methods remain Node-private. */
export class ManagedCatalogComposition {
  readonly #owner: ManagedProviderOwner
  readonly #service: ModelCatalogService
  readonly #scripts: ScriptSourceRuntime
  readonly preferenceStore: ManagementOverlayStore
  readonly #epoch = randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribes: (() => void)[] = []
  #state: StoredState
  #sequence = 0
  #closed = false
  #closing = false
  #closePromise: Promise<void> | undefined
  #tail: Promise<unknown> = Promise.resolve()
  #stateTail: Promise<unknown> = Promise.resolve()
  #persistTimer: ReturnType<typeof setTimeout> | undefined
  #persistError = false
  #knownIds = new Set<string>()
  readonly #abort = new AbortController()

  private constructor(
    owner: ManagedProviderOwner,
    state: StoredState,
    private readonly options: {
      capture?: (signal: AbortSignal) => Promise<string>
      responsesAvailable: boolean
      environment?: () => Readonly<Record<string, string | undefined>>
      legacyNativePreferenceFile?: string
    },
  ) {
    this.#owner = owner
    this.#state = state
    this.#scripts = new ScriptSourceRuntime(options.environment ? { environment: options.environment } : {})
    this.preferenceStore = new ManagementOverlayStore(async (modelPreferences, expectedRevision, authorized) => {
      await this.updateState(current => {
        const persisted = current.modelPreferences === undefined
          ? current.overlays === undefined
            ? emptyManagementPreferenceData()
            : parseManagementOverlayData(current.overlays)
          : parseManagementOverlayData(current.modelPreferences)
        if (persisted.revision !== expectedRevision) throw new ManagementOverlayError('conflict')
        return { ...current, modelPreferences }
      }, () => !this.#closed && authorized())
    }, state.modelPreferences ?? state.overlays)
    this.#service = new ModelCatalogService({
      registry: builtinDiscoveryRegistry(),
      connection: value => owner.connection(value.bindingRef),
      read: async () => [],
      persistSource: (snapshot, current) =>
        this.serial(async () => {
          if (!current() || this.#closing) throw new CatalogError('cancelled')
          try {
            await this.persist(this.#state, () => current() && !this.#closing, snapshot)
          } catch (error) {
            this.#persistError = true
            throw error
          }
        }),
    })
    this.reconcile()
    this.#unsubscribes.push(
      owner.subscribe(() => {
        this.reconcile()
        this.changed()
      }),
      this.#scripts.subscribe(() => this.changed()),
      this.#service.subscribe(() => {
        this.changed()
        if (!this.#closed && !this.#closing && !this.#persistTimer) {
          this.#persistTimer = setTimeout(() => {
            this.#persistTimer = undefined
            void this.serial(() => this.persist(this.#state)).catch(() => {
              this.#persistError = true
              this.changed()
            })
          }, 100)
          this.#persistTimer.unref?.()
        }
      }),
    )
  }

  static async open(
    options: Parameters<typeof ManagedProviderOwner.open>[0] & {
      capture?: (signal: AbortSignal) => Promise<string>
      responsesAvailable: boolean
      environment?: () => Readonly<Record<string, string | undefined>>
      legacyNativePreferenceFile?: string
    },
  ): Promise<ManagedCatalogComposition> {
    const owner = await ManagedProviderOwner.open(options)
    try {
      const raw = await owner.readCatalogState()
      const data = raw === undefined ? { version: 1, scripts: {}, caches: {} } : object(raw)
      if (!data || data.version !== 1 || !object(data.scripts) || !object(data.caches)) {
        throw new CatalogError('source-invalid')
      }
      const state = data as StoredState
      const imported = await importLegacyNativePreferences(state, options.legacyNativePreferenceFile)
      if (imported !== state) await owner.writeCatalogState(imported, () => true)
      return new ManagedCatalogComposition(owner, imported, options)
    } catch (error) {
      await owner.close()
      throw error
    }
  }

  private reconcile(): void {
    const views = this.#owner.snapshot(), ids = new Set(views.map(view => view.id))
    for (const id of this.#knownIds) {
      if (!ids.has(id)) {
        this.#service.remove(id)
        void this.#scripts.remove(id)
      }
    }
    this.#knownIds = ids
    for (const view of views) {
      const script = this.#state.scripts[view.id]
      const matching = script?.scopeRevision === view.scopeRevision
        && script.strategy === scriptStrategy(view)
      if (matching) {
        this.#scripts.save({ bindingRef: view.id, scopeRevision: view.scopeRevision, mode: script.mode }, script.config)
      } else {
        delete this.#state.scripts[view.id]
        void this.#scripts.remove(view.id)
      }
      const paused = matching && script.mode === 'replace'
        || view.settings.strategy.kind === 'auto' && !view.settings.discoveryEnabled
      const cached = this.#state.caches[view.id]
      this.#service.configure(binding(view), { paused, ...(cached ? { cached } : {}) })
      this.#service.setSupplement(view.id, view.scopeRevision, view.revision, {
        scopeRevision: view.scopeRevision,
        authorityRevision: view.revision,
        models: view.settings.supplement,
      })
    }
  }

  private async persist(
    candidate: StoredState,
    authorized: () => boolean = () => true,
    acquired?: CatalogSnapshot,
  ): Promise<void> {
    await this.updateState(current => {
      const caches: StoredState['caches'] = {}
      const scripts: StoredState['scripts'] = {}
      for (const view of this.#owner.snapshot()) {
        const source = acquired?.bindingRef === view.id ? acquired : this.#service.sourceSnapshot(view.id)
        if (source?.complete) caches[view.id] = source
        const script = candidate.scripts[view.id]
        if (script?.scopeRevision === view.scopeRevision && script.strategy === scriptStrategy(view)) {
          scripts[view.id] = script
        }
      }
      return { ...current, scripts, caches }
    }, authorized)
    this.#persistError = false
  }

  private updateState(update: (current: StoredState) => StoredState, authorized: () => boolean): Promise<void> {
    const job = this.#stateTail.then(async () => {
      const next = update(this.#state)
      await this.#owner.writeCatalogState(next, () => !this.#closed && authorized())
      this.#state = next
    })
    this.#stateTail = job.catch(() => undefined)
    return job
  }

  private members(view: ManagedProviderView) {
    const base = this.#service.snapshot(view.id)?.models ?? []
    const script = this.#scripts.readStatus(view.id)
    const strategy = view.settings.strategy
    return composeScriptMembers({
      bindingRef: view.id,
      scopeRevision: view.scopeRevision,
      authorityRevision: script?.authorityRevision ?? '',
      base,
      ...(script ? { script } : {}),
      strategy: script?.mode === 'replace'
        ? 'script-replace'
        : strategy.kind === 'auto'
        ? strategy.mode === 'augment' ? 'auto-augment' : 'auto-only'
        : 'manual-replace',
    })
  }

  private rows(
    view: ManagedProviderView,
    overlay: ManagementOverlay = this.preferenceStore.read(view.id, view.scopeRevision),
  ) {
    const denied = ['authentication', 'permission', 'account'].includes(this.#service.snapshot(view.id)?.error ?? '')
    const route = this.options.responsesAvailable && !this.#persistError
      && !denied
    const source = this.members(view).map(model => {
      const userDeclared = model.provenance?.includes('manual') === true
        || model.notListed === true && model.provenance?.includes('manual-supplement') === true
        || model.provenance?.includes('script') === true
        || model.provenance?.includes('script-supplement') === true
      const responses = model.protocolCapabilities?.responses
        ?? (userDeclared && view.settings.protocol === 'responses' ? true : undefined)
      const eligibility = resolveNativeModelEligibility({
        wireApi: view.settings.protocol,
        exactConfiguredMembership: userDeclared,
        ...(responses === undefined ? {} : { protocolCapabilities: { responses } }),
        routeAvailable: route,
        userDisabled: false,
      })
      return {
        ...model,
        ...(responses === undefined ? {} : { protocolCapabilities: { responses } }),
        compatibility: eligibility.compatibility,
        selectable: eligibility.selectable,
        exactConfiguredMembership: userDeclared,
      }
    })
    const projected = projectManagementOverlay(source, overlay)
    return [
      ...projected.active.map(row => {
        const eligibility = resolveNativeModelEligibility({
          wireApi: view.settings.protocol,
          ...(row.exactConfiguredMembership === undefined
            ? {}
            : { exactConfiguredMembership: row.exactConfiguredMembership }),
          ...(row.protocolCapabilities === undefined ? {} : { protocolCapabilities: row.protocolCapabilities }),
          routeAvailable: route,
          userDisabled: row.blocked,
        })
        const { exactConfiguredMembership: _exactConfiguredMembership, ...projectedRow } = row
        return {
          ...projectedRow,
          compatibility: eligibility.compatibility,
          selectable: eligibility.selectable,
          provenance: row.provenance ?? [],
          notListed: row.notListed ?? false,
          ...(row.blocked ? { reason: 'blocked' as const } : denied
            ? { reason: 'permission' as const }
            : eligibility.compatibility !== 'supported'
            ? { reason: 'unconfirmed' as const }
            : !eligibility.routeAvailable
            ? { reason: 'pending-apply' as const }
            : {}),
        }
      }),
      ...projected.dormant.map(row => ({
        ...row,
        aliases: [],
        compatibility: 'unknown' as const,
        provenance: [],
        notListed: false,
        reason: 'removed' as const,
      })),
    ]
  }

  snapshot(): CatalogManagementSnapshot {
    if (this.#closed) return { epoch: this.#epoch, sequence: this.#sequence, views: [], canCreateConnection: false }
    const views = this.#owner.snapshot().map((view): CatalogManagementView => {
      const snapshot = this.#service.snapshot(view.id), script = this.#scripts.readStatus(view.id)
      const overlay = this.preferenceStore.read(view.id, view.scopeRevision)
      const rows = this.rows(view, overlay), strategy = view.settings.strategy
      const replacing = script?.mode === 'replace'
      const status = replacing ? script : snapshot
      const supportsResponses = rows.some(row => row.compatibility === 'supported')
      const route = this.options.responsesAvailable && !this.#persistError
        && !['authentication', 'permission', 'account'].includes(snapshot?.error ?? '')
      return {
        bindingRef: view.id,
        providerId: providerId(view.id),
        title: view.settings.title,
        scopeRevision: view.scopeRevision,
        revision: this.revision(view, overlay),
        sourceKind: replacing ? 'script' : strategy.kind === 'auto' ? 'auto' : 'manual',
        mode: replacing
          ? 'replace'
          : strategy.kind === 'auto'
          ? strategy.mode ?? 'only'
          : 'replace',
        freshness: status?.freshness ?? 'unknown',
        activity: status?.loading ? 'loading' : 'idle',
        outcome: status?.error ? 'error' : status?.complete ? this.members(view).length ? 'ok' : 'empty' : 'none',
        autoPaused: !view.settings.discoveryEnabled,
        providerFavorite: overlay.providerFavorite,
        sourceCount: rows.filter(row => row.present && row.compatibility === 'supported').length,
        selectableCount: rows.filter(row => row.selectable).length,
        rows: rows.map(row => ({
          ...row,
          provenance: [...row.provenance].filter(
            (value): value is CatalogManagementView['rows'][number]['provenance'][number] =>
              ['native', 'auto', 'manual', 'manual-supplement', 'script', 'script-supplement'].includes(value),
          ),
        })),
        protocolCapabilities: { responses: route && supportsResponses },
        supplement: view.settings.supplement,
        preferenceCapabilities: ['setProviderFavorite', 'setOverlay', 'resetOrder', 'restoreBlocked'],
        capabilities: [
          'setProviderFavorite',
          'setOverlay',
          'resetOrder',
          'restoreBlocked',
          'editSupplement',
          'editManual',
          'convertToManual',
          'updateConnection',
          'requestCredentialReplacement',
          'configureScript',
          ...(strategy.kind === 'auto'
            ? [
              'setAutoPaused' as const,
              'setMode' as const,
              ...(!view.settings.discoveryEnabled || replacing ? [] : ['refresh' as const]),
            ]
            : []),
          ...(script ? [script.loading ? 'cancelScript' as const : 'runScript' as const] : []),
        ],
        diagnostics: {
          scopeConfirmed: true,
          targetState: route && supportsResponses ? 'applied' : 'unavailable',
          ...(this.#persistError ? { code: 'persist-failed' as const } : status?.error
            ? { code: status.error === 'ambiguous' ? 'unsupported' as const : status.error }
            : {}),
          ...(status?.lastSuccessAt === undefined ? {} : { lastSuccessAt: status.lastSuccessAt }),
        },
        connection: {
          title: view.settings.title,
          endpoint: view.settings.endpoint,
          protocol: view.settings.protocol,
          discoveryEnabled: view.settings.discoveryEnabled,
          strategy: strategy.kind === 'auto'
            ? { ...strategy, mode: strategy.mode ?? 'only' }
            : { kind: 'manual', ids: strategy.kind === 'manual' && 'ids' in strategy ? strategy.ids : [] },
        },
        ...(script
          ? {
            scriptState: {
              authorityRevision: script.authorityRevision,
              runGeneration: script.runGeneration,
              persistence: script.persistence,
              evidence: script.evidence,
            },
          }
          : {}),
      }
    })
    return Object.freeze({ epoch: this.#epoch, sequence: this.#sequence, views, canCreateConnection: true })
  }

  private revision(
    view: ManagedProviderView,
    overlay: ManagementOverlay = this.preferenceStore.read(view.id, view.scopeRevision),
  ): string {
    return [
      this.sourceRevision(view),
      overlay.revision,
    ].join(':')
  }

  private sourceRevision(view: ManagedProviderView): string {
    return createHash('sha256').update(JSON.stringify([
      view.revision,
      view.scopeRevision,
      this.members(view),
    ])).digest('hex')
  }

  private currentSourceRevision(bindingRef: string): string | undefined {
    const view = this.#owner.snapshot().find(candidate => candidate.id === bindingRef)
    return view === undefined ? undefined : this.sourceRevision(view)
  }

  catalog(): readonly NativeModelProviderCatalogEntry[] {
    return this.#owner.snapshot().map(view => ({
      providerId: providerId(view.id),
      pluginId: 'cordisx-host',
      title: view.settings.title,
      models: this.rows(view).filter(row => row.selectable)
        .map(row => ({
          id: row.id,
          label: row.label,
          aliases: row.aliases,
          notListed: row.notListed,
          provenance: row.provenance as NonNullable<NativeModelProviderCatalogEntry['models'][number]['provenance']>,
        })),
    }))
  }

  /** Host-private desired definitions for explicit profile synchronization. */
  providerSyncConnections(connectionIds: ReadonlySet<string>): readonly ProviderSyncConnectionDefinition[] {
    return Object.freeze(
      this.#owner.snapshot().flatMap(view => {
        const connectionId = `cx-connection-${view.id}`
        if (!connectionIds.has(connectionId)) return []
        const members = this.members(view)
        const source = this.#service.snapshot(view.id)
        return [Object.freeze({
          connectionId,
          revision: this.revision(view),
          title: view.settings.title,
          endpoint: view.settings.endpoint,
          protocol: view.settings.protocol,
          credential: Object.freeze({
            secretRef: connectionId,
            revision: view.credentialRevision,
          }),
          models: Object.freeze({
            ids: Object.freeze(members.map(model => model.id)),
            completeness: source?.complete === true
              ? 'complete' as const
              : members.length > 0
              ? 'partial' as const
              : 'unknown' as const,
          }),
          enabled: true,
        })]
      }),
    )
  }

  owns(id: string): boolean {
    return id.startsWith('cordisx-') && this.#owner.snapshot().some(view => providerId(view.id) === id)
  }
  admits(id: string, model: string): boolean {
    return !this.#closed && !this.#closing
      && this.catalog().some(view => view.providerId === id && view.models.some(row => row.id === model))
  }
  async validateSelection(id: string, model: string): Promise<boolean> {
    await this.#owner.validateCurrent()
    return this.admits(id, model)
  }
  nativeConnection(id: string) {
    if (!this.owns(id) || !this.options.responsesAvailable) throw new CatalogError('unsupported')
    return this.#owner.nativeConnection(
      id.slice('cordisx-'.length),
      () =>
        !this.#closing && !this.#closed
        && (this.catalog().find(view => view.providerId === id)?.models.length ?? 0) > 0,
    )
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  private changed(): void {
    this.#sequence++
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const job = this.#tail.then(action)
    this.#tail = job.catch(() => undefined)
    return job
  }

  private capture(signal: AbortSignal): Promise<string> {
    const combined = AbortSignal.any([signal, this.#abort.signal])
    return withAbort((this.options.capture ?? captureManagedProviderCredential)(combined), combined)
  }

  command(
    command: CatalogManagementCommand,
    authorized: () => boolean,
  ): Promise<CatalogManagementResult> {
    command = structuredClone(command)
    const admitted = () => !this.#closing && !this.#closed && authorized()
    return this.serial(async () => {
      let expectedSourceRevision: string | undefined
      let sourceBindingRef: string | undefined
      try {
        if (this.#closed || this.#closing || !authorized()) return { status: 'rejected', code: 'permission' }
        const input = object(command)
        if (!input) throw new CatalogError('source-invalid')
        if (command.operation === 'createConnection') {
          if (Object.keys(command).some(key => !['operation', 'settings'].includes(key))) {
            throw new CatalogError('source-invalid')
          }
          await this.#owner.save(
            { settings: { ...command.settings, supplement: [] } },
            signal => this.capture(signal),
            admitted,
          )
        } else {
          const extra: Record<string, readonly string[]> = {
            setProviderFavorite: ['favorite'],
            setOverlay: ['modelId', 'blocked', 'pinned'],
            setAutoPaused: ['paused'],
            editManual: ['models'],
            editSupplement: ['models'],
            setSource: ['source'],
            setMode: ['mode'],
            updateConnection: ['settings'],
            configureScript: ['config', 'mode'],
            refresh: [],
            resetOrder: [],
            restoreBlocked: [],
            convertToManual: [],
            requestCredentialReplacement: [],
            runScript: [],
            cancelScript: [],
          }
          const keys = extra[command.operation]
          if (
            !keys
            || Object.keys(command).some(key =>
              !['operation', 'bindingRef', 'scopeRevision', 'expectedRevision', ...keys].includes(key)
            )
          ) {
            throw new CatalogError('source-invalid')
          }
          if (command.operation === 'setAutoPaused' && typeof command.paused !== 'boolean') {
            throw new CatalogError('source-invalid')
          }
          if (command.operation === 'setProviderFavorite' && typeof command.favorite !== 'boolean') {
            throw new CatalogError('source-invalid')
          }
          const view = this.#owner.snapshot().find(view => view.id === command.bindingRef)
          if (!view || view.scopeRevision !== command.scopeRevision) {
            return { status: 'conflict', code: 'scope-changed' }
          }
          if (this.revision(view) !== command.expectedRevision) return { status: 'conflict', code: 'conflict' }
          sourceBindingRef = view.id
          expectedSourceRevision = this.sourceRevision(view)
          const sourceAdmitted = () => admitted() && this.currentSourceRevision(view.id) === expectedSourceRevision
          if (
            view.settings.supplement.length && (command.operation === 'requestCredentialReplacement'
              || command.operation === 'updateConnection'
                && (command.settings.endpoint !== view.settings.endpoint
                  || command.settings.protocol !== view.settings.protocol))
          ) return { status: 'conflict', code: 'scope-changed' }
          await this.apply(view, command, sourceAdmitted)
        }
        this.changed()
        return { status: 'applied', snapshot: this.snapshot() }
      } catch (error) {
        if (!authorized()) return { status: 'rejected', code: 'permission' }
        if (
          expectedSourceRevision !== undefined
          && sourceBindingRef !== undefined
          && this.currentSourceRevision(sourceBindingRef) !== expectedSourceRevision
        ) {
          return { status: 'conflict', code: 'conflict' }
        }
        const code = error instanceof CatalogError
          ? error.code === 'ambiguous' ? 'unsupported' : error.code
          : error instanceof ScriptSourceError || error instanceof ManagementOverlayError
          ? error.code
          : 'persist-failed'
        return { status: 'rejected', code }
      }
    })
  }

  private async apply(
    view: ManagedProviderView,
    command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>,
    authorized: () => boolean,
  ): Promise<void> {
    const operation = command.operation
    if (
      operation === 'setProviderFavorite' || operation === 'setOverlay' || operation === 'resetOrder'
      || operation === 'restoreBlocked'
    ) {
      const scope = {
        bindingRef: view.id,
        scopeRevision: view.scopeRevision,
        expectedRevision: this.preferenceStore.read(view.id, view.scopeRevision).revision,
      }
      const mutation = command.operation === 'setProviderFavorite'
        ? { ...scope, operation: 'setProviderFavorite' as const, favorite: command.favorite }
        : command.operation === 'setOverlay'
        ? { ...command, ...scope }
        : { ...scope, operation: operation as 'resetOrder' | 'restoreBlocked' }
      await this.preferenceStore.mutate(mutation, this.members(view).map(model => model.id), authorized)
      return
    }
    if (operation === 'refresh') {
      void this.#service.refresh(view.id)
      return
    }
    if (operation === 'runScript' || operation === 'cancelScript') {
      const script = this.#scripts.readStatus(view.id)
      if (!script) throw new CatalogError('unsupported')
      const intent = { bindingRef: view.id, scopeRevision: view.scopeRevision, expectedRevision: script.revision }
      if (operation === 'runScript') {
        if (this.#scripts.run(intent).status === 'busy') throw new CatalogError('temporary')
      } else await this.#scripts.cancel(intent)
      return
    }
    if (operation === 'configureScript') {
      if (!['replace', 'supplement'].includes(command.mode)) throw new CatalogError('source-invalid')
      const config = parseScriptSourceConfig(command.config)
      await this.persist({
        ...this.#state,
        scripts: {
          ...this.#state.scripts,
          [view.id]: {
            scopeRevision: view.scopeRevision,
            strategy: scriptStrategy(view),
            mode: command.mode,
            config,
          },
        },
      }, authorized)
      this.reconcile()
      return
    }
    let settings = view.settings
    if (operation === 'updateConnection') {
      settings = managedProviderSettings({ ...command.settings, supplement: settings.supplement })
    } else if (operation === 'setAutoPaused') settings = { ...settings, discoveryEnabled: !command.paused }
    else if (operation === 'editSupplement') {
      settings = managedProviderSettings({ ...settings, supplement: command.models })
    } else if (operation === 'editManual' || operation === 'convertToManual') {
      settings = {
        ...settings,
        strategy: {
          kind: 'manual',
          ids: operation === 'editManual'
            ? command.models.map(model => model.id)
            : this.members(view).map(model => model.id),
        },
      }
    } else if (operation === 'setMode' && settings.strategy.kind === 'auto') {
      settings = { ...settings, strategy: { ...settings.strategy, mode: command.mode } }
    } else if (operation !== 'requestCredentialReplacement') throw new CatalogError('unsupported')
    if (
      (operation === 'editManual' || operation === 'convertToManual')
      && JSON.stringify(settings) === JSON.stringify(view.settings)
    ) {
      const scripts = { ...this.#state.scripts }
      delete scripts[view.id]
      await this.persist({ ...this.#state, scripts }, authorized)
      this.reconcile()
      return
    }
    await this.#owner.save(
      { id: view.id, expectedRevision: view.revision, settings },
      operation === 'requestCredentialReplacement' ? signal => this.capture(signal) : undefined,
      authorized,
    )
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closing = true
      this.#abort.abort()
      clearTimeout(this.#persistTimer)
      for (const unsubscribe of this.#unsubscribes) unsubscribe()
      this.#listeners.clear()
      for (const view of this.#owner.snapshot()) this.#service.setPaused(view.id, true)
      await this.#scripts.dispose()
      await this.#tail
      try {
        await this.persist(this.#state)
      } finally {
        this.#closed = true
        this.#service.dispose()
        await this.#owner.close()
      }
    })()
    return this.#closePromise
  }
}
