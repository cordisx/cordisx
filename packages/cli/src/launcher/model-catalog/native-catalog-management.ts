import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CatalogManagementCommand,
  CatalogManagementResult,
  CatalogManagementSnapshot,
  CatalogManagementView,
} from '../../model-catalog-management.js'
import {
  ManagementOverlayError,
  ManagementOverlayStore,
  projectManagementOverlay,
} from '../../model-catalog/management-overlay.js'
import type { CodexConfigModelProviderProjection } from '../codex-config-model-providers.js'
import type { NativeModelProviderCatalogEntry } from '../native-model-provider-catalog.js'
import type { CatalogSnapshot } from './contracts.js'

type CatalogManagementAuthority = {
  snapshot(): CatalogManagementSnapshot
  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult>
  subscribe(listener: () => void): () => void
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
  #writeAllowed: () => boolean = () => true

  private constructor(
    projection: CodexConfigModelProviderProjection,
    initialOverlay: unknown,
    private readonly options: {
      load(): Promise<CodexConfigModelProviderProjection>
      stateFile?: string
      refreshBeforeRead?: boolean
      shadowed?(providerId: string): boolean
      discovery?: NativeCatalogDiscovery
    },
  ) {
    this.#projection = projection
    this.recordGood(projection)
    try {
      this.#overlay = new ManagementOverlayStore(data => this.persist(data), initialOverlay)
    } catch {
      this.#persistError = true
      this.#overlay = new ManagementOverlayStore(data => this.persist(data))
    }
  }

  static async open(options: {
    load(): Promise<CodexConfigModelProviderProjection>
    stateFile?: string
    refreshBeforeRead?: boolean
    shadowed?(providerId: string): boolean
    discovery?: NativeCatalogDiscovery
    subscribeSource?(listener: (projection: CodexConfigModelProviderProjection) => void): () => void
  }): Promise<NativeCatalogManagement> {
    const [projection, initialOverlay] = await Promise.all([
      options.load(),
      options.stateFile === undefined ? undefined : readOverlayState(options.stateFile).catch(() => undefined),
    ])
    const authority = new NativeCatalogManagement(projection, initialOverlay, options)
    const unsubscribes = [
      options.subscribeSource?.(projection => authority.replace(projection)),
      options.discovery?.subscribe(() => authority.changed()),
    ].filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined)
    authority.#unsubscribeSource = () => unsubscribes.forEach(unsubscribe => unsubscribe())
    return authority
  }

  private async persist(data: ReturnType<ManagementOverlayStore['snapshot']>): Promise<void> {
    if (this.options.stateFile === undefined) return
    try {
      await writeOverlayState(this.options.stateFile, data, this.#writeAllowed)
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
    const changed = safeRevision(this.#projection) !== safeRevision(projection)
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
      this.sourceModels(provider).map(model => ({
        ...model,
        selectable: available && (confirmed.has(model.id) || model.protocolCapabilities?.responses === true),
      })),
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
      sourceAvailable: this.#projection.sourceAvailable,
      diagnostics: this.#projection.diagnostics.filter(item => item.providerId === provider.providerId),
      persistError: this.#persistError,
    })
  }

  snapshot(): CatalogManagementSnapshot {
    if (this.#closed) return { epoch: this.#epoch, sequence: this.#sequence, views: [], canCreateConnection: false }
    const views = this.providersForManagement().map((provider): CatalogManagementView => {
      const rows = this.rows(provider)
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
        sourceCount,
        selectableCount: rows.filter(row => row.selectable).length,
        rows,
        supplement: [],
        capabilities: ['refresh', 'setOverlay', 'resetOrder', 'restoreBlocked'],
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
      views: Object.freeze(views),
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
    const execute = async (): Promise<CatalogManagementResult> => {
      if (this.#closed || !authorized()) return { status: 'rejected', code: 'permission' }
      if (command.operation === 'createConnection') return { status: 'rejected', code: 'unsupported' }
      if (!['refresh', 'setOverlay', 'resetOrder', 'restoreBlocked'].includes(command.operation)) {
        return { status: 'rejected', code: 'unsupported' }
      }
      const provider = this.providersForManagement().find(candidate =>
        bindingRef(candidate.providerId) === command.bindingRef
      )
      if (!provider || command.scopeRevision !== this.scope(provider.providerId)) {
        return { status: 'conflict', code: 'scope-changed' }
      }
      if (command.expectedRevision !== this.revision(provider)) return { status: 'conflict', code: 'conflict' }
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
          this.#writeAllowed = () => !this.#closed && authorized()
          try {
            if (command.operation === 'setOverlay') {
              await this.#overlay.mutate({ ...command, ...scope }, this.sourceModels(provider).map(model => model.id))
            } else if (command.operation === 'resetOrder' || command.operation === 'restoreBlocked') {
              await this.#overlay.mutate(
                { ...scope, operation: command.operation },
                this.sourceModels(provider).map(model => model.id),
              )
            } else {
              return { status: 'rejected', code: 'unsupported' }
            }
          } finally {
            this.#writeAllowed = () => true
          }
          this.changed()
        }
        if (!authorized()) return { status: 'rejected', code: 'permission' }
        return { status: 'applied', snapshot: this.snapshot() }
      } catch (error) {
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
      views: Object.freeze([...(managed?.views ?? []), ...this.native.snapshot().views]),
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
