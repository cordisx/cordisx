import { activeManagedConsoleSeat } from './managed-console-seats.js'
import type {
  ManagedServiceConsoleMountResultV1,
  ManagedServiceConsoleV1,
} from '@cordisx/protocol/managed-service-console/v1'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service-ui/v1'
import type { ManagedServiceUIBindingRequest } from '../launcher/managed-service-ui-rpc.js'

export interface ManagedConsoleDescriptor {
  readonly contract: 'cordisx.managed-service-console/v1'
  readonly serviceGeneration: string
}

export function createBrowserManagedServiceConsole(input: {
  readonly descriptor: ManagedConsoleDescriptor
  readonly binding: ManagedServiceBindingV1
  readonly owner: string
  readonly nextId: () => string
  readonly invoke: (request: ManagedServiceUIBindingRequest, timeoutMs?: number) => Promise<unknown>
}): ManagedServiceConsoleV1 {
  const { binding, descriptor, nextId, invoke } = input
  const { serviceGeneration } = descriptor
  return Object.freeze({
    contract: descriptor.contract,
    binding,
    serviceGeneration,
    async mount(
      target: HTMLElement,
      options?: { readonly signal?: AbortSignal },
    ): Promise<ManagedServiceConsoleMountResultV1> {
      const live = () => activeManagedConsoleSeat(target, input.owner)
      if (!live() || target.childElementCount) return { status: 'unavailable', reason: 'owner-unavailable' }
      if (options?.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' }
      const viewId = nextId()
      const send = (
        request: Extract<ManagedServiceUIBindingRequest, { operation: 'consoleView' }>['request'],
        timeout?: number,
      ) =>
        invoke({
          requestId: nextId(),
          operation: 'consoleView',
          serviceId: binding.identity.serviceId,
          binding,
          request,
        }, timeout)
      let retired = false
      let resolveClosed!: () => void
      const closed = new Promise<void>(resolve => {
        resolveClosed = resolve
      })
      const dispose = async () => {
        if (retired) return
        retired = true
        resolveClosed()
        resize?.disconnect()
        mutation?.disconnect()
        if (timer !== undefined) clearInterval(timer)
        if (scheduled !== undefined) cancelAnimationFrame(scheduled)
        window.removeEventListener('resize', schedule)
        window.removeEventListener('scroll', schedule, true)
        document.removeEventListener('visibilitychange', schedule)
        options?.signal?.removeEventListener('abort', abort)
        await send({ action: 'dispose', viewId, serviceGeneration }).catch(() => undefined)
      }
      const abort = () => {
        void dispose()
      }
      let pending = false
      let scheduled: number | undefined
      let timer: ReturnType<typeof setInterval> | undefined
      let resize: ResizeObserver | undefined
      let mutation: MutationObserver | undefined
      const update = async () => {
        if (retired || pending) return
        if (!live()) return dispose()
        const rect = target.getBoundingClientRect()
        const x = Math.ceil(rect.left)
        const y = Math.ceil(rect.top)
        const width = Math.floor(rect.right) - x
        const height = Math.floor(rect.bottom) - y
        const visible = document.visibilityState === 'visible'
          && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
          && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= innerWidth && y + height <= innerHeight
          && ([[x, y], [x + width - 1, y], [x, y + height - 1], [x + width - 1, y + height - 1]] as const).every(
            ([left, top]) => target.contains(document.elementFromPoint(left, top)),
          )
        pending = true
        try {
          const result = await send({
            action: 'update',
            viewId,
            serviceGeneration,
            bounds: visible ? { x, y, width, height } : null,
          })
          if ((result as { status?: unknown } | null)?.status !== 'active') await dispose()
        } catch {
          await dispose()
        } finally {
          pending = false
        }
      }
      const schedule = () => {
        if (retired || scheduled !== undefined) return
        scheduled = requestAnimationFrame(() => {
          scheduled = undefined
          void update()
        })
      }
      options?.signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await send({ action: 'mount', viewId, serviceGeneration }, 12_000) as {
          status?: string
          reason?: string
        }
        if (result.status !== 'mounted' || retired || !live()) {
          await dispose()
          const reason = result.reason === 'sign-in-required' || result.reason === 'unsupported'
              || result.reason === 'stale-generation'
            ? result.reason
            : retired && options?.signal?.aborted
            ? 'cancelled'
            : 'failed'
          return { status: 'unavailable', reason }
        }
        resize = new ResizeObserver(schedule)
        resize.observe(target)
        mutation = new MutationObserver(schedule)
        mutation.observe(document.body, { childList: true, attributes: true, subtree: true })
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        document.addEventListener('visibilitychange', schedule)
        timer = setInterval(schedule, 2000)
        schedule()
        return { status: 'mounted', closed, dispose }
      } catch {
        await dispose()
        return { status: 'unavailable', reason: 'failed' }
      }
    },
  })
}
