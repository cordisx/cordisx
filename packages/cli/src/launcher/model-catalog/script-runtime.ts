import { randomUUID } from 'node:crypto'
import { executeScript } from './script-executor.js'
import { parseScriptSourceConfig, safeScriptText, scriptEnvironment } from './script-schema.js'
import {
  type ScriptDiagnostic,
  type ScriptIntent,
  type ScriptRunReply,
  type ScriptSourceBinding,
  type ScriptSourceConfig,
  ScriptSourceError,
  type ScriptSourceEvent,
  type ScriptSourceSnapshot,
} from './script-types.js'

interface Entry {
  readonly binding: ScriptSourceBinding
  readonly config: ScriptSourceConfig
  snapshot: ScriptSourceSnapshot
}
interface Job {
  readonly abort: AbortController
  readonly done: Promise<void>
}

/** Saving trusts the developer's command. Reads, save and subscriptions never execute it. */
export class ScriptSourceRuntime {
  private readonly entries = new Map<string, Entry>()
  private readonly jobs = new Map<string, Job>()
  private readonly listeners = new Set<(event: ScriptSourceEvent) => void>()
  private readonly maxConcurrent: number
  private revision = 0
  private runGeneration = 0
  private disposed = false

  constructor(
    private readonly options: {
      /** Defaults to the Host environment, read only for explicit inheritance/references. No credential owner. */
      readonly environment?: () => Readonly<Record<string, string | undefined>>
      readonly maxConcurrent?: number
      readonly diagnostic?: (value: ScriptDiagnostic) => void
    } = {},
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 4
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 4) {
      throw new ScriptSourceError('script-budget-exceeded')
    }
  }

  /** Host Provider configuration only. Restoring saved config is allowed, but does not run it. */
  save(binding: ScriptSourceBinding, candidate: unknown): ScriptSourceSnapshot {
    if (
      this.disposed || ![binding.bindingRef, binding.scopeRevision].every(value => safeScriptText(value, 512))
      || !['replace', 'supplement'].includes(binding.mode)
    ) throw new ScriptSourceError('script-scope-invalid')
    const config = parseScriptSourceConfig(candidate)
    const previous = this.entries.get(binding.bindingRef)
    if (
      previous && JSON.stringify(previous.binding) === JSON.stringify(binding)
      && JSON.stringify(previous.config) === JSON.stringify(config)
    ) return previous.snapshot
    if (!previous && this.entries.size >= 128) throw new ScriptSourceError('script-budget-exceeded')
    this.jobs.get(binding.bindingRef)?.abort.abort()
    const entry: Entry = {
      binding: Object.freeze({
        bindingRef: binding.bindingRef,
        scopeRevision: binding.scopeRevision,
        mode: binding.mode,
      }),
      config,
      snapshot: Object.freeze({
        bindingRef: binding.bindingRef,
        scopeRevision: binding.scopeRevision,
        mode: binding.mode,
        authorityRevision: randomUUID(),
        revision: ++this.revision,
        runGeneration: ++this.runGeneration,
        models: Object.freeze([]),
        complete: false,
        loading: false,
        freshness: 'unknown',
        evidence: 'script-declared',
        persistence: 'session-only',
      }),
    }
    this.entries.set(binding.bindingRef, entry)
    this.notify(entry, 'changed')
    return entry.snapshot
  }

  readStatus(bindingRef: string): ScriptSourceSnapshot | undefined {
    return this.entries.get(bindingRef)?.snapshot
  }

  run(intent: ScriptIntent): ScriptRunReply {
    const entry = this.checked(intent)
    if (this.jobs.has(intent.bindingRef)) return { status: 'already-running' }
    if (this.jobs.size >= this.maxConcurrent) return { status: 'busy' }
    const abort = new AbortController()
    const current = () => !this.disposed && this.entries.get(intent.bindingRef) === entry
    const done = Promise.resolve().then(async () => {
      try {
        if (abort.signal.aborted) throw new ScriptSourceError('cancelled')
        const needsEnvironment = entry.config.environment.inherit
          || Object.keys(entry.config.environment.refs).length > 0
        const env = scriptEnvironment(
          entry.config,
          needsEnvironment ? (this.options.environment?.() ?? process.env) : {},
        )
        const models = await executeScript(
          { config: entry.config, env },
          entry.binding.mode,
          abort.signal,
          this.options.diagnostic,
        )
        if (!current()) return
        if (abort.signal.aborted) throw new ScriptSourceError('cancelled')
        const { error: _error, ...snapshot } = entry.snapshot
        entry.snapshot = snapshot
        this.publish(entry, { models, complete: true, freshness: 'fresh', loading: false, lastSuccessAt: Date.now() })
      } catch (error) {
        if (!current()) return
        const code = error instanceof ScriptSourceError ? error.code : 'script-exit-failed'
        this.publish(entry, { loading: false, freshness: entry.snapshot.complete ? 'stale' : 'unknown', error: code })
      } finally {
        this.jobs.delete(intent.bindingRef)
      }
    })
    this.jobs.set(intent.bindingRef, { abort, done })
    this.publish(entry, { loading: true, lastAttemptAt: Date.now(), runGeneration: ++this.runGeneration })
    return { status: 'started' }
  }

  async cancel(intent: ScriptIntent): Promise<void> {
    this.checked(intent)
    const job = this.jobs.get(intent.bindingRef)
    if (!job) return
    job.abort.abort()
    await job.done
  }

  async remove(bindingRef: string): Promise<void> {
    const entry = this.entries.get(bindingRef)
    this.entries.delete(bindingRef)
    const job = this.jobs.get(bindingRef)
    job?.abort.abort()
    if (entry) {
      this.revision++
      this.notify(entry, 'removed')
    }
    await job?.done
  }

  subscribe(listener: (event: ScriptSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.abort.abort()
    this.entries.clear()
    this.listeners.clear()
    await Promise.all(jobs.map(job => job.done))
  }

  private checked(intent: ScriptIntent): Entry {
    const entry = this.entries.get(intent.bindingRef)
    if (
      this.disposed || !entry || entry.binding.scopeRevision !== intent.scopeRevision
      || entry.snapshot.revision !== intent.expectedRevision
    ) throw new ScriptSourceError('script-scope-invalid')
    return entry
  }

  private publish(entry: Entry, patch: Partial<ScriptSourceSnapshot>): void {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch, revision: ++this.revision })
    this.notify(entry, 'changed')
  }

  private notify(entry: Entry, kind: ScriptSourceEvent['kind']): void {
    const event: ScriptSourceEvent = Object.freeze({
      kind,
      bindingRef: entry.binding.bindingRef,
      scopeRevision: entry.binding.scopeRevision,
      authorityRevision: entry.snapshot.authorityRevision,
      runGeneration: entry.snapshot.runGeneration,
      revision: this.revision,
    })
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch { /* Observers do not control publication. */ }
    }
  }
}
