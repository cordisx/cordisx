import type {
  ManagedConsoleBounds,
  NativeManagedConsoleAdapter,
  NativeManagedConsoleView,
} from '../shortcuts/managed-console-agent.js'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'

export type ManagedConsoleViewRequest =
  & {
    readonly viewId: string
    readonly serviceGeneration: string
  }
  & (
    | { readonly action: 'mount' | 'dispose' }
    | { readonly action: 'update'; readonly bounds: ManagedConsoleBounds | null }
  )

interface ConsoleView {
  readonly controller: AbortController
  readonly reader: ManagedServiceWebEntryReader
  readonly generation: string
  native?: NativeManagedConsoleView
  revoke?: () => Promise<void>
}

export class ManagedServiceConsoleRPC {
  private readonly views = new Map<string, Map<string, ConsoleView>>()

  constructor(private readonly adapter: () => NativeManagedConsoleAdapter | undefined) {}

  async handle(owner: string, reader: ManagedServiceWebEntryReader | undefined, request: ManagedConsoleViewRequest) {
    let views = this.views.get(owner)
    if (request.action === 'dispose') {
      const view = views?.get(request.viewId)
      if (view && view.reader === reader && view.generation === request.serviceGeneration) await this.retire(view)
      return { status: 'closed' }
    }
    if (!reader || reader.serviceGeneration !== request.serviceGeneration) {
      return { status: 'unavailable', reason: 'stale-generation' }
    }
    if (request.action === 'update') {
      const view = views?.get(request.viewId)
      if (
        !view?.native || view.reader !== reader || view.generation !== request.serviceGeneration
        || view.controller.signal.aborted
      ) {
        return { status: 'closed' }
      }
      view.native.setBounds(request.bounds ?? undefined)
      return { status: 'active' }
    }
    const adapter = this.adapter()
    if (!adapter || !reader.authenticatedConsole) return { status: 'unavailable', reason: 'unsupported' }
    if (views?.size) return { status: 'unavailable', reason: 'failed' }
    if (!views) this.views.set(owner, views = new Map())
    const controller = new AbortController()
    const view: ConsoleView = { controller, reader, generation: request.serviceGeneration }
    views.set(request.viewId, view)
    const forget = () => {
      if (views.get(request.viewId) === view) views.delete(request.viewId)
      if (!views.size && this.views.get(owner) === views) this.views.delete(owner)
    }
    try {
      const prepared = await reader.authenticatedConsole.prepare(request.serviceGeneration, controller.signal)
      if (prepared.status !== 'prepared') {
        forget()
        return { status: 'unavailable', reason: prepared.status === 'sign-in-required' ? 'sign-in-required' : 'failed' }
      }
      view.revoke = prepared.revoke
      const signal = AbortSignal.any([controller.signal, prepared.lifetime])
      signal.throwIfAborted()
      view.native = await adapter.open(prepared, signal)
      signal.throwIfAborted()
      void view.native.closed.then(async () => {
        forget()
        await this.retire(view)
      }).catch(() => undefined)
      return { status: 'mounted' }
    } catch {
      forget()
      await this.retire(view)
      return { status: 'unavailable', reason: controller.signal.aborted ? 'cancelled' : 'failed' }
    }
  }

  private async retire(view: ConsoleView) {
    view.controller.abort()
    view.native?.close()
    await view.revoke?.()
  }

  async disposeOwner(owner: string) {
    const views = this.views.get(owner)
    this.views.delete(owner)
    if (views) await Promise.allSettled([...views.values()].map(view => this.retire(view)))
  }

  async dispose() {
    await Promise.allSettled([...this.views.keys()].map(owner => this.disposeOwner(owner)))
  }
}
