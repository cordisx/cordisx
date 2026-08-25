import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  ChannelAdapterDescriptor,
  ChannelInboxStatus,
  ChannelInboundEnvelope,
  ChannelOutboxStatus,
  ChannelOutboundDelivery,
  ChannelPermissionDecision,
  ChannelPluginIdentity,
  ChannelSessionBinding,
  ChannelTaskResult,
} from './types.js'

export interface StoredAdapterState extends ChannelAdapterDescriptor {
  readonly owner: ChannelPluginIdentity
  generation: number
  lastGoodRevision: number
  connectionState: 'disabled' | 'starting' | 'ready' | 'retrying' | 'unavailable' | 'stopped'
  cursorUpdatedAt?: string
  lastErrorCode?: string
}

export interface StoredInboxRecord {
  readonly recordId: string
  readonly fingerprint: string
  readonly accountKey: string
  readonly operationId: string
  readonly caller: ChannelPluginIdentity
  readonly envelope: ChannelInboundEnvelope
  readonly generation: number
  readonly receivedAt: string
  readonly status: ChannelInboxStatus
  readonly attempts: number
  readonly nextAttemptAt?: string
  readonly leaseGeneration?: number
  readonly leaseExpiresAt?: string
  readonly permission?: ChannelPermissionDecision
  readonly result?: ChannelTaskResult
  readonly errorCode?: string
  readonly updatedAt: string
}

export interface StoredOutboxRecord extends ChannelOutboundDelivery {
  readonly accountKey: string
  readonly generation: number
  readonly caller: ChannelPluginIdentity
  readonly status: ChannelOutboxStatus
  readonly attempts: number
  readonly nextAttemptAt?: string
  readonly claimedAt?: string
  readonly externalMessageId?: string
  readonly recallHandle?: string
  readonly errorCode?: string
  readonly updatedAt: string
}

export interface StoredAuditRecord {
  readonly auditId: string
  readonly recordedAt: string
  readonly accountKey: string
  readonly generation: number
  readonly operationId: string
  readonly source: string
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly action: string
  readonly outcome: string
  readonly capability?: string
  readonly bindingRevision?: number
  readonly sessionKey?: string
  readonly eventKey?: string
}

export interface ChannelStoreState {
  contract: 'cordisx.channel-store/v1'
  schemaVersion: 1
  revision: number
  adapters: Record<string, StoredAdapterState>
  inbox: Record<string, StoredInboxRecord>
  outbox: Record<string, StoredOutboxRecord>
  bindings: ChannelSessionBinding[]
  /** Launcher-private durable cursors keyed by the complete Platform session. */
  lifecycleCursors: Record<string, number>
  audit: StoredAuditRecord[]
}

function initialState(): ChannelStoreState {
  return {
    contract: 'cordisx.channel-store/v1',
    schemaVersion: 1,
    revision: 0,
    adapters: {},
    inbox: {},
    outbox: {},
    bindings: [],
    lifecycleCursors: {},
    audit: [],
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isState(value: unknown): value is ChannelStoreState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<ChannelStoreState>
  return state.contract === 'cordisx.channel-store/v1'
    && state.schemaVersion === 1
    && Number.isInteger(state.revision)
    && state.adapters !== null && typeof state.adapters === 'object'
    && state.inbox !== null && typeof state.inbox === 'object'
    && state.outbox !== null && typeof state.outbox === 'object'
    && Array.isArray(state.bindings)
    && (state.lifecycleCursors === undefined || state.lifecycleCursors !== null && typeof state.lifecycleCursors === 'object' && !Array.isArray(state.lifecycleCursors))
    && Array.isArray(state.audit)
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * A serialized JSON store for the simulator/core milestone. Each transaction
 * writes and fsyncs a replacement before rename, then fsyncs the parent
 * directory. It is single-process by contract; a later launcher store adapter
 * may replace it without changing the runtime facade.
 */
export class JsonChannelStore {
  readonly #file: string
  #state: ChannelStoreState = initialState()
  #tail: Promise<void> = Promise.resolve()

  private constructor(file: string) {
    this.#file = file
  }

  static async open(file: string): Promise<JsonChannelStore> {
    const store = new JsonChannelStore(path.resolve(file))
    await mkdir(path.dirname(store.#file), { recursive: true })
    try {
      const parsed: unknown = JSON.parse(await readFile(store.#file, 'utf8'))
      if (!isState(parsed)) throw new Error('Channel store has an unsupported contract or malformed root')
      store.#state = { ...parsed, lifecycleCursors: parsed.lifecycleCursors ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await store.#persist(store.#state)
    }
    return store
  }

  snapshot(): ChannelStoreState {
    return clone(this.#state)
  }

  async transaction<T>(mutate: (draft: ChannelStoreState) => T | Promise<T>): Promise<T> {
    let result!: T
    let failure: unknown
    const previous = this.#tail
    this.#tail = previous.then(async () => {
      const draft = clone(this.#state)
      try {
        result = await mutate(draft)
        const committed = { ...draft, revision: draft.revision + 1 }
        await this.#persist(committed)
        this.#state = committed
      } catch (error) {
        failure = error
      }
    })
    await this.#tail
    if (failure !== undefined) throw failure
    return result
  }

  async #persist(state: ChannelStoreState): Promise<void> {
    const directory = path.dirname(this.#file)
    const temporary = path.join(
      directory,
      `.${path.basename(this.#file)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, this.#file)
      await syncDirectory(directory)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
