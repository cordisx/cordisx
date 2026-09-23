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

type CatalogManagementAuthority = {
  snapshot(): CatalogManagementSnapshot
  command(command: CatalogManagementCommand, authorized: () => boolean): Promise<CatalogManagementResult>
  subscribe(listener: () => void): () => void
}

const bindingRef = (providerId: string) => `codex-config:${providerId}`
const scopeRevision = (providerId: string) =>
  createHash('sha256').update(JSON.stringify(['codex-config-v1', providerId])).digest('hex')
const safeRevision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

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
    subscribeSource?(listener: (projection: CodexConfigModelProviderProjection) => void): () => void
  }): Promise<NativeCatalogManagement> {
    const [projection, initialOverlay] = await Promise.all([
      options.load(),
      options.stateFile === undefined ? undefined : readOverlayState(options.stateFile).catch(() => undefined),
    ])
    const authority = new NativeCatalogManagement(projection, initialOverlay, options)
    authority.#unsubscribeSource = options.subscribeSource?.(projection => authority.replace(projection))
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
    const available = diagnosticCode(this.#projection, provider.providerId) === undefined && !this.#persistError
    const projected = projectManagementOverlay(
      provider.models.map(model => ({ ...model, selectable: available })),
      this.#overlay.read(bindingRef(provider.providerId), scopeRevision(provider.providerId)),
    )
    return [
      ...projected.active.map(row => ({
        ...row,
        provenance: ['native' as const],
        notListed: row.notListed ?? false,
        ...(!row.selectable && !row.blocked && !available ? { reason: 'unconfirmed' as const } : {}),
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
    const scope = scopeRevision(provider.providerId)
    const overlay = this.#overlay.read(bindingRef(provider.providerId), scope)
    return safeRevision({
      provider,
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
      return {
        bindingRef: bindingRef(provider.providerId),
        providerId: provider.providerId,
        title: provider.title ?? provider.providerId,
        scopeRevision: scopeRevision(provider.providerId),
        revision: this.revision(provider),
        sourceKind: 'native',
        mode: 'only',
        freshness: unavailable ? 'stale' : 'fresh',
        activity: 'idle',
        outcome: unavailable ? 'error' : provider.models.length === 0 ? 'empty' : 'ok',
        autoPaused: false,
        sourceCount: provider.models.length,
        selectableCount: rows.filter(row => row.selectable).length,
        rows,
        supplement: [],
        capabilities: ['refresh', 'setOverlay', 'resetOrder', 'restoreBlocked'],
        diagnostics: {
          scopeConfirmed: true,
          targetState: unavailable ? 'unavailable' : 'applied',
          ...(unavailable ? { code: this.#persistError ? 'persist-failed' : 'unavailable' } : {}),
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
          const source = provider.models.find(model => model.id === row.id)!
          return Object.freeze({ ...source })
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
      if (!provider || command.scopeRevision !== scopeRevision(provider.providerId)) {
        return { status: 'conflict', code: 'scope-changed' }
      }
      if (command.expectedRevision !== this.revision(provider)) return { status: 'conflict', code: 'conflict' }
      try {
        if (command.operation === 'refresh') {
          await this.refresh(true)
        } else {
          const scope = {
            bindingRef: command.bindingRef,
            scopeRevision: command.scopeRevision,
            expectedRevision: this.#overlay.read(command.bindingRef, command.scopeRevision).revision,
          }
          this.#writeAllowed = () => !this.#closed && authorized()
          try {
            if (command.operation === 'setOverlay') {
              await this.#overlay.mutate({ ...command, ...scope }, provider.models.map(model => model.id))
            } else if (command.operation === 'resetOrder' || command.operation === 'restoreBlocked') {
              await this.#overlay.mutate(
                { ...scope, operation: command.operation },
                provider.models.map(model => model.id),
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
