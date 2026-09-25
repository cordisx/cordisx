import type {
  CatalogManagementChannel,
  CatalogManagementCommand,
  CatalogManagementCursor,
  CatalogManagementResult,
  CatalogManagementSnapshot,
} from '../model-catalog-management.js'
import { catalogOperationAvailable } from '../model-catalog-management.js'
import { parseManagementSnapshot, safeManagementCode } from './model-catalog-projection.js'

export interface CatalogClientState extends CatalogManagementSnapshot {
  readonly connected: boolean
  readonly loading: boolean
}

/** Read-only Host projection. A failed transport never turns a retained view into authority. */
export class ModelCatalogClient {
  private state: CatalogClientState = { epoch: '', sequence: 0, views: [], connected: false, loading: false }
  private readonly listeners = new Set<() => void>()
  private disconnect?: () => void
  private reconcile?: ReturnType<typeof setInterval>
  private disposed = false
  private reading: Promise<void> | undefined
  private dirty = false
  private cursor?: CatalogManagementCursor

  constructor(private readonly channel: CatalogManagementChannel) {
    try {
      this.disconnect = channel.catalogManagementSubscribe(cursor => {
        this.cursor = cursor
        void this.refresh()
      })
      this.reconcile = setInterval(() => void this.refresh(), 30_000)
      this.reconcile.unref?.()
      void this.refresh()
    } catch {
      this.publish({ ...this.state, connected: false, loading: false })
    }
  }

  snapshot = (): CatalogClientState => this.state
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    this.dirty = true
    if (this.reading) return this.reading
    this.reading = this.readLoop().finally(() => {
      this.reading = undefined
    })
    return this.reading
  }

  private async readLoop(): Promise<void> {
    this.publish({ ...this.state, loading: true })
    while (this.dirty && !this.disposed) {
      this.dirty = false
      const cursorBeforeRead = this.cursor
      try {
        const snapshot = parseManagementSnapshot(await this.channel.catalogManagementRead())
        if (this.disposed) return
        if (
          this.cursor && (snapshot.epoch === this.cursor.epoch
            ? snapshot.sequence < this.cursor.sequence
            : cursorBeforeRead !== this.cursor)
        ) {
          // An event during a read schedules one more read; reconciliation repairs a stale transport.
          continue
        }
        if (snapshot.epoch === this.state.epoch && snapshot.sequence < this.state.sequence) continue
        this.cursor = { epoch: snapshot.epoch, sequence: snapshot.sequence }
        this.publish({ ...snapshot, connected: true, loading: false })
      } catch {
        this.publish({ ...this.state, connected: false, loading: false })
      }
    }
    if (this.state.loading) this.publish({ ...this.state, loading: false })
  }

  async command(command: CatalogManagementCommand): Promise<CatalogManagementResult> {
    if (this.disposed || !this.state.connected) return { status: 'unavailable', code: 'unavailable' }
    if (command.operation === 'createConnection') {
      if (!this.state.canCreateConnection) return { status: 'unavailable', code: 'unsupported' }
    } else {
      const view = this.state.views.find(item => item.bindingRef === command.bindingRef)
      if (!view || view.scopeRevision !== command.scopeRevision) return { status: 'conflict', code: 'scope-changed' }
      if (view.revision !== command.expectedRevision) return { status: 'conflict', code: 'conflict' }
      if (!catalogOperationAvailable(view, command.operation)) return { status: 'unavailable', code: 'unsupported' }
    }
    try {
      const result = await this.channel.catalogManagementCommand(command)
      if (this.disposed) return { status: 'unavailable', code: 'unavailable' }
      // Always read back from Host, including rejected/conflicting writes. Never optimistically mutate rows.
      await this.refresh()
      if (!['applied', 'queued', 'conflict', 'unavailable', 'rejected'].includes(result.status)) {
        return { status: 'rejected', code: 'protocol' }
      }
      return {
        status: result.status,
        ...(safeManagementCode(result.code) ? { code: result.code } : {}),
        ...(Number.isFinite(result.retryAt) ? { retryAt: result.retryAt } : {}),
      }
    } catch {
      await this.refresh()
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  dispose(): void {
    this.disposed = true
    this.disconnect?.()
    if (this.reconcile) clearInterval(this.reconcile)
    this.listeners.clear()
  }

  private publish(state: CatalogClientState): void {
    if (this.disposed) return
    this.state = Object.freeze(state)
    for (const listener of this.listeners) listener()
  }
}
