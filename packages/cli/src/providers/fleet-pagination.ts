import { randomUUID } from 'node:crypto'
import type {
  CordisXPlatformResult,
  CordisXSessionPage,
  CordisXSessionSummary,
  CordisXTasksListInput,
} from '../contracts.js'
import { ProviderAdapterRegistry, ProviderRegistryError } from '../renderer/provider-registry.js'
import type { ProviderConnection } from './contracts.js'

import { copy, failure } from './fleet-results.js'
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

function normalizedQuery(
  input: CordisXTasksListInput,
  providerIds: readonly string[],
): Omit<CordisXTasksListInput, 'cursor'> {
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
  return `${left.ref.providerId}\0${left.ref.remoteSessionId}`.localeCompare(
    `${right.ref.providerId}\0${right.ref.remoteSessionId}`,
  )
}

export type FleetProviderOperation = <Value>(
  providerId: string,
  operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
  generation?: string,
) => Promise<CordisXPlatformResult<Value>>

/** Owns opaque pagination tokens; routing reads the current Fleet registry. */
export class FleetTaskPagination {
  private readonly cursors = new Map<string, FleetCursorState>()

  constructor(
    private readonly now: () => number,
    private readonly getRegistry: () => ProviderAdapterRegistry<ProviderConnection>,
    private readonly providers: (requested?: readonly string[]) => CordisXPlatformResult<readonly string[]>,
    private readonly withProvider: FleetProviderOperation,
  ) {}

  clear(): void {
    this.cursors.clear()
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
          const generation = this.getRegistry().snapshots().find(item =>
            item.providerId === providerId && item.state === 'active'
          )?.generation
          if (generation === undefined) {
            throw new ProviderRegistryError('adapter-unavailable', `Provider ${providerId} is unavailable`)
          }
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

  private async ensureBuffer(
    provider: ProviderPageState,
    query: Omit<CordisXTasksListInput, 'cursor'>,
  ): Promise<CordisXPlatformResult<true>> {
    if (provider.done || provider.buffer.length > 0) return { ok: true, value: true }
    const page = await this.withProvider(provider.providerId, async adapter =>
      await adapter.listSessions({
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

  private expireCursors(): void {
    const now = this.now()
    for (const [token, state] of this.cursors) if (state.expiresAt <= now) this.cursors.delete(token)
  }
}
