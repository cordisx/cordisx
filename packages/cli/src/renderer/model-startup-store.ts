import type { StartupObserverV1, StartupProjectionV1, StartupSnapshotV1 } from '@cordisx/protocol/startup/v1'

/** UI cache only. The observer's full snapshot is the sole state authority. */
export interface ModelStartupState {
  readonly snapshot?: StartupSnapshotV1
  readonly connection: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'closed'
}

export class ModelStartupStore {
  private state: ModelStartupState = { connection: 'connecting' }
  private readonly listeners = new Set<() => void>()
  private controller?: AbortController
  private binding = 0
  snapshot = (): ModelStartupState => this.state
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connect(observer: StartupObserverV1): void {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const binding = ++this.binding
    this.publish({ connection: 'connecting' })
    void observer.subscribe(event => {
      if (controller.signal.aborted || binding !== this.binding) return
      if (event.kind === 'connection') {
        this.publish({ ...this.state, connection: event.connection.state })
      } else if (event.kind === 'closed') {
        this.publish({ ...this.state, connection: 'closed' })
        controller.abort()
      } else {
        const previous = this.state.snapshot?.cursor
        const next = event.snapshot.cursor
        if (
          previous && event.reason === 'update'
          && (previous.scopeId !== next.scopeId || previous.hostGeneration !== next.hostGeneration
            || previous.epoch !== next.epoch)
        ) return
        if (
          previous && event.reason === 'update' && previous.scopeId === next.scopeId
          && previous.hostGeneration === next.hostGeneration
          && previous.epoch === next.epoch && next.sequence < previous.sequence
        ) return
        // Initial, gap and generation resets replace the complete projection, never merge entries.
        this.publish({ snapshot: event.snapshot, connection: 'connected' })
      }
    }, { signal: controller.signal }).then(subscription => {
      if (controller.signal.aborted) subscription.close()
      else controller.signal.addEventListener('abort', () => subscription.close(), { once: true })
    }).catch(() => {
      if (!controller.signal.aborted && binding === this.binding) {
        this.publish({ ...this.state, connection: 'disconnected' })
      }
    })
  }

  dispose(): void {
    this.binding++
    this.controller?.abort()
    this.listeners.clear()
  }

  private publish(state: ModelStartupState): void {
    this.state = Object.freeze(state)
    for (const listener of this.listeners) listener()
  }
}

export function providerStartup(
  state: ModelStartupState | undefined,
  providerId: string,
): StartupProjectionV1 | undefined {
  const entries = state?.snapshot?.entries.filter(entry => entry.identity.providerId === providerId) ?? []
  // Ambiguous identities are not usable authority.
  return entries.length === 1 ? entries[0] : undefined
}

export function startupExecutionAvailable(state: ModelStartupState | undefined, entry: StartupProjectionV1): boolean {
  return state?.connection === 'connected' && entry.actions.execute.available
}

/** Explicit page/action declarations only; contribution labels do not establish ownership. */
export function startupPageActionAvailable(
  state: ModelStartupState | undefined,
  ownerKey: string,
  actionId: string,
): boolean {
  if (!state) return true
  if (!state.snapshot) return false
  const pluginId: unknown = JSON.parse(ownerKey)[0]
  const actions = state.snapshot?.pages.filter(page => page.pluginId === pluginId)
    .flatMap(page => page.actions.filter(action => action.actionId === actionId)) ?? []
  if (actions.length === 0) return true
  return state.connection === 'connected' && actions.every(action => action.availability.available)
}
