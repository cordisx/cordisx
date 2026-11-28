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

/** A browser route is leased to one current view per service and renderer document. */
export class ManagedServiceBrowserConsoleRPC {
  private readonly owners = new Map<string, Map<string, Map<AbortSignal | symbol, BrowserView>>>()
  private readonly noDocument = Symbol('no-document')

  constructor(private readonly boundary: () => ManagedBrowserConsoleBoundary | undefined) {}

  async handle(
    owner: string,
    reader: ManagedServiceWebEntryReader | undefined,
    binding: ManagedServiceBindingV1,
    request: ManagedBrowserConsoleRequest,
    documentSignal?: AbortSignal,
  ): Promise<ManagedServiceConsoleBrowserEntryResultV1> {
    const service = binding.identity.serviceId
    const document = documentSignal ?? this.noDocument
    let services = this.owners.get(owner)
    let views = services?.get(service)
    const previous = views?.get(document)
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
    services = this.owners.get(owner)
    if (!services) this.owners.set(owner, services = new Map())
    views = services.get(service)
    if (!views) services.set(service, views = new Map())
    if (views.size >= 16) return unavailable('unsupported')
    const view: BrowserView = {
      controller: new AbortController(),
      reader,
      generation: request.serviceGeneration,
      id: request.viewId,
      ...(documentSignal === undefined ? {} : { documentSignal }),
    }
    views.set(document, view)
    if (documentSignal) {
      const abort = () => this.retire(owner, service, view)
      documentSignal.addEventListener('abort', abort, { once: true })
      view.stopDocumentLifetime = () => documentSignal.removeEventListener('abort', abort)
    }
    let accepted = false
    try {
      const prepared = await reader.browserConsole.read(view.generation, view.controller.signal, boundary)
      if (prepared.status === 'available') view.route = prepared.route
      if (view.controller.signal.aborted || this.owners.get(owner)?.get(service)?.get(document) !== view) {
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
    const services = this.owners.get(owner)
    const views = services?.get(service)
    const document = view.documentSignal ?? this.noDocument
    if (views?.get(document) === view) {
      views.delete(document)
      if (!views.size) services?.delete(service)
      if (!services?.size) this.owners.delete(owner)
    }
    view.stopDocumentLifetime?.()
    view.controller.abort()
    view.route?.dispose()
  }

  disposeOwner(owner: string) {
    const services = this.owners.get(owner)
    if (services) {
      for (const [service, views] of services) for (const view of views.values()) this.retire(owner, service, view)
    }
  }

  dispose() {
    for (const owner of this.owners.keys()) this.disposeOwner(owner)
  }
}
