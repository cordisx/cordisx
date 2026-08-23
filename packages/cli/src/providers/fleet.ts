import { randomUUID } from 'node:crypto'
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
import { ProviderAdapterRegistry, ProviderRegistryError } from '../renderer/provider-registry.js'
import { startCodexAppServer, type CodexAppServerOptions, type CodexAppServerRpc } from './codex-app-server.js'
import { CliProxyProviderAdapter } from './cli-proxy-adapter.js'
import type { CliProxyProviderConfig, ProviderConnection } from './contracts.js'

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
  private readonly registry = new ProviderAdapterRegistry<ProviderConnection>()
  private readonly failures = new Map<string, CordisXPlatformDiagnostic>()
  private readonly names = new Map<string, string>()
  private readonly cursors = new Map<string, FleetCursorState>()
  private readonly now: () => number
  private closed = false

  private constructor(options: ProviderFleetOptions) {
    this.now = options.now ?? Date.now
  }

  static async create(configs: readonly CliProxyProviderConfig[], options: ProviderFleetOptions = {}): Promise<ProviderFleet> {
    const fleet = new ProviderFleet(options)
    const start = options.startServer ?? startCodexAppServer
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

  providerStatuses(): readonly { providerId: string; displayName: string; generation?: string; state: 'ready' | 'unavailable' }[] {
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

  async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    return await this.withSession(input.session, async adapter => await adapter.controlTurn(input))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cursors.clear()
    await this.registry.dispose()
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
}
