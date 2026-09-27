import { resolveManagerRailSeat } from '../host-probes.js'
import { readNativeRailSelection } from '../adapter/native-rail-selection-probe.js'
import { nativeRouteIdentity, type NativeRouteSource } from './native-route-transition.js'

interface CapturedSelection {
  readonly rail: HTMLElement
  readonly button: HTMLButtonElement
  readonly current: string
  readonly marked: string
  readonly routeIdentity: string | undefined
  clicked: HTMLButtonElement | undefined
}

/** Host-owned workspace rail projection; it does not register a Codex destination or route. */
export class WorkspaceRailProjection {
  private captured: CapturedSelection | undefined
  private dirty = false

  constructor(private readonly document: Document, private readonly route?: NativeRouteSource) {}

  enter(): boolean {
    if (this.captured !== undefined || this.dirty) return false
    const rail = resolveManagerRailSeat(this.document)?.homeButton.closest<HTMLElement>(
      'nav[data-app-navigation-rail="true"]',
    )
    if (rail === null || rail === undefined) return false
    const current = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][aria-current="page"]')
    const marked = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
    const button = current[0]
    if (current.length !== 1 || marked.length !== 1 || button === undefined || button !== marked[0]) return false
    const routeIdentity = this.route === undefined ? undefined : nativeRouteIdentity(this.route.snapshot())
    if (this.route !== undefined && routeIdentity === undefined) return false
    this.captured = {
      rail,
      button,
      current: button.getAttribute('aria-current')!,
      marked: button.getAttribute('data-selected')!,
      routeIdentity,
      clicked: undefined,
    }
    this.document.addEventListener('click', this.onNativeClick, true)
    button.removeAttribute('aria-current')
    button.removeAttribute('data-selected')
    if (
      rail.querySelector('[data-sidebar-destination][aria-current="page"]') !== null
      || rail.querySelector('[data-sidebar-destination][data-selected]') !== null
    ) {
      this.leave()
      return false
    }
    return true
  }

  leave(): boolean {
    const captured = this.captured
    if (captured === undefined) return true
    this.captured = undefined
    this.document.removeEventListener('click', this.onNativeClick, true)
    const { rail, button } = captured
    if (!rail.isConnected || !button.isConnected || !rail.contains(button)) return this.fail()
    const current = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][aria-current="page"]')
    const marked = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
    if (current.length === 0 && marked.length === 0) {
      const routeIdentity = this.route === undefined ? undefined : nativeRouteIdentity(this.route.snapshot())
      const nativeSelected = readNativeRailSelection(rail)
      if (nativeSelected !== undefined && nativeSelected !== button) return this.fail()
      if (routeIdentity !== captured.routeIdentity && nativeSelected !== button) {
        return this.fail()
      }
      button.setAttribute('aria-current', captured.current)
      button.setAttribute('data-selected', captured.marked)
      return true
    }
    return current.length === 1 && marked.length === 1 && current[0] === marked[0] || this.fail()
  }

  private fail(): false {
    this.dirty = true
    return false
  }

  private readonly onNativeClick = (event: MouseEvent) => {
    const captured = this.captured
    const ElementClass = this.document.defaultView?.Element
    if (captured === undefined || ElementClass === undefined || !(event.target instanceof ElementClass)) return
    const button = event.target.closest<HTMLButtonElement>('button[data-sidebar-destination]')
    if (
      button === null || !captured.rail.contains(button) || button.disabled
      || button.getAttribute('aria-disabled') === 'true' || button.closest('[inert]') !== null
    ) return
    captured.clicked = button
  }
}
