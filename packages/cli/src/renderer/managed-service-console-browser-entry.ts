import type { ManagedServiceConsoleBrowserEntryResultV1 } from '@cordisx/protocol/managed-service-console/v1'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service-ui/v1'
import { managedServiceUIBindingEqual } from '../launcher/managed-service-ui-binding.js'
import type { ManagedServiceUIBindingRequest } from '../launcher/managed-service-ui-rpc.js'
import { activeManagedConsolePage } from './managed-console-seats.js'

type BrowserRequest = Extract<ManagedServiceUIBindingRequest, { operation: 'consoleBrowser' }>['request']

export function createManagedConsoleBrowserEntry(input: {
  readonly owner: string
  readonly binding: ManagedServiceBindingV1
  readonly serviceGeneration: string
  readonly nextId: () => string
  readonly invoke: (request: ManagedServiceUIBindingRequest, timeoutMs?: number) => Promise<unknown>
}) {
  const { owner, binding, serviceGeneration, nextId, invoke } = input
  let previous: (() => void) | undefined
  return async (options?: { readonly signal?: AbortSignal }): Promise<ManagedServiceConsoleBrowserEntryResultV1> => {
    const page = activeManagedConsolePage(owner)
    if (!page) return { status: 'unavailable', reason: 'owner-unavailable' }
    if (options?.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' }
    previous?.()
    const viewId = nextId()
    const send = (action: BrowserRequest['action']) =>
      invoke({
        requestId: nextId(),
        operation: 'consoleBrowser',
        serviceId: binding.identity.serviceId,
        binding,
        request: { action, viewId, serviceGeneration },
      }, 12_000)
    const signal = options?.signal ? AbortSignal.any([page.signal, options.signal]) : page.signal
    let retired = false
    const retire = () => {
      if (retired) return
      retired = true
      signal.removeEventListener('abort', retire)
      if (previous === retire) previous = undefined
      void send('retire').catch(() => undefined)
    }
    previous = retire
    signal.addEventListener('abort', retire, { once: true })
    try {
      const result = await send('issue') as ManagedServiceConsoleBrowserEntryResultV1
      if (retired || signal.aborted || activeManagedConsolePage(owner) !== page) {
        retire()
        return { status: 'unavailable', reason: 'cancelled' }
      }
      if (result.status === 'unavailable') {
        retire()
        return result
      }
      if (result.serviceGeneration !== serviceGeneration || !managedServiceUIBindingEqual(result.binding, binding)) {
        retire()
        return { status: 'unavailable', reason: 'stale-generation' }
      }
      const destination = new URL(result.url)
      if (
        destination.origin !== result.origin || destination.username || destination.password || destination.hash
        || [...destination.searchParams.keys()].join(',') !== 'ticket'
        || !/^[A-Za-z0-9_-]{32}$/u.test(destination.searchParams.get('ticket') ?? '')
      ) throw new Error('Invalid managed console browser entry')
      return result
    } catch {
      retire()
      return { status: 'unavailable', reason: signal.aborted ? 'cancelled' : 'failed' }
    }
  }
}
