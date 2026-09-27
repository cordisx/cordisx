import type {
  CatalogManagementChannel,
  CatalogManagementCommand,
  CatalogManagementCursor,
  CatalogManagementResult,
  CatalogManagementSnapshot,
} from '../model-catalog-management.js'
import { catalogOperationAvailable } from '../model-catalog-management.js'
import type {
  CatalogEnvironmentGeneratorCancelResult,
  CatalogEnvironmentGeneratorRunRequest,
  CatalogEnvironmentGeneratorRunResult,
  CatalogEnvironmentReadResult,
  CatalogEnvironmentSaveResult,
  CatalogTransferEnvironmentVariable,
  CatalogTransferExportPreparationResult,
  CatalogTransferExportRequest,
  CatalogTransferExportResult,
  CatalogTransferImportPreparationResult,
  CatalogTransferImportRequest,
  CatalogTransferImportResult,
} from '../model-catalog-transfer.js'
import { parseManagementSnapshot, safeManagementCode } from './model-catalog-projection.js'

export interface CatalogClientState extends CatalogManagementSnapshot {
  readonly connected: boolean
  /** Initial/invalidated read; background read progress is separate. */
  readonly loading: boolean
  readonly refreshing?: boolean
}

/** Read-only Host projection. A failed transport never turns a retained view into authority. */
export class ModelCatalogClient {
  private state: CatalogClientState = {
    epoch: '',
    sequence: 0,
    views: [],
    connected: false,
    loading: false,
    refreshing: false,
  }
  private readonly listeners = new Set<() => void>()
  private disconnect?: () => void
  private reconcile?: ReturnType<typeof setInterval>
  private disposed = false
  private reading: Promise<void> | undefined
  private dirty = false
  private cursor?: CatalogManagementCursor
  private invalidatedEpoch: string | undefined

  constructor(private readonly channel: CatalogManagementChannel) {
    try {
      this.disconnect = channel.catalogManagementSubscribe(cursor => {
        if (this.state.epoch && cursor.epoch !== this.state.epoch) {
          this.invalidatedEpoch = cursor.epoch
          // A new Host epoch invalidates prior authority immediately, before readback.
          this.publish({ ...this.state, connected: false, loading: true, refreshing: true })
        }
        this.cursor = cursor
        void this.refresh()
      })
      this.reconcile = setInterval(() => void this.refresh(), 30_000)
      this.reconcile.unref?.()
      void this.refresh()
    } catch {
      this.publish({ ...this.state, connected: false, loading: false, refreshing: false })
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
    while (this.dirty && !this.disposed) {
      this.publish({ ...this.state, loading: !this.state.connected, refreshing: true })
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
        if (this.invalidatedEpoch && snapshot.epoch !== this.invalidatedEpoch) continue
        if (snapshot.epoch === this.state.epoch && snapshot.sequence < this.state.sequence) continue
        this.invalidatedEpoch = undefined
        this.cursor = { epoch: snapshot.epoch, sequence: snapshot.sequence }
        this.publish({ ...snapshot, connected: true, loading: false, refreshing: false })
      } catch {
        this.publish({ ...this.state, connected: false, loading: false, refreshing: false })
      }
    }
    if (this.state.loading || this.state.refreshing) this.publish({ ...this.state, loading: false, refreshing: false })
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

  async export(request: CatalogTransferExportRequest): Promise<CatalogTransferExportResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogManagementExport) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      return await this.channel.catalogManagementExport(request)
    } catch {
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  async environmentRead(): Promise<CatalogEnvironmentReadResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogEnvironmentRead) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      return await this.channel.catalogEnvironmentRead()
    } catch {
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  async environmentSave(
    entries: readonly CatalogTransferEnvironmentVariable[],
  ): Promise<CatalogEnvironmentSaveResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogEnvironmentSave) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      const result = await this.channel.catalogEnvironmentSave(entries)
      await this.refresh()
      return result
    } catch {
      await this.refresh()
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  async environmentGenerate(
    request: CatalogEnvironmentGeneratorRunRequest,
  ): Promise<CatalogEnvironmentGeneratorRunResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogEnvironmentGenerate) {
      return { status: 'rejected', runId: request.runId, code: 'unavailable' }
    }
    try {
      return await this.channel.catalogEnvironmentGenerate(request)
    } catch {
      return { status: 'rejected', runId: request.runId, code: 'unavailable' }
    }
  }

  async environmentGenerateCancel(runId: string): Promise<CatalogEnvironmentGeneratorCancelResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogEnvironmentGenerateCancel) {
      return { status: 'rejected', runId, code: 'unavailable' }
    }
    try {
      return await this.channel.catalogEnvironmentGenerateCancel(runId)
    } catch {
      return { status: 'rejected', runId, code: 'unavailable' }
    }
  }

  async prepareExport(request: CatalogTransferExportRequest): Promise<CatalogTransferExportPreparationResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogManagementPrepareExport) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      return await this.channel.catalogManagementPrepareExport(request)
    } catch {
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  async prepareImport(text: string): Promise<CatalogTransferImportPreparationResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogManagementPrepareImport) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      return await this.channel.catalogManagementPrepareImport(text)
    } catch {
      return { status: 'rejected', code: 'unavailable' }
    }
  }

  async import(request: CatalogTransferImportRequest): Promise<CatalogTransferImportResult> {
    if (this.disposed || !this.state.connected || !this.channel.catalogManagementImport) {
      return { status: 'rejected', code: 'unavailable' }
    }
    try {
      const result = await this.channel.catalogManagementImport(request)
      await this.refresh()
      return result
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
