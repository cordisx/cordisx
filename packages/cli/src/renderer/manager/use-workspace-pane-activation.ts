import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { nativeRouteIdentity, type NativeRouteSource } from './native-route-transition.js'

interface WorkspacePaneActivationOptions {
  readonly document: Document
  readonly route?: NativeRouteSource
  readonly activatePane?: () => boolean
  readonly titlebarSeat?: HTMLElement
  readonly onOpened: () => void
  readonly onUnavailable: () => void
}

/** Wait briefly for Codex's native destination layout to settle after a rail click. */
export function useWorkspacePaneActivation(options: WorkspacePaneActivationOptions): {
  open(): void
  cancel(): void
  pending(): boolean
} {
  const revision = useRef(0)
  const pending = useRef(false)
  useLayoutEffect(() => () => {
    ++revision.current
    pending.current = false
  }, [])
  const cancel = () => {
    ++revision.current
    pending.current = false
  }
  const open = () => {
    if (pending.current) return
    const rails = options.document.querySelectorAll('nav[data-app-navigation-rail="true"]')
    const rail = rails.length === 1 ? rails[0] : undefined
    const initialCurrent = rail?.querySelectorAll<HTMLButtonElement>(
      'button[data-sidebar-destination][aria-current="page"]',
    )
    const initialMarked = rail?.querySelectorAll<HTMLButtonElement>(
      'button[data-sidebar-destination][data-selected]',
    )
    if (initialCurrent?.length !== 1 || initialMarked?.length !== 1 || initialCurrent[0] !== initialMarked[0]) {
      options.onUnavailable()
      return
    }
    const expectedDestination = initialCurrent[0]?.getAttribute('data-sidebar-destination')
    if (expectedDestination === null || expectedDestination === undefined) {
      options.onUnavailable()
      return
    }
    pending.current = true
    const currentRevision = ++revision.current
    const attempt = (): 'opened' | 'wait' | 'cancelled' => {
      if (currentRevision !== revision.current) return 'cancelled'
      const currentRails = options.document.querySelectorAll('nav[data-app-navigation-rail="true"]')
      const currentRail = currentRails.length === 1 ? currentRails[0] : undefined
      if (currentRail === undefined || !currentRail.isConnected) return 'wait'
      const current = currentRail.querySelectorAll<HTMLButtonElement>(
        'button[data-sidebar-destination][aria-current="page"]',
      )
      const marked = currentRail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
      if (current?.length !== 1 || marked?.length !== 1 || current[0] !== marked[0]) return 'wait'
      const destination = current[0]?.getAttribute('data-sidebar-destination') ?? undefined
      if (destination !== expectedDestination) return 'cancelled'
      if (options.route !== undefined && nativeRouteIdentity(options.route.snapshot()) === undefined) return 'wait'
      if (options.titlebarSeat === undefined || !options.activatePane?.()) return 'wait'
      flushSync(options.onOpened)
      return 'opened'
    }
    const initial = attempt()
    if (initial !== 'wait') {
      pending.current = false
      return
    }
    void (async () => {
      const deadline = Date.now() + 7_000
      while (Date.now() < deadline && currentRevision === revision.current) {
        await new Promise(resolve => setTimeout(resolve, 50))
        const result = attempt()
        if (result !== 'wait') {
          if (currentRevision === revision.current) pending.current = false
          return
        }
      }
      if (currentRevision === revision.current) {
        pending.current = false
        options.onUnavailable()
      }
    })()
  }
  return { open, cancel, pending: () => pending.current }
}
