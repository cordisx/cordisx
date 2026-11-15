import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ChannelManagerFormMountResultV1, ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import { managedConsoleSeatFor } from './managed-console-seats.js'

/** Shares the Host's actual Manager body registration; DOM attributes never establish ownership. */
export function mountChannelHostForm(input: {
  readonly target: HTMLElement
  readonly owner: string
  readonly lifetime: AbortSignal
  readonly options: ChannelManagerFormOptionsV1
  readonly live: () => boolean
  readonly render: (signal: AbortSignal) => ReactNode
}): ChannelManagerFormMountResultV1 {
  const seat = managedConsoleSeatFor(input.target, input.owner)
  if (!seat || input.target.childNodes.length || !input.live()) {
    return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
  }
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, input.lifetime, input.options.signal, seat.signal])
  if (signal.aborted) return { status: 'unavailable', code: 'CANCELLED' }
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })
  const container = input.target.ownerDocument.createElement('div')
  container.className = 'cxr-channel-owned-form'
  input.target.append(container)
  const root = createRoot(container)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    signal.removeEventListener('abort', dispose)
    observer.disconnect()
    lifetime.abort()
    // Parent React pages can abort from their own cleanup. Finish the child
    // root outside that commit, with the lifetime already fenced immediately.
    queueMicrotask(() => {
      try {
        root.unmount()
      } finally {
        container.remove()
        resolveClosed()
      }
    })
  }
  const observer = new MutationObserver(() => {
    if (
      !input.live() || managedConsoleSeatFor(input.target, input.owner) !== seat || !input.target.contains(container)
    ) dispose()
  })
  observer.observe(input.target.ownerDocument.body, { childList: true, subtree: true })
  signal.addEventListener('abort', dispose, { once: true })
  try {
    flushSync(() => root.render(input.render(signal)))
  } catch {
    dispose()
    return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
  }
  return { status: 'mounted', closed, dispose }
}
