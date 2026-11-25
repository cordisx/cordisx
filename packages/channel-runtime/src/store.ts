import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { validateOutboundMedia } from './outbound-media.js'
import { validateOutboundContent, validateOutboundFallback } from './outbound-content.js'
import type {
  ChannelAdapterDescriptor,
  ChannelInboundEnvelope,
  ChannelInboxStatus,
  ChannelOutboundDelivery,
  ChannelOutboxStatus,
  ChannelPermissionDecision,
  ChannelPluginIdentity,
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
  readonly errorCode?: string
  readonly updatedAt: string
}

export interface StoredOutboxRecord extends ChannelOutboundDelivery {
  /** Host-only terminal fence: once claimed, an uncertain effect is never re-dispatched. */
  readonly terminalDelivery?: true
  /** Launcher-owned volatile guard must be live; process restart never sends an old reminder. */
  readonly guardedDelivery?: boolean
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
  readonly eventKey?: string
}

export interface ChannelStoreState {
  contract: 'cordisx.channel-store/v1'
  schemaVersion: 1 | 2
  revision: number
  adapters: Record<string, StoredAdapterState>
  inbox: Record<string, StoredInboxRecord>
  outbox: Record<string, StoredOutboxRecord>
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
    && (state.schemaVersion === 1 || state.schemaVersion === 2)
    && Number.isInteger(state.revision)
    && state.adapters !== null && typeof state.adapters === 'object'
    && state.inbox !== null && typeof state.inbox === 'object'
    && state.outbox !== null && typeof state.outbox === 'object'
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
      const terminal = Object.values(parsed.outbox).filter(record => record.terminalDelivery !== undefined)
      if (
        terminal.some(record => record.terminalDelivery !== true)
        || (terminal.length > 0) !== (parsed.schemaVersion === 2)
      ) {
        throw new Error('Channel store has an unsupported terminal delivery fence')
      }
      for (const record of Object.values(parsed.outbox)) {
        if (record.content !== undefined) {
          const content = validateOutboundContent(record.content)
          const fallback = validateOutboundFallback(record.fallback)
          if (
            record.requestedType !== content.type || record.questionCard !== undefined
            || (record.effectiveType !== content.type && !(record.effectiveType === 'text' && fallback.mode === 'text'))
            || (record.effectiveType === 'text' && record.media !== undefined)
            || (record.effectiveType !== 'text' && record.text !== '')
            || ('handle' in content && record.effectiveType !== 'text'
              && (!record.media || record.media.handle !== content.handle || record.media.type !== content.type))
          ) throw new Error('Invalid stored typed delivery')
        }
        if (record.media !== undefined) {
          validateOutboundMedia(record.media)
          if (record.text !== '' || record.questionCard !== undefined) throw new Error('Invalid stored media delivery')
        }
      }
      // The v1 connection store intentionally discards historical task-routing
      // fields on open. Channel owns transport durability only.
      store.#state = {
        contract: parsed.contract,
        schemaVersion: parsed.schemaVersion,
        revision: parsed.revision,
        adapters: parsed.adapters,
        inbox: parsed.inbox,
        outbox: parsed.outbox,
        audit: parsed.audit,
      }
      // An interrupted external effect is ambiguous; never reclaim it after restart.
      let recovered = false
      for (const record of Object.values(store.#state.outbox)) {
        if (
          record.terminalDelivery && (['processing', 'retrying'].includes(record.status)
            || record.status === 'queued' && record.attempts > 0)
        ) {
          store.#state.outbox[record.deliveryId] = {
            ...record,
            status: 'unknown',
            errorCode: 'TERMINAL_EFFECT_UNCERTAIN',
            updatedAt: new Date().toISOString(),
          }
          recovered = true
        }
      }
      if (recovered) {
        store.#state.revision += 1
        await store.#persist(store.#state)
      }
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
        draft.schemaVersion = Object.values(draft.outbox).some(record => record.terminalDelivery) ? 2 : 1
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
