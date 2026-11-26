import type { ManagedServiceClientReservation } from './managed-service-client-reservation.js'
import type { ModelApiConnection } from './model-api-server.js'

/** Track model API connections without exposing their credentials to the lifecycle coordinator. */
export class ModelApiLifecycleClients {
  private readonly active = new Set<{ readonly pluginId: string; readonly dispose: () => void }>()
  private pending = 0
  private reservation: symbol | undefined
  private fenced = false
  private closed = false

  async open(
    signal: AbortSignal,
    connect: () => Promise<{ readonly connection: ModelApiConnection; readonly pluginId?: string }>,
  ): Promise<ModelApiConnection> {
    if (this.closed || this.fenced || this.reservation !== undefined) {
      throw new Error('Model API is coordinating a plugin operation')
    }
    signal.throwIfAborted()
    this.pending++
    try {
      const { connection, pluginId } = await connect()
      if (this.closed || this.fenced || this.reservation !== undefined || signal.aborted) {
        connection.dispose()
        signal.throwIfAborted()
        throw new Error('Model API is coordinating a plugin operation')
      }
      if (pluginId === undefined) return connection
      if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(pluginId)) {
        connection.dispose()
        throw new Error('Model API connection owner is unavailable')
      }
      let disposed = false
      const entry: { readonly pluginId: string; readonly dispose: () => void } = {
        pluginId,
        dispose: () => {
          if (disposed) return
          disposed = true
          this.active.delete(entry)
          connection.dispose()
        },
      }
      this.active.add(entry)
      return { ...connection, dispose: entry.dispose }
    } finally {
      this.pending--
    }
  }

  /** No affected request may be active or still resolving when a change begins. */
  reserveForLifecycle(pluginIds: readonly string[]): ManagedServiceClientReservation | undefined {
    if (
      !Array.isArray(pluginIds) || pluginIds.length === 0 || pluginIds.length > 4_096
      || pluginIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(id))
      || this.closed || this.fenced || this.reservation !== undefined || this.pending !== 0
    ) return undefined
    const affected = new Set(pluginIds)
    if ([...this.active].some(connection => affected.has(connection.pluginId))) return undefined
    const token = Symbol('model-api-lifecycle-reservation')
    this.reservation = token
    let ended = false
    const current = () => !ended && !this.closed && !this.fenced && this.reservation === token
    return {
      isCurrent: current,
      release: () => {
        if (!current()) return false
        ended = true
        this.reservation = undefined
        return true
      },
      fence: () => {
        if (ended) return
        ended = true
        if (this.reservation === token) {
          this.reservation = undefined
          this.fenced = true
        }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    let failure: unknown
    for (const connection of [...this.active]) {
      try {
        connection.dispose()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}
