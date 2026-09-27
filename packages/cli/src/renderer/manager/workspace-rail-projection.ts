import { resolveManagerRailSeat } from '../host-probes.js'
import { readNativeRailSelection } from '../adapter/native-rail-selection-probe.js'
import {
  captureNativeRailIconOwner,
  nativeRailCommittedRouteIdentity,
  nativeRailIconOwnerCurrent,
  type NativeRailIconOwnerToken,
} from '../adapter/native-rail-icon-owner.js'
import {
  type NativeRailIconVisualHandle,
  type NativeRailIconVisualRequest,
  type NativeRailIconVisualResult,
  projectNativeRailDefaultIcon,
} from '../adapter/native-rail-icon-visual.js'
import { nativeRouteIdentity, type NativeRouteSource } from './native-route-transition.js'

const NATIVE_SELECTION_SUPPRESSION = 'data-cordisx-manager-native-selection-suppressed'

interface CapturedSelection {
  readonly button: HTMLButtonElement
  readonly destination: string
  readonly current: string
  readonly marked: string
  readonly routeIdentity: string | undefined
  clickedDestination: string | undefined
}

export interface WorkspaceRailIconOptions {
  readonly appVersion?: string
  readonly onLost?: () => void
  readonly project?: (request: NativeRailIconVisualRequest) => Promise<NativeRailIconVisualResult>
}

/** Host-owned workspace rail projection; it does not register a Codex destination or route. */
export class WorkspaceRailProjection {
  private captured: CapturedSelection | undefined
  private dirty = false
  private disposed = false
  private revision = 0
  private settling: Promise<boolean> | undefined
  private fingerprint = ''
  private stableSince = 0
  private iconRevision = 0
  private iconHandle: NativeRailIconVisualHandle | undefined
  private iconRetryTimer: ReturnType<typeof setTimeout> | undefined
  private currentCommittedRoute: string | undefined
  private previousCommittedRoute: string | undefined
  private unsubscribeRoute: (() => void) | undefined

  constructor(
    private readonly document: Document,
    private readonly route?: NativeRouteSource,
    private readonly icon?: WorkspaceRailIconOptions,
  ) {
    this.currentCommittedRoute = nativeRailCommittedRouteIdentity(document)
    this.unsubscribeRoute = route?.subscribe(() => this.rememberCommittedRoute())
  }

  private rememberCommittedRoute(): void {
    const identity = nativeRailCommittedRouteIdentity(this.document)
    if (identity === undefined || identity === this.currentCommittedRoute) return
    this.previousCommittedRoute = this.currentCommittedRoute
    this.currentCommittedRoute = identity
  }

  enter(): boolean {
    if (this.captured !== undefined || this.settling !== undefined || this.dirty || this.disposed) return false
    const rail = resolveManagerRailSeat(this.document)?.homeButton.closest<HTMLElement>(
      'nav[data-app-navigation-rail="true"]',
    )
    if (rail === null || rail === undefined) return false
    const current = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][aria-current="page"]')
    const marked = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
    const button = current[0]
    if (
      current.length !== 1 || marked.length !== 1 || button === undefined || button !== marked[0]
      || button.hasAttribute(NATIVE_SELECTION_SUPPRESSION)
    ) return false
    const routeIdentity = this.route === undefined ? undefined : nativeRouteIdentity(this.route.snapshot())
    if (this.route !== undefined && routeIdentity === undefined) return false
    this.rememberCommittedRoute()
    const provisionalOwner = this.icon?.appVersion !== undefined
        && readNativeRailSelection(rail) !== button && this.previousCommittedRoute !== undefined
      ? captureNativeRailIconOwner(this.document, this.previousCommittedRoute)
      : undefined
    this.captured = {
      button,
      destination: button.getAttribute('data-sidebar-destination')!,
      current: button.getAttribute('aria-current')!,
      marked: button.getAttribute('data-selected')!,
      routeIdentity,
      clickedDestination: undefined,
    }
    this.document.addEventListener('click', this.onNativeClick, true)
    button.setAttribute(NATIVE_SELECTION_SUPPRESSION, 'true')
    button.removeAttribute('aria-current')
    button.removeAttribute('data-selected')
    if (
      rail.querySelector('[data-sidebar-destination][aria-current="page"]') !== null
      || rail.querySelector('[data-sidebar-destination][data-selected]') !== null
    ) {
      this.leave()
      return false
    }
    this.startIconVisual(provisionalOwner)
    return true
  }

  leave(): boolean {
    this.cancelIconVisual()
    const captured = this.captured
    if (captured === undefined) return this.settling === undefined && !this.dirty
    this.captured = undefined
    captured.button.removeAttribute(NATIVE_SELECTION_SUPPRESSION)
    this.document.removeEventListener('click', this.onNativeClick, true)
    this.fingerprint = ''
    this.stableSince = 0
    const result = this.inspect(captured)
    if (result === 'done') return true
    if (result === 'dirty') return this.fail()
    const revision = ++this.revision
    this.settling = this.settle(captured, revision).finally(() => {
      if (revision === this.revision) this.settling = undefined
    })
    return false
  }

  async settled(): Promise<boolean> {
    return await (this.settling ?? Promise.resolve(!this.dirty))
  }

  dispose(): void {
    this.cancelIconVisual()
    this.disposed = true
    this.dirty = true
    ++this.revision
    this.captured?.button.removeAttribute(NATIVE_SELECTION_SUPPRESSION)
    this.captured = undefined
    this.unsubscribeRoute?.()
    this.document.removeEventListener('click', this.onNativeClick, true)
  }

  private cancelIconVisual(): void {
    ++this.iconRevision
    clearTimeout(this.iconRetryTimer)
    this.iconRetryTimer = undefined
    this.iconHandle?.dispose()
    this.iconHandle = undefined
  }

  private startIconVisual(provisionalOwner?: NativeRailIconOwnerToken): void {
    const appVersion = this.icon?.appVersion
    if (appVersion === undefined) return
    const revision = ++this.iconRevision
    void this.projectIconVisual(appVersion, revision, 0, provisionalOwner)
  }

  private async projectIconVisual(
    appVersion: string,
    revision: number,
    retry: number,
    provisionalOwner?: NativeRailIconOwnerToken,
  ): Promise<void> {
    if (!this.iconVisualEntryCurrent(revision, provisionalOwner)) return
    const project = this.icon?.project ?? projectNativeRailDefaultIcon
    let result: NativeRailIconVisualResult
    try {
      result = await project({
        document: this.document,
        appVersion,
        ...(provisionalOwner === undefined ? {} : { provisionalOwner }),
        onLost: () => {
          if (revision !== this.iconRevision || this.disposed || this.captured === undefined) return
          this.iconHandle = undefined
          this.icon?.onLost?.()
        },
      })
    } catch {
      // A changed native bundle fails closed; the Host does not write native route state.
      return
    }
    if (result.status === 'active') {
      if (
        !this.iconVisualEntryCurrent(revision, provisionalOwner)
        || result.handle.destination !== this.captured?.destination || !result.handle.isCurrent()
      ) {
        result.handle.dispose()
        return
      }
      this.iconHandle = result.handle
    } else if (
      (
        result.reason === 'visual-lease-exists' || result.reason === 'native-icon-owner-unavailable'
        || result.reason === 'native-icon-owner-changed' || result.reason === 'native-icon-geometry-unavailable'
        || result.reason === 'native-provisional-owner-invalid'
      ) && retry < 30 && this.iconVisualEntryCurrent(revision)
    ) {
      this.iconRetryTimer = setTimeout(() => {
        this.iconRetryTimer = undefined
        void this.projectIconVisual(appVersion, revision, retry + 1)
      }, 100)
    }
  }

  private iconVisualEntryCurrent(revision: number, provisionalOwner?: NativeRailIconOwnerToken): boolean {
    const captured = this.captured
    if (revision !== this.iconRevision || this.disposed || captured === undefined) return false
    if (captured.clickedDestination !== undefined && captured.clickedDestination !== captured.destination) return false
    const rail = resolveManagerRailSeat(this.document)?.homeButton.closest<HTMLElement>(
      'nav[data-app-navigation-rail="true"]',
    )
    if (rail === null || rail === undefined || !rail.contains(captured.button)) return false
    const marked = rail.querySelectorAll<HTMLButtonElement>(
      'button[data-sidebar-destination][aria-current="page"],button[data-sidebar-destination][data-selected]',
    )
    if ([...marked].some(button => button !== captured.button)) return false
    return provisionalOwner === undefined
      ? readNativeRailSelection(rail) === captured.button
      : provisionalOwner.button === captured.button && nativeRailIconOwnerCurrent(provisionalOwner, true)
  }

  private inspect(captured: CapturedSelection): 'done' | 'wait' | 'dirty' {
    const rail = resolveManagerRailSeat(this.document)?.homeButton.closest<HTMLElement>(
      'nav[data-app-navigation-rail="true"]',
    )
    if (rail === null || rail === undefined) return 'wait'
    const current = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][aria-current="page"]')
    const marked = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
    if (
      current.length > 1 || marked.length > 1 || (current.length === 1 && marked.length === 1
        && current[0] !== marked[0])
    ) return 'dirty'
    const routeIdentity = this.route === undefined ? undefined : nativeRouteIdentity(this.route.snapshot())
    const nativeSelected = readNativeRailSelection(rail)
    const marker = current.length === 1 && marked.length === 1 ? current[0] : undefined
    const fingerprint = JSON.stringify([
      nativeSelected?.getAttribute('data-sidebar-destination'),
      marker?.getAttribute('data-sidebar-destination'),
    ])
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.stableSince = Date.now()
    }
    const stableMs = Date.now() - this.stableSince
    const clickedOther = captured.clickedDestination !== undefined
      && captured.clickedDestination !== captured.destination
    if (marker !== undefined) {
      const destination = marker.getAttribute('data-sidebar-destination')
      if (captured.clickedDestination === undefined || destination === captured.clickedDestination) return 'done'
      if (
        clickedOther && destination === captured.destination
        && routeIdentity === captured.routeIdentity && stableMs >= 500
      ) {
        return 'done'
      }
      return 'wait'
    }
    if (current.length === 0 && marked.length === 0) {
      if (captured.clickedDestination === captured.destination) {
        const sameDestination = [...rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination]')]
          .filter(button => button.getAttribute('data-sidebar-destination') === captured.destination)
        if (sameDestination.length !== 1) return 'dirty'
        return this.restore(rail, sameDestination[0]!, captured) ? 'done' : 'dirty'
      }
      if (
        captured.clickedDestination === undefined && routeIdentity === captured.routeIdentity
        && captured.button.isConnected && rail.contains(captured.button)
        && (nativeSelected === undefined || nativeSelected === captured.button)
      ) {
        return this.restore(rail, captured.button, captured) ? 'done' : 'dirty'
      }
      const selectedDestination = nativeSelected?.getAttribute('data-sidebar-destination')
      if (
        nativeSelected !== undefined && stableMs >= 250 && !clickedOther
        && selectedDestination === captured.destination
      ) {
        return this.restore(rail, nativeSelected, captured) ? 'done' : 'dirty'
      }
      if (
        routeIdentity === captured.routeIdentity && stableMs >= 500
        && captured.button.isConnected && rail.contains(captured.button)
        && (nativeSelected === undefined || nativeSelected === captured.button)
      ) {
        return this.restore(rail, captured.button, captured) ? 'done' : 'dirty'
      }
    }
    return 'wait'
  }

  private restore(rail: HTMLElement, button: HTMLButtonElement, captured: CapturedSelection): boolean {
    button.setAttribute('aria-current', captured.current)
    button.setAttribute('data-selected', captured.marked)
    const current = rail.querySelectorAll('button[data-sidebar-destination][aria-current="page"]')
    const marked = rail.querySelectorAll('button[data-sidebar-destination][data-selected]')
    return current.length === 1 && marked.length === 1 && current[0] === button && marked[0] === button
  }

  private async settle(captured: CapturedSelection, revision: number): Promise<boolean> {
    const deadline = Date.now() + 6_000
    while (Date.now() < deadline && revision === this.revision && !this.disposed) {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (revision !== this.revision || this.disposed) return false
      const result = this.inspect(captured)
      if (result === 'done') return true
      if (result === 'dirty') return this.fail()
    }
    return this.fail()
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
    const rail = resolveManagerRailSeat(this.document)?.homeButton.closest('nav[data-app-navigation-rail="true"]')
    if (
      button === null || rail === null || rail === undefined || !rail.contains(button) || button.disabled
      || button.getAttribute('aria-disabled') === 'true' || button.closest('[inert]') !== null
    ) return
    captured.clickedDestination = button.getAttribute('data-sidebar-destination') ?? undefined
  }
}
