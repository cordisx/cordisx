import {
  boundedString,
  type CatalogBinding,
  CatalogError,
  type CatalogModel,
  catalogModels,
  type CatalogSnapshot,
  type CatalogSupplement,
  type DiscoveryConnection,
} from './contracts.js'
import type { DiscoveryAdapterRegistry } from './registry.js'
import { composeMembers, parseSupplement } from './supplement.js'
import { withAbort } from './abort.js'

interface Entry {
  binding: CatalogBinding
  snapshot: CatalogSnapshot
  epoch: number
  abort?: AbortController
  job?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  failures: number
  retryAt: number
  source: readonly CatalogModel[]
  supplement?: CatalogSupplement
  paused: boolean
}

export interface CatalogServiceOptions {
  readonly registry: DiscoveryAdapterRegistry
  readonly connection: (binding: CatalogBinding) => DiscoveryConnection | undefined
  readonly read: (binding: CatalogBinding, signal: AbortSignal) => Promise<readonly CatalogModel[]>
  readonly now?: () => number
  /** Commit validated acquisition before publication when the owner supplies durable storage. */
  readonly persistSource?: (snapshot: CatalogSnapshot, current: () => boolean) => Promise<void>
}

/** One owner per target. Readers never await source I/O; only completed candidates are published. */
export class ModelCatalogService {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private disposed = false
  private readonly now: () => number

  constructor(private readonly options: CatalogServiceOptions) {
    this.now = options.now ?? Date.now
  }

  get revision(): number {
    return this.sequence
  }

  snapshot(bindingRef: string): CatalogSnapshot | undefined {
    return this.entries.get(bindingRef)?.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  configure(binding: CatalogBinding, options: { paused?: boolean; cached?: CatalogSnapshot } = {}): void {
    if (this.disposed) return
    const previous = this.entries.get(binding.bindingRef)
    if (previous && JSON.stringify(previous.binding) === JSON.stringify(binding)) {
      this.setPaused(binding.bindingRef, options.paused ?? false)
      return
    }
    if (previous) this.stop(previous)
    const entry: Entry = {
      binding: structuredClone(binding),
      snapshot: Object.freeze({
        bindingRef: binding.bindingRef,
        scopeRevision: binding.scopeRevision,
        authorityRevision: binding.authorityRevision,
        revision: ++this.sequence,
        models: Object.freeze([]),
        complete: false,
        freshness: 'unknown',
        loading: false,
      }),
      epoch: 0,
      failures: 0,
      retryAt: 0,
      source: Object.freeze([]),
      paused: options.paused ?? false,
      ...(previous?.binding.scopeRevision === binding.scopeRevision && previous.supplement
        ? { supplement: previous.supplement }
        : {}),
    }
    const cached = options.cached
    if (
      cached?.complete && cached.bindingRef === binding.bindingRef && cached.scopeRevision === binding.scopeRevision
      && cached.authorityRevision === binding.authorityRevision
    ) {
      const byId = new Map(cached.models.map(model => [model.id, model]))
      entry.source = Object.freeze(
        catalogModels(cached.models.map(model => model.id)).map(model => ({
          ...model,
          ...(byId.get(model.id)?.protocolCapabilities
            ? { protocolCapabilities: { responses: byId.get(model.id)!.protocolCapabilities!.responses === true } }
            : {}),
        })),
      )
      entry.snapshot = Object.freeze({
        ...entry.snapshot,
        complete: true,
        freshness: 'stale',
        ...(cached.error === undefined ? {} : { error: cached.error }),
        ...(cached.lastSuccessAt === undefined ? {} : { lastSuccessAt: cached.lastSuccessAt }),
      })
    }
    entry.snapshot = Object.freeze({
      ...entry.snapshot,
      models: composeMembers(entry.source, binding.strategy, entry.supplement),
    })
    this.entries.set(binding.bindingRef, entry)
    this.emit()
    // Scheduling is intentionally outside startup, selection and submission awaits.
    if (!entry.paused) this.schedule(entry, 0)
  }

  setPaused(bindingRef: string, paused: boolean): void {
    const entry = this.entries.get(bindingRef)
    if (!entry || this.disposed || entry.paused === paused) return
    entry.paused = paused
    if (paused) {
      this.stop(entry)
      delete entry.job
      delete entry.abort
      delete entry.timer
      this.publish(entry, { loading: false })
    } else this.schedule(entry, 0)
  }

  sourceSnapshot(bindingRef: string): CatalogSnapshot | undefined {
    const entry = this.entries.get(bindingRef)
    return entry ? Object.freeze({ ...entry.snapshot, models: entry.source }) : undefined
  }

  setSupplement(bindingRef: string, scopeRevision: string, authorityRevision: string, candidate: unknown): void {
    const entry = this.entries.get(bindingRef)
    if (!entry || this.disposed || entry.binding.scopeRevision !== scopeRevision) return
    try {
      const supplement = parseSupplement(candidate)
      if (supplement.scopeRevision !== scopeRevision || supplement.authorityRevision !== authorityRevision) {
        throw new CatalogError('source-invalid')
      }
      if (JSON.stringify(entry.supplement) === JSON.stringify(supplement) && !entry.snapshot.supplementError) return
      entry.supplement = supplement
      const { supplementError: _error, ...snapshot } = entry.snapshot
      entry.snapshot = snapshot
      this.publish(entry, { models: composeMembers(entry.source, entry.binding.strategy, supplement) })
    } catch {
      if (entry.supplement?.authorityRevision !== authorityRevision) delete entry.supplement
      this.publish(entry, {
        models: composeMembers(entry.source, entry.binding.strategy, entry.supplement),
        supplementError: 'source-invalid',
      })
    }
  }

  remove(bindingRef: string): void {
    const entry = this.entries.get(bindingRef)
    if (!entry) return
    this.stop(entry)
    this.entries.delete(bindingRef)
    this.sequence++
    this.emit()
  }

  refresh(bindingRef: string): Promise<void> {
    const entry = this.entries.get(bindingRef)
    if (this.disposed || !entry || entry.paused) return Promise.resolve()
    if (entry.job) return entry.job
    if (this.now() < entry.retryAt) return Promise.resolve()
    if (entry.timer) clearTimeout(entry.timer)
    delete entry.timer
    const epoch = ++entry.epoch
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 30_000)
    deadline.unref?.()
    entry.abort = abort
    const current = () => !this.disposed && this.entries.get(bindingRef) === entry && entry.epoch === epoch
    const job = Promise.resolve().then(async () => {
      try {
        const models = await withAbort(this.load(entry.binding, abort.signal), abort.signal)
        if (!current() || abort.signal.aborted) return
        if (
          models.some(model =>
            !boundedString(model.label, 256) || !Array.isArray(model.aliases)
            || model.aliases.length > 128 || model.aliases.some(alias => !boundedString(alias, 256))
          )
        ) {
          throw new CatalogError('source-invalid')
        }
        // Validate private owner results too; do not trust injected source implementations.
        const ids = catalogModels(models.map(model => model.id))
        const byId = new Map(models.map(model => [model.id, model]))
        const validated = Object.freeze(ids.map(model =>
          Object.freeze({
            ...model,
            label: byId.get(model.id)?.label ?? model.id,
            aliases: Object.freeze([...(byId.get(model.id)?.aliases ?? [])]),
            ...(byId.get(model.id)?.protocolCapabilities
              ? {
                protocolCapabilities: Object.freeze({
                  responses: byId.get(model.id)!.protocolCapabilities!.responses === true,
                }),
              }
              : {}),
          })
        ))
        entry.failures = 0
        entry.retryAt = 0
        const { error: _error, ...snapshot } = entry.snapshot
        const candidate = Object.freeze({
          ...snapshot,
          revision: ++this.sequence,
          models: validated,
          complete: true,
          freshness: 'fresh' as const,
          loading: false,
          lastSuccessAt: this.now(),
        })
        await this.options.persistSource?.(candidate, current)
        if (!current() || abort.signal.aborted) return
        entry.source = validated
        entry.snapshot = Object.freeze({
          ...candidate,
          models: composeMembers(validated, entry.binding.strategy, entry.supplement),
        })
        this.emit()
        if (entry.binding.strategy.kind === 'auto') this.schedule(entry, entry.binding.strategy.ttlMs)
      } catch (error) {
        if (!current()) return
        const failure = error instanceof CatalogError
          ? error
          : new CatalogError(abort.signal.aborted ? 'temporary' : 'source-invalid')
        this.publish(entry, {
          loading: false,
          freshness: entry.snapshot.complete ? 'stale' : 'unknown',
          error: failure.code,
        })
        if (entry.binding.strategy.kind === 'auto' && ['temporary', 'rate-limit'].includes(failure.code)) {
          const delay = Math.max(
            Math.min(30_000 * 2 ** Math.min(entry.failures++, 6), 1_800_000),
            failure.retryAfterMs ?? 0,
          )
          entry.retryAt = this.now() + delay
          if (delay <= 86_400_000) this.schedule(entry, delay)
        }
      } finally {
        clearTimeout(deadline)
        if (current()) {
          delete entry.job
          delete entry.abort
        }
      }
    })
    entry.job = job
    this.publish(entry, { loading: true })
    return job
  }

  private async load(binding: CatalogBinding, signal: AbortSignal): Promise<readonly CatalogModel[]> {
    const strategy = binding.strategy
    if (strategy.kind === 'script') throw new CatalogError('unsupported')
    if (strategy.kind === 'manual' && 'ids' in strategy) return catalogModels(strategy.ids)
    if (strategy.kind !== 'auto') return this.options.read(binding, signal)
    const connection = this.options.connection(binding)
    if (!connection || connection.scopeRevision !== binding.scopeRevision || !connection.current()) {
      throw new CatalogError('unsupported')
    }
    const adapter = this.options.registry.resolve(connection, strategy.adapter)
    const models = await adapter.discover(connection, signal)
    if (!connection.current()) throw new CatalogError('cancelled')
    return models
  }

  private schedule(entry: Entry, delay: number): void {
    if (entry.paused || this.disposed) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      delete entry.timer
      if (entry.snapshot.complete) this.publish(entry, { freshness: 'stale' })
      void this.refresh(entry.binding.bindingRef)
    }, delay)
    entry.timer.unref?.()
  }

  private publish(entry: Entry, patch: Partial<CatalogSnapshot>): void {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch, revision: ++this.sequence })
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch { /* A disconnected reader cannot prevent a commit. */ }
    }
  }

  private stop(entry: Entry): void {
    entry.epoch++
    entry.abort?.abort()
    if (entry.timer) clearTimeout(entry.timer)
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.stop(entry)
    this.entries.clear()
    this.listeners.clear()
  }
}
