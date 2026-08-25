import { randomUUID } from 'node:crypto'
import type { ChannelTaskDispatchResult } from '@cordisx/channel-runtime'
import type {
  CordisXModelDescriptor,
  CordisXModelPage,
  CordisXModelsListInput,
  CordisXPlatformAdapterStatus,
  CordisXPlatformCapability,
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXSessionPage,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskControlInput,
  CordisXTaskControlOutcome,
  CordisXTaskCreateInput,
  CordisXTaskReadInput,
  CordisXTasksListInput,
  CordisXTurnControlInput,
  CordisXTurnControlOutcome,
  CordisXTurnStart,
  CordisXTurnSubmitInput,
} from '../contracts.js'
import type { CordisXPlatformAdapter } from '../renderer/platform.js'
import type { CordisXExternalProviderAvailabilityStatus } from '../capability-availability-contracts.js'
import { ProviderAdapterRegistry, ProviderRegistryError } from '../renderer/provider-registry.js'
import { startCodexAppServer, type CodexAppServerOptions, type CodexAppServerRpc } from './codex-app-server.js'
import { CliProxyProviderAdapter } from './cli-proxy-adapter.js'
import type { CliProxyProviderConfig, ProviderConnection, ProviderLifecycleSignal } from './contracts.js'

const FLEET_CAPABILITIES: readonly CordisXPlatformCapability[] = Object.freeze([
  'models.read', 'tasks.catalog.read', 'tasks.content.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control',
])
const CURRENT_CONNECTION_UNAVAILABLE: CordisXPlatformDiagnostic = Object.freeze({
  code: 'current-connection-client-unavailable',
  message: 'The native Codex Desktop current connection remains unavailable; external providers are routed independently',
})

interface ProviderPageState {
  readonly providerId: string
  readonly generation: string
  cursor: string | undefined
  buffer: CordisXSessionSummary[]
  done: boolean
}

interface FleetCursorState {
  readonly fingerprint: string
  readonly snapshotId: string
  readonly query: Omit<CordisXTasksListInput, 'cursor'>
  readonly providers: ProviderPageState[]
  readonly expiresAt: number
}

export interface ProviderFleetOptions {
  readonly now?: () => number
  readonly startServer?: (config: CliProxyProviderConfig, options?: CodexAppServerOptions) => Promise<CodexAppServerRpc>
  readonly appServer?: CodexAppServerOptions
}

function failure(code: CordisXPlatformDiagnostic['code'], message: string, retryable = false): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable: true } : {}) } }
}

function copy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

function normalizedQuery(input: CordisXTasksListInput, providerIds: readonly string[]): Omit<CordisXTasksListInput, 'cursor'> {
  return Object.freeze({
    providerIds: Object.freeze([...providerIds].sort()),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.searchTerm === undefined ? {} : { searchTerm: input.searchTerm }),
    limit: input.limit ?? 100,
  })
}

function queryFingerprint(query: Omit<CordisXTasksListInput, 'cursor'>): string {
  return JSON.stringify(query)
}

function sessionCompare(left: CordisXSessionSummary, right: CordisXSessionSummary): number {
  const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  if (updated !== 0) return updated
  return `${left.ref.providerId}\0${left.ref.remoteSessionId}`.localeCompare(`${right.ref.providerId}\0${right.ref.remoteSessionId}`)
}

function registryFailure(error: unknown): CordisXPlatformResult<never> {
  if (error instanceof ProviderRegistryError) {
    return failure(error.code === 'invalid-provider' ? 'invalid-provider' : 'adapter-unavailable', error.message, error.code !== 'invalid-provider')
  }
  return failure('adapter-failure', 'External provider routing failed', true)
}

/** Host-owned multi-provider router. Renderer calls never receive adapters, raw cursors, or child handles. */
export class ProviderFleet implements CordisXPlatformAdapter {
  private registry = new ProviderAdapterRegistry<ProviderConnection>()
  private failures = new Map<string, CordisXPlatformDiagnostic>()
  private names = new Map<string, string>()
  private readonly cursors = new Map<string, FleetCursorState>()
  private readonly now: () => number
  private readonly startServer: NonNullable<ProviderFleetOptions['startServer']>
  private readonly appServer: CodexAppServerOptions | undefined
  private readonly lifecycle = new Map<string, ChannelTaskLifecycleEvent[]>()
  private readonly lifecycleListeners = new Set<(event: ChannelTaskLifecycleEvent) => void>()
  private readonly operationResults = new Map<string, ChannelTaskDispatchResult>()
  private readonly lifecycleDisposers = new Map<string, () => void>()
  private closed = false

  private constructor(options: ProviderFleetOptions) {
    this.now = options.now ?? Date.now
    this.startServer = options.startServer ?? startCodexAppServer
    this.appServer = options.appServer
  }

  static async create(configs: readonly CliProxyProviderConfig[], options: ProviderFleetOptions = {}): Promise<ProviderFleet> {
    const fleet = new ProviderFleet(options)
    const start = fleet.startServer
    await Promise.all(configs.filter(config => config.enabled).map(async config => {
      fleet.names.set(config.id, config.displayName)
      try {
        const server = await start(config, options.appServer)
        const adapter = new CliProxyProviderAdapter(config, server)
        fleet.registry.register({
          providerId: config.id,
          generation: adapter.generation,
          adapter,
          dispose: async () => await adapter.close(),
        })
        const disposeLifecycle = adapter.subscribeLifecycle?.(event => fleet.observeLifecycle(adapter.generation, event))
        if (disposeLifecycle !== undefined) fleet.lifecycleDisposers.set(config.id, disposeLifecycle)
      } catch {
        fleet.failures.set(config.id, {
          code: 'adapter-unavailable',
          message: `External provider ${config.id} is unavailable`,
          retryable: true,
        })
      }
    }))
    return fleet
  }

  status(): CordisXPlatformAdapterStatus {
    const active = this.registry.snapshots().filter(item => item.state === 'active')
    return {
      hostId: 'cordisx-provider-fleet',
      hostName: 'CordisX External Provider Fleet',
      mode: active.length > 0 ? 'read-write' : 'unavailable',
      supportedCapabilities: active.length > 0 ? FLEET_CAPABILITIES : [],
      diagnostics: [CURRENT_CONNECTION_UNAVAILABLE, ...this.failures.values()],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  providerStatuses(): readonly CordisXExternalProviderAvailabilityStatus[] {
    const generations = new Map(this.registry.snapshots().filter(item => item.state === 'active').map(item => [item.providerId, item.generation]))
    return [...this.names].map(([providerId, displayName]) => {
      const generation = generations.get(providerId)
      return {
        providerId,
        displayName,
        ...(generation === undefined ? {} : { generation }),
        state: generation === undefined ? 'unavailable' as const : 'ready' as const,
      }
    }).sort((left, right) => left.providerId.localeCompare(right.providerId))
  }

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    const providers = this.providers(input.providerIds)
    if (!providers.ok) return providers
    const pages = await Promise.all(providers.value.map(async providerId => await this.withProvider(providerId, async adapter => await adapter.listModels())))
    const failed = pages.find(page => !page.ok)
    if (failed !== undefined && !failed.ok) return failed
    const models = pages.flatMap(page => page.ok ? page.value : []).sort((left, right) => {
      return `${left.label}\0${left.ref.providerId}\0${left.ref.modelId}`.localeCompare(`${right.label}\0${right.ref.providerId}\0${right.ref.modelId}`)
    })
    return { ok: true, value: { contract: 'cordisx.platform-model-page/v1', schemaVersion: 1, providerIds: providers.value, models } }
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    this.expireCursors()
    const providers = this.providers(input.providerIds)
    if (!providers.ok) return providers
    const query = normalizedQuery(input, providers.value)
    const fingerprint = queryFingerprint(query)
    let state: FleetCursorState
    if (input.cursor !== undefined) {
      const stored = this.cursors.get(input.cursor)
      this.cursors.delete(input.cursor)
      if (stored === undefined || stored.fingerprint !== fingerprint || stored.expiresAt <= this.now()) {
        return failure('invalid-request', 'Provider Fleet cursor is invalid, expired, or belongs to another query')
      }
      state = stored
    } else {
      state = {
        fingerprint,
        snapshotId: randomUUID(),
        query,
        providers: providers.value.map(providerId => {
          const generation = this.registry.snapshots().find(item => item.providerId === providerId && item.state === 'active')?.generation
          if (generation === undefined) throw new ProviderRegistryError('adapter-unavailable', `Provider ${providerId} is unavailable`)
          return { providerId, generation, cursor: undefined, buffer: [], done: false }
        }),
        expiresAt: this.now() + 10 * 60_000,
      }
    }
    const output: CordisXSessionSummary[] = []
    const limit = query.limit ?? 100
    while (output.length < limit) {
      const ready = await Promise.all(state.providers.map(async provider => await this.ensureBuffer(provider, query)))
      const failed = ready.find(result => !result.ok)
      if (failed !== undefined && !failed.ok) return failed
      const candidates = state.providers.filter(provider => provider.buffer.length > 0)
      if (candidates.length === 0) break
      candidates.sort((left, right) => sessionCompare(left.buffer[0]!, right.buffer[0]!))
      output.push(candidates[0]!.buffer.shift()!)
    }
    const hasMore = state.providers.some(provider => provider.buffer.length > 0 || !provider.done)
    let nextCursor: string | undefined
    if (hasMore) {
      nextCursor = randomUUID()
      this.cursors.set(nextCursor, { ...state, expiresAt: this.now() + 10 * 60_000 })
      if (this.cursors.size > 256) this.cursors.delete(this.cursors.keys().next().value as string)
    }
    return {
      ok: true,
      value: {
        contract: 'cordisx.platform-session-page/v1',
        schemaVersion: 1,
        query: copy(query),
        snapshotId: state.snapshotId,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        sessions: copy(output),
      },
    }
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    return await this.withSession(input.session, async adapter => await adapter.readSession(input.session))
  }

  async createTask(input: Omit<CordisXTaskCreateInput, 'initialMessage'>): Promise<CordisXPlatformResult<CordisXSessionSummary>> {
    return await this.withProvider(input.model.providerId, async adapter => await adapter.createSession(input))
  }

  async controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    return await this.withSession(input.session, async adapter => await adapter.controlSession(input))
  }

  async submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    return await this.withSession(input.session, async adapter => await adapter.submitTurn(input))
  }

  /** Launcher-private Channel create primitive; no renderer bridge uses this path. */
  async dispatchCreate(input: {
    readonly operationId: string
    readonly model: { readonly providerId: string; readonly modelId: string }
    readonly cwd: string
    readonly message: string
  }): Promise<ChannelTaskDispatchResult> {
    const prior = this.operationResults.get(input.operationId)
    if (prior !== undefined) return structuredClone(prior)
    const observedAt = new Date(this.now()).toISOString()
    const created = await this.createTask({ model: input.model, cwd: input.cwd })
    if (!created.ok) return this.remember({ contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId: input.operationId, operation: 'create', status: 'rejected', failure: { code: 'TASK_CREATE_REJECTED', retryable: created.error.retryable === true }, observedAt })
    const session = created.value.ref
    const cursor = this.cursor(session)
    const turn = await this.submitTurn({ session, message: input.message })
    if (!turn.ok) return this.remember({ contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId: input.operationId, operation: 'create', status: 'created-initial-turn-failed', session, lifecycle: { session, afterSequence: cursor }, failure: { code: 'TURN_START_FAILED', retryable: turn.error.retryable === true }, observedAt: new Date(this.now()).toISOString() })
    this.appendLifecycle({ providerGeneration: this.generationFor(session.providerId), session, turnId: turn.value.turnId, operationId: input.operationId, type: 'turn.started', provenance: 'observed', observedAt: new Date(this.now()).toISOString() })
    return this.remember({ contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId: input.operationId, operation: 'create', status: 'accepted', session, turn: { session, turnId: turn.value.turnId }, lifecycle: { session, afterSequence: cursor }, observedAt: new Date(this.now()).toISOString() })
  }

  /** Launcher-private Channel follow-up primitive against a complete bound session. */
  async dispatchFollowup(input: { readonly operationId: string; readonly session: CordisXTaskReadInput['session']; readonly message: string }): Promise<ChannelTaskDispatchResult> {
    const prior = this.operationResults.get(input.operationId)
    if (prior !== undefined) return structuredClone(prior)
    const observedAt = new Date(this.now()).toISOString()
    const cursor = this.cursor(input.session)
    const turn = await this.submitTurn({ session: input.session, message: input.message })
    if (!turn.ok) return this.remember({ contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId: input.operationId, operation: 'followup', status: 'rejected', failure: { code: 'TURN_START_REJECTED', retryable: turn.error.retryable === true }, observedAt })
    this.appendLifecycle({ providerGeneration: this.generationFor(input.session.providerId), session: input.session, turnId: turn.value.turnId, operationId: input.operationId, type: 'turn.started', provenance: 'observed', observedAt: new Date(this.now()).toISOString() })
    return this.remember({ contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId: input.operationId, operation: 'followup', status: 'accepted', session: input.session, turn: { session: input.session, turnId: turn.value.turnId }, lifecycle: { session: input.session, afterSequence: cursor }, observedAt: new Date(this.now()).toISOString() })
  }

  readLifecycle(session: CordisXTaskReadInput['session'], afterSequence = 0): ChannelTaskLifecycleRange {
    const events = (this.lifecycle.get(lifecycleKey(session)) ?? []).filter(event => event.sequence > afterSequence)
    return { contract: 'cordisx.platform-task-lifecycle-range/v1', schemaVersion: 1, session, afterSequence, nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events: structuredClone(events) }
  }

  subscribeLifecycle(listener: (event: ChannelTaskLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    return await this.withSession(input.session, async adapter => await adapter.controlTurn(input))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cursors.clear()
    for (const dispose of this.lifecycleDisposers.values()) dispose()
    this.lifecycleDisposers.clear()
    this.lifecycleListeners.clear()
    await this.registry.dispose()
  }

  /**
   * Start a replacement generation before retiring the previous adapters.
   * The narrow service-config API calls `finalize` only after persistence
   * commits, or `rollback` when it cannot, so callers never observe a
   * half-published Provider Fleet.
   */
  async reconfigure(configs: readonly CliProxyProviderConfig[]): Promise<{
    readonly generation: string
    rollback(): Promise<void>
    finalize(): Promise<void>
  }> {
    if (this.closed) throw new Error('Provider Fleet is closed')
    const replacement = await ProviderFleet.create(configs, {
      now: this.now,
      startServer: this.startServer,
      ...(this.appServer === undefined ? {} : { appServer: this.appServer }),
    })
    const previous = { registry: this.registry, failures: this.failures, names: this.names }
    this.registry = replacement.registry
    this.failures = replacement.failures
    this.names = replacement.names
    replacement.closed = true
    const generation = this.registry.snapshots().map(item => item.generation).sort().join(',') || `unavailable:${randomUUID()}`
    let settled = false
    return {
      generation,
      rollback: async () => {
        if (settled) return
        settled = true
        const current = this.registry
        this.registry = previous.registry
        this.failures = previous.failures
        this.names = previous.names
        await current.dispose()
      },
      finalize: async () => {
        if (settled) return
        settled = true
        await previous.registry.dispose()
      },
    }
  }

  private providers(requested?: readonly string[]): CordisXPlatformResult<readonly string[]> {
    const active = new Set(this.registry.snapshots().filter(item => item.state === 'active').map(item => item.providerId))
    const selected = requested === undefined || requested.length === 0 ? [...active].sort() : [...requested].sort()
    const unavailable = selected.find(providerId => !active.has(providerId))
    if (unavailable !== undefined) {
      return this.names.has(unavailable)
        ? failure('adapter-unavailable', `External provider ${unavailable} is unavailable`, true)
        : failure('invalid-provider', `External provider ${unavailable} is not configured`)
    }
    return { ok: true, value: selected }
  }

  private async ensureBuffer(provider: ProviderPageState, query: Omit<CordisXTasksListInput, 'cursor'>): Promise<CordisXPlatformResult<true>> {
    if (provider.done || provider.buffer.length > 0) return { ok: true, value: true }
    const page = await this.withProvider(provider.providerId, async adapter => await adapter.listSessions({
      ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      ...(query.searchTerm === undefined ? {} : { searchTerm: query.searchTerm }),
      ...(provider.cursor === undefined ? {} : { cursor: provider.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }), provider.generation)
    if (!page.ok) return page
    provider.buffer.push(...[...page.value.sessions].sort(sessionCompare))
    provider.cursor = page.value.nextCursor
    provider.done = page.value.nextCursor === undefined
    return { ok: true, value: true }
  }

  private async withProvider<Value>(
    providerId: string,
    operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
    generation?: string,
  ): Promise<CordisXPlatformResult<Value>> {
    try {
      const lease = this.registry.acquire(providerId, generation)
      try {
        return await operation(lease.adapter)
      } finally {
        lease.release()
      }
    } catch (error) {
      return registryFailure(error)
    }
  }

  private async withSession<Value>(
    session: CordisXTaskReadInput['session'],
    operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
  ): Promise<CordisXPlatformResult<Value>> {
    try {
      const lease = this.registry.acquireSession(session)
      try {
        return await operation(lease.adapter)
      } finally {
        lease.release()
      }
    } catch (error) {
      return registryFailure(error)
    }
  }

  private expireCursors(): void {
    const now = this.now()
    for (const [token, state] of this.cursors) if (state.expiresAt <= now) this.cursors.delete(token)
  }

  private remember(result: ChannelTaskDispatchResult): ChannelTaskDispatchResult {
    this.operationResults.set(result.operationId, structuredClone(result))
    return result
  }

  private generationFor(providerId: string): string {
    return this.registry.snapshots().find(item => item.providerId === providerId && item.state === 'active')?.generation ?? 'retired'
  }

  private cursor(session: CordisXTaskReadInput['session']): number {
    return (this.lifecycle.get(lifecycleKey(session)) ?? []).at(-1)?.sequence ?? 0
  }

  private observeLifecycle(generation: string, event: ProviderLifecycleSignal): void {
    if (this.generationFor(event.session.providerId) !== generation) return
    this.appendLifecycle({ providerGeneration: generation, session: event.session, turnId: event.turnId, type: event.type, provenance: 'observed', observedAt: new Date(this.now()).toISOString(), ...(event.output === undefined ? {} : { output: event.output }), ...(event.failure === undefined ? {} : { failure: event.failure }), ...(event.approval === undefined ? {} : { approval: event.approval }) })
  }

  private appendLifecycle(input: Omit<ChannelTaskLifecycleEvent, 'contract' | 'schemaVersion' | 'eventId' | 'sequence'>): void {
    const key = lifecycleKey(input.session)
    const current = this.lifecycle.get(key) ?? []
    if (current.some(event => event.turnId === input.turnId && event.type === input.type && (input.type !== 'turn.completed' && input.type !== 'turn.failed' || event.type === input.type))) return
    if ((input.type === 'turn.completed' || input.type === 'turn.failed') && current.some(event => event.turnId === input.turnId && (event.type === 'turn.completed' || event.type === 'turn.failed'))) return
    const event: ChannelTaskLifecycleEvent = { contract: 'cordisx.platform-task-lifecycle-event/v1', schemaVersion: 1, eventId: `lifecycle:${randomUUID()}`, sequence: current.length + 1, ...input }
    this.lifecycle.set(key, [...current, event])
    for (const listener of this.lifecycleListeners) listener(structuredClone(event))
  }
}

export interface ChannelTaskLifecycleEvent {
  readonly contract: 'cordisx.platform-task-lifecycle-event/v1'
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly providerGeneration: string
  readonly session: CordisXTaskReadInput['session']
  readonly turnId: string
  readonly operationId?: string
  readonly type: ProviderLifecycleSignal['type']
  readonly provenance: 'observed' | 'snapshot-reconciled'
  readonly output?: readonly { readonly type: 'text'; readonly text: string }[]
  readonly failure?: { readonly code: string; readonly retryable: boolean }
  readonly approval?: ProviderLifecycleSignal['approval']
  readonly observedAt: string
}

export interface ChannelTaskLifecycleRange {
  readonly contract: 'cordisx.platform-task-lifecycle-range/v1'
  readonly schemaVersion: 1
  readonly session: CordisXTaskReadInput['session']
  readonly afterSequence: number
  readonly nextAfterSequence: number
  readonly events: readonly ChannelTaskLifecycleEvent[]
}

function lifecycleKey(session: CordisXTaskReadInput['session']): string {
  return `${session.providerId}\u0000${session.remoteSessionId}`
}
