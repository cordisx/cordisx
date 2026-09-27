import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CatalogManagementCommand,
  CatalogManagementResult,
  CatalogManagementSnapshot,
  CatalogManagementView,
} from '../../model-catalog-management.js'
import { favoriteCatalogManagementViews } from '../../model-catalog-management.js'
import {
  ManagementOverlayError,
  ManagementOverlayStore,
  projectManagementOverlay,
} from '../../model-catalog/management-overlay.js'
import type { CodexConfigModelProviderProjection } from '../codex-config-model-providers.js'
import type { NativeModelProviderCatalogEntry } from '../native-model-provider-catalog.js'
import { resolveNativeModelEligibility } from '../../renderer/native-provider-submission-policy.js'
import type { CatalogSnapshot } from './contracts.js'
import { type PortableConnection, portableConnection, PortableTransferError } from './portable-transfer-codec.js'
import { decodePortableBundle, encodePortableBundle, type PortableBundle } from './portable-transfer-codec.js'
import type {
  CatalogEnvironmentReadResult,
  CatalogEnvironmentSaveResult,
  CatalogTransferEnvironmentVariable,
  CatalogTransferExportPreparationResult,
  CatalogTransferExportRequest,
  CatalogTransferExportResult,
  CatalogTransferImportPreparationResult,
  CatalogTransferImportRequest,
  CatalogTransferImportResult,
} from '../../model-catalog-transfer.js'
import { boundedString, CatalogError, object } from './contracts.js'

type CatalogManagementAuthority = {
  snapshot(): CatalogManagementSnapshot
  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult>
  subscribe(listener: () => void): () => void
  portableSelection?(ref: string, modelIds: readonly string[]): PortableConnection
  portableEnvironment?(ref: string): {
    readonly name?: string
    readonly value?: string
    readonly description?: string
    readonly placeholder: boolean
  } | undefined
  environmentEntries?(): readonly CatalogTransferEnvironmentVariable[]
  saveEnvironment?(entries: readonly CatalogTransferEnvironmentVariable[], authorized: () => boolean): Promise<void>
  preparePortableImport?(bundle: PortableBundle): readonly {
    readonly sourceName: string
    readonly name: string
    readonly value: string
    readonly enabled: boolean
    readonly description?: string
  }[]
  importPortable?(
    bundle: PortableBundle,
    variables: CatalogTransferImportRequest['variables'],
    authorized: () => boolean,
  ): Promise<{
    readonly imported: number
    readonly skipped: number
    readonly bindingRefs: readonly string[]
  }>
}

function transferSelections(value: unknown): CatalogTransferExportRequest['selections'] {
  const request = object(value)
  if (
    !request || Object.keys(request).some(key => !['selections', 'variables', 'includeValues'].includes(key))
    || !Array.isArray(request.selections) || request.selections.length === 0
    || request.selections.length > 24
  ) throw new PortableTransferError('invalid')
  let count = 0
  const refs = new Set<string>()
  return request.selections.map(value => {
    const item = object(value)
    if (
      !item || Object.keys(item).some(key => !['bindingRef', 'modelIds'].includes(key))
      || !boundedString(item.bindingRef, 512) || refs.has(item.bindingRef)
      || !Array.isArray(item.modelIds) || item.modelIds.length === 0
      || item.modelIds.some(id => !boundedString(id, 512))
      || new Set(item.modelIds).size !== item.modelIds.length
    ) throw new PortableTransferError('invalid')
    count += item.modelIds.length
    if (count > 512) throw new PortableTransferError('too-large')
    refs.add(item.bindingRef)
    return { bindingRef: item.bindingRef, modelIds: item.modelIds as string[] }
  })
}

function exportVariables(value: CatalogTransferExportRequest, required: ReadonlySet<string>) {
  const variables = value.variables ?? []
  if (
    !Array.isArray(variables) || variables.length !== required.size
    || typeof value.includeValues !== 'boolean'
  ) throw new PortableTransferError('invalid')
  const sourceNames = new Set<string>()
  const names = new Set<string>()
  const parsed = variables.map(variable => {
    if (
      !variable || typeof variable !== 'object'
      || !boundedString(variable.sourceName, 128) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable.sourceName)
      || !boundedString(variable.name, 128) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable.name)
      || sourceNames.has(variable.sourceName) || names.has(variable.name) || !required.has(variable.sourceName)
      || variable.value !== undefined
        && (typeof variable.value !== 'string' || variable.value.length > 16_384 || variable.value.includes('\0'))
      || variable.description !== undefined
        && (!boundedString(variable.description, 512) || variable.description.includes('\0'))
    ) throw new PortableTransferError('invalid')
    const generator = variable.generator
    if (
      generator !== undefined
      && (generator.kind !== 'shell' || typeof generator.script !== 'string'
        || generator.script.length > 16_384 || generator.script.includes('\0'))
    ) throw new PortableTransferError('invalid')
    sourceNames.add(variable.sourceName)
    names.add(variable.name)
    return variable
  })
  if ([...required].some(name => !sourceNames.has(name))) throw new PortableTransferError('invalid')
  return parsed
}

type PortableEnvironment = NonNullable<ReturnType<NonNullable<CatalogManagementAuthority['portableEnvironment']>>>

function transferEnvironment(
  selections: CatalogTransferExportRequest['selections'],
  native: CatalogManagementAuthority,
  managed?: CatalogManagementAuthority,
): ReadonlyMap<string, PortableEnvironment & { readonly sourceName: string }> {
  const dependencies = new Map<string, PortableEnvironment & { readonly sourceName: string }>()
  const named = new Map<string, string>()
  const sources = selections.map(selection => {
    const owner = selection.bindingRef.startsWith('codex-config:') ? native : managed
    return { selection, source: owner?.portableEnvironment?.(selection.bindingRef) }
  })
  const used = new Set(sources.flatMap(({ source }) => source?.name === undefined ? [] : [source.name]))
  let placeholder = 0
  for (const { selection, source } of sources) {
    if (!source) continue
    let sourceName = source.name === undefined ? undefined : named.get(source.name)
    if (sourceName === undefined) {
      if (source.name !== undefined) sourceName = source.name
      else {
        do {
          sourceName = `CORDISX_MODEL_SERVICE_KEY${placeholder === 0 ? '' : `_${placeholder}`}`
          placeholder++
        } while (used.has(sourceName))
      }
      if (source.name !== undefined) named.set(source.name, sourceName)
      used.add(sourceName)
    }
    dependencies.set(selection.bindingRef, { ...source, sourceName })
  }
  return dependencies
}

interface NativeCatalogDiscovery {
  has(providerId: string): boolean
  snapshot(providerId: string): CatalogSnapshot | undefined
  refresh(providerId: string): Promise<void>
  subscribe(listener: () => void): () => void
}

const bindingRef = (providerId: string) => `codex-config:${providerId}`
const preferenceScopeRevision = (providerId: string) =>
  createHash('sha256').update(JSON.stringify(['codex-config-v1', providerId])).digest('hex')
const safeRevision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const discoveryCode = (value: NonNullable<CatalogSnapshot['error']>) =>
  value === 'ambiguous' ? 'unsupported' as const : value

async function readOverlayState(file: string): Promise<unknown> {
  try {
    const metadata = await lstat(file)
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0
    ) throw new Error('source-invalid')
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function writeOverlayState(file: string, value: unknown, authorized: () => boolean): Promise<void> {
  if (!authorized()) throw new Error('permission')
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) {
    throw new Error('persist-failed')
  }
  await chmod(directory, 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    if (!authorized()) throw new Error('permission')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

const diagnosticCode = (
  projection: CodexConfigModelProviderProjection,
  providerId: string,
): 'unavailable' | undefined =>
  projection.sourceAvailable === false
    || projection.diagnostics.some(item => item.providerId === providerId && item.code === 'catalog-unavailable')
    ? 'unavailable'
    : undefined

/** Profile-local preferences over native Codex configuration; never rewrites the native files. */
export class NativeCatalogManagement implements CatalogManagementAuthority {
  readonly #epoch = randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #overlay: ManagementOverlayStore
  readonly #lastGood = new Map<string, NativeModelProviderCatalogEntry>()
  #projection: CodexConfigModelProviderProjection
  #sequence = 0
  #closed = false
  #persistError = false
  #tail: Promise<unknown> = Promise.resolve()
  #unsubscribeSource: (() => void) | undefined

  /** Host-private shared preference store for other catalog authorities in this composition. */
  get preferenceStore(): ManagementOverlayStore {
    return this.#overlay
  }

  private constructor(
    projection: CodexConfigModelProviderProjection,
    initialOverlay: unknown,
    private readonly options: {
      load(): Promise<CodexConfigModelProviderProjection>
      stateFile?: string
      overlayStore?: ManagementOverlayStore
      refreshBeforeRead?: boolean
      shadowed?(providerId: string): boolean
      discovery?: NativeCatalogDiscovery
    },
  ) {
    this.#projection = projection
    this.recordGood(projection)
    if (options.overlayStore) {
      this.#overlay = options.overlayStore
    } else {
      try {
        this.#overlay = new ManagementOverlayStore(
          (data, _expectedRevision, authorized) => this.persist(data, authorized),
          initialOverlay,
        )
      } catch {
        this.#persistError = true
        this.#overlay = new ManagementOverlayStore(
          (data, _expectedRevision, authorized) => this.persist(data, authorized),
        )
      }
    }
  }

  static async open(options: {
    load(): Promise<CodexConfigModelProviderProjection>
    stateFile?: string
    overlayStore?: ManagementOverlayStore
    refreshBeforeRead?: boolean
    shadowed?(providerId: string): boolean
    discovery?: NativeCatalogDiscovery
    subscribeSource?(listener: (projection: CodexConfigModelProviderProjection) => void): () => void
  }): Promise<NativeCatalogManagement> {
    const [projection, initialOverlay] = await Promise.all([
      options.load(),
      options.overlayStore !== undefined || options.stateFile === undefined
        ? undefined
        : readOverlayState(options.stateFile).catch(() => undefined),
    ])
    const authority = new NativeCatalogManagement(projection, initialOverlay, options)
    const unsubscribes = [
      options.subscribeSource?.(projection => authority.replace(projection)),
      options.discovery?.subscribe(() => authority.changed()),
    ].filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined)
    authority.#unsubscribeSource = () => unsubscribes.forEach(unsubscribe => unsubscribe())
    return authority
  }

  private async persist(
    data: ReturnType<ManagementOverlayStore['snapshot']>,
    authorized: () => boolean,
  ): Promise<void> {
    if (this.options.stateFile === undefined) return
    try {
      await writeOverlayState(this.options.stateFile, data, () => !this.#closed && authorized())
      this.#persistError = false
    } catch (error) {
      this.#persistError = true
      throw error
    }
  }

  private recordGood(projection: CodexConfigModelProviderProjection): void {
    if (projection.sourceAvailable === false) return
    const unavailable = new Set(
      projection.diagnostics.filter(item => item.code === 'catalog-unavailable').map(item => item.providerId),
    )
    for (const provider of projection.providers) {
      if (!unavailable.has(provider.providerId)) this.#lastGood.set(provider.providerId, provider)
    }
  }

  private replace(projection: CodexConfigModelProviderProjection, force = false): void {
    const comparable = (value: CodexConfigModelProviderProjection) => ({
      ...value,
      providerWireApis: [...value.providerWireApis],
      portableConnections: [...value.portableConnections ?? []],
    })
    const changed = safeRevision(comparable(this.#projection)) !== safeRevision(comparable(projection))
    this.#projection = projection
    this.recordGood(projection)
    if (changed || force) this.changed()
  }

  private async refresh(force = false): Promise<void> {
    this.replace(await this.options.load(), force)
  }

  private scope(providerId: string): string {
    return preferenceScopeRevision(providerId)
  }

  private sourceModels(provider: NativeModelProviderCatalogEntry) {
    const automatic = this.options.discovery?.snapshot(provider.providerId)?.models ?? []
    const models = new Map(automatic.map(model => [model.id, model]))
    for (const model of provider.models) {
      const discovered = models.get(model.id)
      models.set(
        model.id,
        Object.freeze({
          ...discovered,
          ...model,
          provenance: Object.freeze([
            ...(discovered === undefined ? [] : ['auto' as const]),
            'native' as const,
          ]),
          ...(discovered?.protocolCapabilities === undefined
            ? {}
            : { protocolCapabilities: discovered.protocolCapabilities }),
          ...(discovered?.reasoningCapabilities === undefined
            ? {}
            : { reasoningCapabilities: discovered.reasoningCapabilities }),
        }),
      )
    }
    return Object.freeze([...models.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

  private providersForManagement(): readonly NativeModelProviderCatalogEntry[] {
    const providers = this.#projection.sourceAvailable === false
      ? [...this.#lastGood.values()]
      : this.#projection.providers.map(provider =>
        diagnosticCode(this.#projection, provider.providerId) === 'unavailable'
          ? this.#lastGood.get(provider.providerId) ?? provider
          : provider
      )
    return providers.filter(provider => !this.options.shadowed?.(provider.providerId))
  }

  private rows(provider: NativeModelProviderCatalogEntry) {
    const discovery = this.options.discovery?.snapshot(provider.providerId)
    const denied = ['authentication', 'permission', 'account'].includes(discovery?.error ?? '')
    const available = diagnosticCode(this.#projection, provider.providerId) === undefined && !this.#persistError
      && !denied
    const confirmed = new Set(provider.models.map(model => model.id))
    const projected = projectManagementOverlay(
      this.sourceModels(provider).map(model => {
        const wireApi = this.#projection.providerWireApis.get(provider.providerId)
        const eligibility = resolveNativeModelEligibility({
          ...(wireApi === undefined ? {} : { wireApi }),
          exactConfiguredMembership: confirmed.has(model.id),
          ...(model.protocolCapabilities === undefined ? {} : { protocolCapabilities: model.protocolCapabilities }),
          routeAvailable: available,
          userDisabled: false,
        })
        return {
          ...model,
          compatibility: eligibility.compatibility,
          selectable: eligibility.selectable,
        }
      }),
      this.#overlay.read(bindingRef(provider.providerId), this.scope(provider.providerId)),
    )
    return [
      ...projected.active.map(row => ({
        ...row,
        provenance: row.provenance ?? ['native' as const],
        notListed: row.notListed ?? false,
        ...(!row.selectable && !row.blocked
          ? { reason: denied ? 'permission' as const : 'unconfirmed' as const }
          : {}),
        ...(row.blocked ? { reason: 'blocked' as const } : {}),
      })),
      ...projected.dormant.map(row => ({
        ...row,
        provenance: [] as const,
        notListed: false,
        reason: row.blocked ? 'blocked' as const : 'removed' as const,
      })),
    ]
  }

  private revision(provider: NativeModelProviderCatalogEntry): string {
    const scope = this.scope(provider.providerId)
    const overlay = this.#overlay.read(bindingRef(provider.providerId), scope)
    return safeRevision({
      provider,
      discovery: this.options.discovery?.snapshot(provider.providerId),
      overlay: overlay.revision,
      wireApi: this.#projection.providerWireApis.get(provider.providerId),
      sourceAvailable: this.#projection.sourceAvailable,
      diagnostics: this.#projection.diagnostics.filter(item => item.providerId === provider.providerId),
      persistError: this.#persistError,
    })
  }

  /** Uses the current Host-private Codex config projection, never renderer-supplied connection facts. */
  portableSelection(ref: string, modelIds: readonly string[]): PortableConnection {
    const provider = this.#projection.providers.find(item => bindingRef(item.providerId) === ref)
    if (
      this.#closed || this.#projection.sourceAvailable === false || !provider
      || this.options.shadowed?.(provider.providerId)
      || diagnosticCode(this.#projection, provider.providerId) !== undefined
    ) throw new PortableTransferError('invalid')
    const connection = this.#projection.portableConnections?.get(provider.providerId)
    if (!connection) throw new PortableTransferError('invalid')
    const members = new Map(this.sourceModels(provider).map(model => [model.id, model]))
    const models = modelIds.map(id => {
      const source = members.get(id)
      if (!source) throw new PortableTransferError('invalid')
      return {
        id: source.id,
        label: source.label,
        ...(source.protocolCapabilities ? { protocolCapabilities: source.protocolCapabilities } : {}),
        ...(source.reasoningCapabilities ? { reasoningCapabilities: source.reasoningCapabilities } : {}),
      }
    })
    return portableConnection({ title: provider.title ?? provider.providerId, ...connection, models })
  }

  portableEnvironment(ref: string) {
    const provider = this.#projection.providers.find(item => bindingRef(item.providerId) === ref)
    if (!provider) return undefined
    return this.#projection.portableEnvironment?.get(provider.providerId)
  }

  snapshot(): CatalogManagementSnapshot {
    if (this.#closed) return { epoch: this.#epoch, sequence: this.#sequence, views: [], canCreateConnection: false }
    const views = this.providersForManagement().map((provider): CatalogManagementView => {
      const overlay = this.#overlay.read(bindingRef(provider.providerId), this.scope(provider.providerId))
      const rows = this.rows(provider)
      const favoriteWritable = this.hasProvider(provider.providerId)
        && diagnosticCode(this.#projection, provider.providerId) === undefined
        && !this.#persistError
      const preferences = [
        ...(favoriteWritable ? ['setProviderFavorite' as const] : []),
        'setOverlay' as const,
        'resetOrder' as const,
        'restoreBlocked' as const,
      ]
      const unavailable = diagnosticCode(this.#projection, provider.providerId) !== undefined || this.#persistError
      const discovery = this.options.discovery?.snapshot(provider.providerId)
      const sourceCount = this.sourceModels(provider).length
      const errorCode = unavailable
        ? this.#persistError ? 'persist-failed' as const : 'unavailable' as const
        : discovery?.error === undefined
        ? undefined
        : discoveryCode(discovery.error)
      return {
        bindingRef: bindingRef(provider.providerId),
        providerId: provider.providerId,
        title: provider.title ?? provider.providerId,
        scopeRevision: this.scope(provider.providerId),
        revision: this.revision(provider),
        sourceKind: 'native',
        transferAvailable: this.#projection.sourceAvailable !== false
          && this.#projection.portableConnections?.has(provider.providerId) === true
          && diagnosticCode(this.#projection, provider.providerId) === undefined,
        mode: discovery === undefined ? 'only' : 'augment',
        freshness: unavailable ? 'stale' : discovery?.freshness ?? 'fresh',
        activity: discovery?.loading ? 'loading' : 'idle',
        outcome: unavailable
          ? 'error'
          : discovery?.error !== undefined
          ? discovery.error === 'unsupported' ? 'unsupported' : discovery.error === 'cancelled' ? 'cancelled' : 'error'
          : sourceCount === 0
          ? 'empty'
          : 'ok',
        autoPaused: false,
        providerFavorite: overlay.providerFavorite,
        sourceCount,
        selectableCount: rows.filter(row => row.selectable).length,
        rows,
        supplement: [],
        preferenceCapabilities: preferences,
        capabilities: ['refresh', ...preferences],
        diagnostics: {
          scopeConfirmed: true,
          targetState: unavailable ? 'unavailable' : 'applied',
          ...(errorCode === undefined ? {} : { code: errorCode }),
          ...(discovery?.lastSuccessAt === undefined ? {} : { lastSuccessAt: discovery.lastSuccessAt }),
        },
      }
    })
    return Object.freeze({
      epoch: this.#epoch,
      sequence: this.#sequence,
      views: favoriteCatalogManagementViews(views),
      canCreateConnection: false,
    })
  }

  async catalog(): Promise<readonly NativeModelProviderCatalogEntry[]> {
    if (this.options.refreshBeforeRead) await this.refresh()
    if (this.#closed || this.#projection.sourceAvailable === false) return []
    return Object.freeze(this.#projection.providers.flatMap(provider => {
      if (this.options.shadowed?.(provider.providerId)) return []
      const rows = this.rows(provider).filter(row => row.present && row.selectable)
      const { defaultModelId: sourceDefaultModelId, ...base } = provider
      const defaultModelId = rows.some(row => row.id === sourceDefaultModelId) ? sourceDefaultModelId : undefined
      return [Object.freeze({
        ...base,
        models: Object.freeze(rows.map(row => {
          const source = provider.models.find(model => model.id === row.id)
          return Object.freeze({
            id: row.id,
            label: row.label,
            aliases: Object.freeze([...(source?.aliases ?? [])]),
            ...(source?.selectorBrand === undefined ? {} : { selectorBrand: source.selectorBrand }),
            provenance: row.provenance,
            notListed: row.notListed,
            ...('reasoningCapabilities' in row && row.reasoningCapabilities !== undefined
              ? { reasoningCapabilities: row.reasoningCapabilities }
              : {}),
          })
        })),
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
      })]
    }))
  }

  hasProvider(providerId: string): boolean {
    return this.#projection.sourceAvailable !== false
      && !this.options.shadowed?.(providerId)
      && this.#projection.providers.some(provider => provider.providerId === providerId)
  }

  async validateSelection(providerId: string, model: string): Promise<boolean> {
    return (await this.catalog()).some(provider =>
      provider.providerId === providerId && provider.models.some(candidate => candidate.id === model)
    )
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  private changed(): void {
    this.#sequence++
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }

  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult> {
    const admitted = () => !this.#closed && authorized()
    const execute = async (): Promise<CatalogManagementResult> => {
      if (!admitted()) return { status: 'rejected', code: 'permission' }
      if (command.operation === 'createConnection') return { status: 'rejected', code: 'unsupported' }
      if (
        !['refresh', 'setProviderFavorite', 'setOverlay', 'resetOrder', 'restoreBlocked'].includes(command.operation)
      ) {
        return { status: 'rejected', code: 'unsupported' }
      }
      const provider = this.providersForManagement().find(candidate =>
        bindingRef(candidate.providerId) === command.bindingRef
      )
      if (!provider || command.scopeRevision !== this.scope(provider.providerId)) {
        return { status: 'conflict', code: 'scope-changed' }
      }
      if (command.expectedRevision !== this.revision(provider)) return { status: 'conflict', code: 'conflict' }
      if (
        command.operation === 'setProviderFavorite'
        && (
          !this.hasProvider(provider.providerId)
          || diagnosticCode(this.#projection, provider.providerId) !== undefined
          || this.#persistError
        )
      ) {
        return { status: 'rejected', code: 'unavailable' }
      }
      try {
        if (command.operation === 'refresh') {
          await this.refresh(true)
          if (this.options.discovery?.has(provider.providerId)) {
            await this.options.discovery.refresh(provider.providerId)
          }
        } else {
          const scope = {
            bindingRef: command.bindingRef,
            scopeRevision: command.scopeRevision,
            expectedRevision: this.#overlay.read(command.bindingRef, command.scopeRevision).revision,
          }
          if (command.operation === 'setProviderFavorite') {
            await this.#overlay.mutate(
              { ...scope, operation: 'setProviderFavorite', favorite: command.favorite },
              this.sourceModels(provider).map(model => model.id),
              admitted,
            )
          } else if (command.operation === 'setOverlay') {
            await this.#overlay.mutate(
              { ...command, ...scope },
              this.sourceModels(provider).map(model => model.id),
              admitted,
            )
          } else if (command.operation === 'resetOrder' || command.operation === 'restoreBlocked') {
            await this.#overlay.mutate(
              { ...scope, operation: command.operation },
              this.sourceModels(provider).map(model => model.id),
              admitted,
            )
          } else {
            return { status: 'rejected', code: 'unsupported' }
          }
          this.changed()
        }
        if (!admitted()) return { status: 'rejected', code: 'permission' }
        return { status: 'applied', snapshot: this.snapshot() }
      } catch (error) {
        if (!admitted()) return { status: 'rejected', code: 'permission' }
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

  close(): void {
    this.#closed = true
    this.#unsubscribeSource?.()
    this.#listeners.clear()
  }
}

/** One renderer-facing authority even when the managed connection owner is unavailable. */
export class CompositeCatalogManagement implements CatalogManagementAuthority {
  readonly #epoch = randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribes: (() => void)[]
  #sequence = 0

  constructor(
    private readonly native: NativeCatalogManagement,
    private readonly managed?: CatalogManagementAuthority,
  ) {
    this.#unsubscribes = [native.subscribe(() => this.changed()), managed?.subscribe(() => this.changed())]
      .filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined)
  }

  snapshot(): CatalogManagementSnapshot {
    const managed = this.managed?.snapshot()
    return Object.freeze({
      epoch: this.#epoch,
      sequence: this.#sequence,
      views: favoriteCatalogManagementViews([...(managed?.views ?? []), ...this.native.snapshot().views]),
      canCreateConnection: managed?.canCreateConnection ?? false,
    })
  }

  async command(
    command: CatalogManagementCommand,
    authorized: () => boolean,
  ): Promise<CatalogManagementResult> {
    const owner = command.operation !== 'createConnection'
        && command.bindingRef.startsWith('codex-config:')
      ? this.native
      : this.managed
    if (!owner) return { status: 'rejected', code: 'unavailable' }
    const result = await owner.command(command, authorized)
    return result.snapshot === undefined ? result : { ...result, snapshot: this.snapshot() }
  }

  environmentRead(authorized: () => boolean): CatalogEnvironmentReadResult {
    if (!authorized() || !this.managed?.environmentEntries) return { status: 'rejected', code: 'unavailable' }
    return { status: 'ok', entries: this.managed.environmentEntries(), applies: 'app-restart' }
  }

  async environmentSave(
    entries: readonly CatalogTransferEnvironmentVariable[],
    authorized: () => boolean,
  ): Promise<CatalogEnvironmentSaveResult> {
    if (!authorized() || !this.managed?.saveEnvironment) return { status: 'rejected', code: 'unavailable' }
    try {
      await this.managed.saveEnvironment(entries, authorized)
      return { status: 'applied', applies: 'app-restart' }
    } catch (error) {
      return {
        status: 'rejected',
        code: error instanceof CatalogError && error.code === 'permission'
          ? 'unavailable'
          : error instanceof CatalogError && error.code === 'source-invalid'
          ? 'invalid'
          : 'persist-failed',
      }
    }
  }

  prepareExport(
    request: CatalogTransferExportRequest,
    authorized: () => boolean,
  ): CatalogTransferExportPreparationResult {
    if (!authorized()) return { status: 'rejected', code: 'unavailable' }
    try {
      const selections = transferSelections(request)
      const entries = new Map(this.managed?.environmentEntries?.().map(entry => [entry.name, entry]) ?? [])
      const prepared: Array<Extract<CatalogTransferExportPreparationResult, { status: 'ok' }>['variables'][number]> = []
      const dependencies = transferEnvironment(selections, this.native, this.managed)
      for (const [ref, source] of dependencies) {
        const existing = prepared.find(item => item.sourceName === source.sourceName)
        if (existing) {
          ;(existing.bindings as string[]).push(ref)
          continue
        }
        const entry = source.name === undefined ? undefined : entries.get(source.name)
        const value = source.value ?? entry?.value ?? ''
        prepared.push({
          sourceName: source.sourceName,
          name: source.sourceName,
          value,
          enabled: entry?.enabled ?? true,
          ...((source.description ?? entry?.description) === undefined
            ? {}
            : { description: source.description ?? entry?.description! }),
          ...(entry?.generator === undefined ? {} : { generator: entry.generator }),
          bindings: [ref],
          available: value !== '' && (entry?.enabled ?? true),
        })
      }
      return {
        status: 'ok',
        variables: Object.freeze(prepared.map(variable =>
          Object.freeze({
            ...variable,
            bindings: Object.freeze(variable.bindings),
          })
        )),
      }
    } catch {
      return { status: 'rejected', code: 'invalid' }
    }
  }

  async export(request: CatalogTransferExportRequest, authorized: () => boolean): Promise<CatalogTransferExportResult> {
    if (!authorized()) return { status: 'rejected', code: 'unavailable' }
    try {
      const selections = transferSelections(request)
      const dependencies = transferEnvironment(selections, this.native, this.managed)
      const connections = selections.map(({ bindingRef: ref, modelIds }) => {
        const connection = ref.startsWith('codex-config:')
          ? this.native.portableSelection(ref, modelIds)
          : this.managed?.portableSelection?.(ref, modelIds)
            ?? (() => {
              throw new PortableTransferError('invalid')
            })()
        const dependency = dependencies.get(ref)
        return dependency === undefined ? connection : { ...connection, environment: dependency.sourceName }
      })
      const required = new Set([...dependencies.values()].map(dependency => dependency.sourceName))
      if (required.size === 0 && (request.variables?.length || request.includeValues !== false)) {
        throw new PortableTransferError('invalid')
      }
      const variables = required.size === 0 ? [] : exportVariables(request, required)
      const mapping = new Map(variables.map(variable => [variable.sourceName, variable]))
      const mapped = connections.map(connection =>
        connection.environment === undefined
          ? connection
          : { ...connection, environment: mapping.get(connection.environment)!.name }
      )
      const hasGenerator = variables.some(variable => variable.generator !== undefined)
      const text = encodePortableBundle(
        required.size === 0
          ? { version: 1, connections: mapped }
          : {
            version: hasGenerator ? 3 : 2,
            environment: variables.map(variable => ({
              name: variable.name,
              ...(request.includeValues ? { value: variable.value ?? '' } : {}),
              ...(variable.description === undefined ? {} : { description: variable.description }),
              ...(variable.generator === undefined ? {} : { generator: variable.generator }),
            })),
            connections: mapped,
          },
      )
      return authorized() ? { status: 'ok', text } : { status: 'rejected', code: 'unavailable' }
    } catch (error) {
      return {
        status: 'rejected',
        code: error instanceof PortableTransferError ? error.code : 'invalid',
      }
    }
  }

  prepareImport(text: string, authorized: () => boolean): CatalogTransferImportPreparationResult {
    if (!authorized() || !this.managed?.preparePortableImport) return { status: 'rejected', code: 'unavailable' }
    try {
      const bundle = decodePortableBundle(text)
      return {
        status: 'ok',
        variables: this.managed.preparePortableImport(bundle).map(variable => ({
          ...variable,
          bindings: Object.freeze(
            bundle.connections
              .filter(connection => connection.environment === variable.sourceName)
              .map(connection => connection.title),
          ),
          available: variable.value !== '',
        })),
        connections: Object.freeze(bundle.connections.map(connection => ({
          transferId: connection.transferId,
          title: connection.title,
        }))),
      }
    } catch (error) {
      return { status: 'rejected', code: error instanceof PortableTransferError ? error.code : 'invalid' }
    }
  }

  async import(request: CatalogTransferImportRequest, authorized: () => boolean): Promise<CatalogTransferImportResult> {
    if (!authorized() || !this.managed?.importPortable) return { status: 'rejected', code: 'unavailable' }
    try {
      const bundle = decodePortableBundle(request.text)
      const result = await this.managed.importPortable(bundle, request.variables, authorized)
      return { status: 'applied', ...result }
    } catch (error) {
      return {
        status: 'rejected',
        code: error instanceof PortableTransferError
          ? error.code
          : error instanceof CatalogError && error.code === 'permission'
          ? 'unavailable'
          : error instanceof CatalogError && error.code === 'source-invalid'
          ? 'invalid'
          : 'persist-failed',
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  private changed(): void {
    this.#sequence++
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#listeners.clear()
    this.native.close()
  }
}
