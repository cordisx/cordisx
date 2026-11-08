import type {
  ManagedServiceConsoleBrowserEntryResultV1,
  ManagedServiceConsoleUnavailableV1,
} from '@cordisx/protocol/managed-service-console/v1'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'
import type {
  ManagedBrowserConsoleBoundary,
  ManagedBrowserConsoleRoute,
} from './managed-service-browser-console-broker.js'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'

export interface ManagedBrowserConsoleRequest {
  readonly action: 'issue' | 'retire'
  readonly viewId: string
  readonly serviceGeneration: string
}

interface BrowserView {
  readonly controller: AbortController
  readonly reader: ManagedServiceWebEntryReader
  readonly generation: string
  readonly id: string
  readonly documentSignal?: AbortSignal
  stopDocumentLifetime?: () => void
  route?: ManagedBrowserConsoleRoute
}

const unavailable = (reason: ManagedServiceConsoleUnavailableV1['reason']): ManagedServiceConsoleUnavailableV1 => ({
  status: 'unavailable',
  reason,
})

/** A browser route is leased to one current view per service for an admitted plugin owner. */
export class ManagedServiceBrowserConsoleRPC {
  private readonly owners = new Map<string, Map<string, BrowserView>>()

  constructor(private readonly boundary: () => ManagedBrowserConsoleBoundary | undefined) {}

  async handle(
    owner: string,
    reader: ManagedServiceWebEntryReader | undefined,
    binding: ManagedServiceBindingV1,
    request: ManagedBrowserConsoleRequest,
    documentSignal?: AbortSignal,
  ): Promise<ManagedServiceConsoleBrowserEntryResultV1> {
    const service = binding.identity.serviceId
    let views = this.owners.get(owner)
    const previous = views?.get(service)
    if (request.action === 'retire') {
      if (
        previous?.id === request.viewId && previous.generation === request.serviceGeneration
        && previous.documentSignal === documentSignal
      ) {
        this.retire(owner, service, previous)
      }
      return unavailable('cancelled')
    }
    if (documentSignal?.aborted) return unavailable('cancelled')
    if (!reader || reader.serviceGeneration !== request.serviceGeneration) return unavailable('stale-generation')
    const boundary = this.boundary()
    if (!reader.browserConsole || !boundary) return unavailable('unsupported')
    if (previous) this.retire(owner, service, previous)
    views = this.owners.get(owner)
    if (!views) this.owners.set(owner, views = new Map())
    const view: BrowserView = {
      controller: new AbortController(),
      reader,
      generation: request.serviceGeneration,
      id: request.viewId,
      ...(documentSignal === undefined ? {} : { documentSignal }),
    }
    views.set(service, view)
    if (documentSignal) {
      const abort = () => this.retire(owner, service, view)
      documentSignal.addEventListener('abort', abort, { once: true })
      view.stopDocumentLifetime = () => documentSignal.removeEventListener('abort', abort)
    }
    let accepted = false
    try {
      const prepared = await reader.browserConsole.read(view.generation, view.controller.signal, boundary)
      if (prepared.status === 'available') view.route = prepared.route
      if (view.controller.signal.aborted || this.owners.get(owner)?.get(service) !== view) {
        return unavailable('cancelled')
      }
      if (view.reader.serviceGeneration !== view.generation) return unavailable('stale-generation')
      if (prepared.status !== 'available') return prepared
      accepted = true
      return {
        status: 'available',
        binding,
        serviceGeneration: view.generation,
        origin: prepared.route.origin,
        url: prepared.url,
      }
    } catch {
      return unavailable(view.controller.signal.aborted ? 'cancelled' : 'failed')
    } finally {
      if (!accepted) this.retire(owner, service, view)
    }
  }

  private retire(owner: string, service: string, view: BrowserView) {
    const views = this.owners.get(owner)
    if (views?.get(service) === view) {
      views.delete(service)
      if (!views.size) this.owners.delete(owner)
    }
    view.stopDocumentLifetime?.()
    view.controller.abort()
    view.route?.dispose()
  }

  disposeOwner(owner: string) {
    const views = this.owners.get(owner)
    if (views) { for (const [service, view] of views) this.retire(owner, service, view) }
  }

  dispose() {
    for (const owner of this.owners.keys()) this.disposeOwner(owner)
  }
}
