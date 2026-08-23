import type { CordisXLocalizedText, CordisXStructuredAction, CordisXSurfaceName } from '../contracts.js'
import type { CordisXCommandService } from './commands.js'
import type { CordisXI18nService } from './i18n.js'
import type { CordisXRouteService, OutletController, OutletHostSnapshot, OutletPlacement } from './navigation.js'
import type { CordisXSlotService, SurfaceContributionSnapshot } from './surfaces.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  type ExtensionPointDescriptorRegistry,
} from './extension-points.js'
import { createHostSurfaceIcon } from './icons.js'
import { HostTooltipController, type HostTooltipPlacement } from './tooltips.js'
import { evaluateWhen } from './validation.js'

interface ResolvedOutletAnchor {
  readonly anchor: HTMLElement
  readonly contextKey: string
  readonly nativeSessionId?: string
  readonly insets?: Readonly<{
    top?: number
    right?: number
    bottom?: number
    left?: number
  }>
  readonly pageChromeSafeLeft?: number
}

type OutletResolver = () => ResolvedOutletAnchor | undefined

function normalizedInsets(resolved: ResolvedOutletAnchor): Required<NonNullable<ResolvedOutletAnchor['insets']>> {
  return {
    top: Math.max(0, resolved.insets?.top ?? 0),
    right: Math.max(0, resolved.insets?.right ?? 0),
    bottom: Math.max(0, resolved.insets?.bottom ?? 0),
    left: Math.max(0, resolved.insets?.left ?? 0),
  }
}

function visible(element: Element): element is HTMLElement {
  const ElementClass = element.ownerDocument.defaultView?.HTMLElement
  return ElementClass !== undefined && element instanceof ElementClass
    && (element.getClientRects().length > 0 || element.ownerDocument.defaultView === null)
}

function uniqueVisible(document: Document, selector: string): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll(selector)].filter(visible)
  return candidates.length === 1 ? candidates[0] : undefined
}

function titlebarTrafficLightInset(document: Document): number {
  const platform = document.defaultView?.navigator.platform ?? ''
  if (!/mac/iu.test(platform)) return 12
  const titlebar = uniqueVisible(document, 'header[data-app-shell-application-menu-bar]')
  if (titlebar === undefined) return 88
  const titlebarRect = titlebar.getBoundingClientRect()
  const candidates = nativeButtons(titlebar)
    .map(button => button.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.left >= titlebarRect.left + 64 && rect.left < titlebarRect.left + 180)
    .sort((left, right) => left.left - right.left)
  return Math.max(12, Math.ceil((candidates[0]?.left ?? titlebarRect.left + 88) - titlebarRect.left))
}

function selectedSessionId(document: Document): string | undefined {
  const selected = uniqueVisible(document, '[data-app-action-sidebar-thread-selected="true"]')
  const host = selected?.getAttribute('data-app-action-sidebar-thread-host-id')
  const raw = selected?.getAttribute('data-app-action-sidebar-thread-id')
  if (host !== 'local' || typeof raw !== 'string' || !raw.startsWith('local:')) return undefined
  return raw.slice('local:'.length)
}

function uniqueAttribute(document: Document, selector: string, attribute: string): string | undefined {
  const values = new Set([...document.querySelectorAll(selector)]
    .filter(visible)
    .map(element => element.getAttribute(attribute))
    .filter((value): value is string => value !== null && value !== ''))
  return values.size === 1 ? [...values][0] : undefined
}

function currentSessionId(document: Document): string | undefined {
  const candidates = [
    selectedSessionId(document),
    uniqueAttribute(document, '[data-response-annotation-conversation]', 'data-response-annotation-conversation'),
    uniqueAttribute(document, '[data-above-composer-conversation-id]', 'data-above-composer-conversation-id'),
  ].filter((value): value is string => value !== undefined)
  if (candidates.length < 2 || new Set(candidates).size !== 1) return undefined
  return candidates[0]
}

function sessionContentAnchor(document: Document, sessionId: string): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll('[data-codex-thread-reference-drop-target]')]
    .filter(visible)
    .filter((candidate) => {
      const response = [...candidate.querySelectorAll('[data-response-annotation-conversation]')]
        .some(element => element.getAttribute('data-response-annotation-conversation') === sessionId)
      const composer = [...candidate.querySelectorAll('[data-above-composer-conversation-id]')]
        .some(element => element.getAttribute('data-above-composer-conversation-id') === sessionId)
      return response && composer
    })
  return candidates.length === 1 ? candidates[0] : undefined
}

/** One host-owned overlay layer. Native anchors are observed and never mutated except by appending this layer. */
export class DomOutletController implements OutletController {
  private readonly listeners = new Set<() => void>()
  private readonly observer?: MutationObserver
  private resizeObserver: ResizeObserver | undefined
  private readonly layer: HTMLElement
  private snapshot: OutletHostSnapshot
  private scheduled = false
  private shown = false
  private disposed = false
  private anchor: HTMLElement | undefined

  constructor(
    private readonly document: Document,
    private readonly outletId: string,
    private readonly preferredPlacement: OutletPlacement,
    private readonly resolver: OutletResolver,
  ) {
    this.layer = document.createElement('section')
    this.layer.dataset.cordisxPageOutlet = outletId
    this.layer.hidden = true
    Object.assign(this.layer.style, {
      boxSizing: 'border-box',
      overflow: 'auto',
      pointerEvents: 'auto',
      zIndex: '2147483200',
    })
    this.snapshot = Object.freeze({ available: false, placement: preferredPlacement, error: 'semantic anchor is unavailable' })
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer((records) => {
        const nativeMutation = records.some((record) => {
          const target = record.target.nodeType === 1
            ? record.target as Element
            : record.target.parentElement
          return target?.closest('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]') === null
        })
        if (nativeMutation) this.schedule()
      })
      this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    }
    document.defaultView?.addEventListener('resize', this.schedule)
    document.defaultView?.addEventListener('scroll', this.schedule, true)
    this.reconcile()
  }

  getSnapshot(): OutletHostSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(): void {
    this.shown = true
    this.layer.hidden = false
    this.reconcile()
  }

  hide(): void {
    this.shown = false
    this.layer.hidden = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    this.document.defaultView?.removeEventListener('resize', this.schedule)
    this.document.defaultView?.removeEventListener('scroll', this.schedule, true)
    this.layer.remove()
    this.listeners.clear()
  }

  private readonly schedule = (): void => {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.reconcile()
    })
  }

  private reconcile(): void {
    if (this.disposed) return
    const resolved = this.resolver()
    if (resolved === undefined || !resolved.anchor.isConnected) {
      this.anchor = undefined
      this.layer.remove()
      this.updateSnapshot({ available: false, placement: this.preferredPlacement, error: 'semantic anchor is unavailable' })
      return
    }
    this.anchor = resolved.anchor
    this.layer.style.setProperty('--cordisx-page-chrome-safe-left', `${Math.max(0, resolved.pageChromeSafeLeft ?? 0)}px`)
    const isApp = this.outletId === 'app'
    const hostPosition = this.document.defaultView?.getComputedStyle(resolved.anchor).position
    const positioned = isApp || (hostPosition !== undefined && hostPosition !== '' && hostPosition !== 'static')
    const placement: OutletPlacement = isApp
      ? 'fixed'
      : this.preferredPlacement === 'portal'
        ? 'portal'
        : positioned
          ? 'absolute'
          : 'portal'
    if (placement === 'portal') {
      if (this.layer.parentElement !== this.document.body) this.document.body.append(this.layer)
      this.installGeometryObserver(resolved.anchor)
      this.projectGeometry(resolved)
    } else {
      this.resizeObserver?.disconnect()
      this.resizeObserver = undefined
      if (this.layer.parentElement !== resolved.anchor) resolved.anchor.append(this.layer)
      const insets = normalizedInsets(resolved)
      Object.assign(this.layer.style, {
        position: isApp ? 'fixed' : 'absolute',
        inset: 'auto',
        left: `${insets.left}px`,
        top: `${insets.top}px`,
        right: `${insets.right}px`,
        bottom: `${insets.bottom}px`,
        width: '',
        height: '',
      })
    }
    if (this.layer.hidden === this.shown) this.layer.hidden = !this.shown
    this.updateSnapshot(Object.freeze({
      available: true,
      contextKey: resolved.contextKey,
      container: this.layer,
      placement,
      ...(resolved.nativeSessionId === undefined ? {} : { nativeSessionId: resolved.nativeSessionId }),
    }))
  }

  private installGeometryObserver(anchor: HTMLElement): void {
    this.resizeObserver?.disconnect()
    const Observer = this.document.defaultView?.ResizeObserver
    if (Observer === undefined) return
    this.resizeObserver = new Observer(() => this.reconcile())
    this.resizeObserver.observe(anchor)
  }

  private projectGeometry(resolved: ResolvedOutletAnchor): void {
    const rect = resolved.anchor.getBoundingClientRect()
    const insets = normalizedInsets(resolved)
    Object.assign(this.layer.style, {
      position: 'fixed',
      inset: 'auto',
      left: `${rect.left + insets.left}px`,
      top: `${rect.top + insets.top}px`,
      width: `${Math.max(0, rect.width - insets.left - insets.right)}px`,
      height: `${Math.max(0, rect.height - insets.top - insets.bottom)}px`,
    })
  }

  private updateSnapshot(next: OutletHostSnapshot): void {
    const previous = this.snapshot
    const same = previous.available === next.available
      && previous.contextKey === next.contextKey
      && previous.container === next.container
      && previous.placement === next.placement
      && previous.nativeSessionId === next.nativeSessionId
      && previous.error === next.error
    if (same) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

function create(document: Document, tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  return element
}

const CORDISX_SURFACE_HOST_SELECTOR = '[data-cordisx-surface-host]'

function nativeButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')]
    .filter((element): element is HTMLButtonElement => visible(element))
    .filter(element => element.closest(CORDISX_SURFACE_HOST_SELECTOR) === null)
}

function nextNativeSibling(node: ChildNode): ChildNode | null {
  let sibling = node.nextSibling
  while (sibling instanceof Element && sibling.matches(CORDISX_SURFACE_HOST_SELECTOR)) sibling = sibling.nextSibling
  return sibling
}

function nativeControlInsertionAnchor(document: Document, control: HTMLElement): HTMLElement {
  let anchor = control
  for (let parent = anchor.parentElement; parent !== null; parent = anchor.parentElement) {
    if (parent.closest(CORDISX_SURFACE_HOST_SELECTOR) !== null) break
    if (document.defaultView?.getComputedStyle(parent).display !== 'contents') break
    anchor = parent
  }
  return anchor
}

function resolveSidebarNavigationParent(document: Document, sidebar: HTMLElement): HTMLElement | undefined {
  const candidates = nativeButtons(sidebar).filter(button => (
    button.closest('[data-app-action-sidebar-section]') === null
    && button.closest('[data-app-action-sidebar-project-list-id]') === null
  ))
  const parents = new Set<HTMLElement>()
  for (const button of candidates) {
    let fallback: HTMLElement | undefined
    for (let element = button.parentElement; element !== null && element !== sidebar; element = element.parentElement) {
      if (element.closest(CORDISX_SURFACE_HOST_SELECTOR) !== null) continue
      if (element.childElementCount > 1 && fallback === undefined) fallback = element
      const style = document.defaultView?.getComputedStyle(element)
      if ((style?.display === 'flex' || style?.display === 'grid') && style.flexDirection === 'column') {
        parents.add(element)
        break
      }
    }
    if (parents.size === 0 && fallback !== undefined) parents.add(fallback)
  }
  return parents.size === 1 ? [...parents][0] : undefined
}

function resolveSidebarFooterControl(document: Document, sidebar: HTMLElement): HTMLButtonElement | undefined {
  const scope = sidebar.closest('aside') ?? sidebar.parentElement
  if (scope === null) return undefined
  const buttons = nativeButtons(scope)
  const labelled = buttons.filter(button => /(?:help|帮助)/iu.test(button.getAttribute('aria-label') ?? ''))
  if (labelled.length === 1) return labelled[0]
  const scopeRect = scope.getBoundingClientRect()
  const candidates = buttons
    .map(button => ({ button, rect: button.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.width <= 52 && rect.height > 0 && rect.height <= 52)
    .filter(({ rect }) => rect.bottom >= scopeRect.bottom - 72 && rect.right <= scopeRect.right + 1)
    .sort((left, right) => right.rect.right - left.rect.right || right.rect.bottom - left.rect.bottom)
  return candidates[0]?.button
}

function resolveToolbarControl(toolbar: HTMLElement): HTMLButtonElement | undefined {
  const slots = [...toolbar.querySelectorAll<HTMLElement>('[data-test-id="header-shell-slot"]')]
    .filter(visible)
    .map((slot, index) => ({ slot, index, right: slot.getBoundingClientRect().right }))
    .sort((left, right) => left.right - right.right || left.index - right.index)
  const scope = slots.at(-1)?.slot ?? toolbar
  const buttons = nativeButtons(scope)
  return buttons.length >= 2 ? buttons[0] : buttons.at(-1)
}

function resolveAccountControl(sidebar: HTMLElement): HTMLButtonElement | undefined {
  const scope = sidebar.closest('aside') ?? sidebar.parentElement
  if (scope === null) return undefined
  const candidates = nativeButtons(scope).filter(button => (
    button.getAttribute('aria-haspopup') === 'menu'
    && /(?:profile|account|个人资料|账户)/iu.test(button.getAttribute('aria-label') ?? '')
  ))
  return candidates.length === 1 ? candidates[0] : undefined
}

function resolveToolbarMenuControl(toolbar: HTMLElement): HTMLButtonElement | undefined {
  const candidates = nativeButtons(toolbar)
    .filter(button => button.getAttribute('aria-haspopup') === 'menu')
    .sort((left, right) => left.getBoundingClientRect().right - right.getBoundingClientRect().right)
  return candidates.at(-1)
}

function resolveOpenNativeMenu(document: Document, control: HTMLButtonElement | undefined): HTMLElement | undefined {
  if (control === undefined || control.id === '' || control.getAttribute('aria-expanded') !== 'true') return undefined
  const candidates = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    .filter(visible)
    .filter(menu => menu.getAttribute('aria-labelledby') === control.id)
  return candidates.length === 1 ? candidates[0] : undefined
}

function nativeMenuInsertionPoint(menu: HTMLElement): ChildNode | null {
  const children = [...menu.children].filter(child => child.closest(CORDISX_SURFACE_HOST_SELECTOR) === null)
  const separatorIndex = children.findIndex(child => child.getAttribute('role') === 'separator'
    || child.querySelector(':scope > [class*="bg-border"]') !== null)
  if (separatorIndex >= 0) return children[separatorIndex + 1] ?? null
  return children.find(child => child.getAttribute('role') === 'menuitem') ?? null
}

function nativeMenuItemTemplate(menu: HTMLElement): HTMLElement | undefined {
  return [...menu.children].find((child): child is HTMLElement => (
    child instanceof menu.ownerDocument.defaultView!.HTMLElement
    && child.getAttribute('role') === 'menuitem'
    && child.closest(CORDISX_SURFACE_HOST_SELECTOR) === null
  ))
}

interface NativeSurfaceSeat {
  readonly key: string
  readonly parent: HTMLElement
  readonly before: ChildNode | null
  readonly className: string
}

class StructuredSurfaceRenderer {
  private readonly roots = new Map<string, HTMLElement>()
  private readonly sites = new Set<string>()
  private readonly observer?: MutationObserver
  private readonly tooltips: HostTooltipController
  private readonly unsubscribers: (() => void)[]
  private toolbarSlot: { element: HTMLElement; width: string; minWidth: string } | undefined
  private scheduled = false
  private rebuildScheduled = false
  private disposed = false

  constructor(
    private readonly document: Document,
    private readonly slots: CordisXSlotService,
    private readonly commands: CordisXCommandService,
    private readonly routes: CordisXRouteService,
    private readonly i18n: CordisXI18nService,
  ) {
    this.tooltips = new HostTooltipController(document)
    this.unsubscribers = [
      slots.subscribeInternal(() => this.schedule(true)),
      commands.subscribeInternal(() => this.schedule(true)),
      routes.subscribeInternal(() => this.schedule(true)),
      i18n.subscribeInternal(() => this.schedule(true)),
    ]
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer((records) => {
        const nativeMutation = records.some((record) => {
          const target = record.target.nodeType === 1
            ? record.target as Element
            : record.target.parentElement
          return target?.closest('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]') === null
        })
        if (nativeMutation) this.schedule(false)
      })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    this.schedule(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.restoreToolbarSlot()
    this.tooltips.dispose()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    for (const root of this.roots.values()) root.remove()
    this.roots.clear()
    for (const site of this.sites) {
      const [owner, ...rest] = site.split('\u0000')
      this.i18n.clearDiagnosticSite(owner!, rest.join('\u0000'))
    }
    this.sites.clear()
  }

  private schedule(rebuild: boolean): void {
    if (this.disposed) return
    this.rebuildScheduled ||= rebuild
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const shouldRebuild = this.rebuildScheduled
      this.rebuildScheduled = false
      this.render(shouldRebuild)
    })
  }

  private render(rebuild: boolean): void {
    const snapshots = this.slots.snapshot()
    const nextSites = new Set<string>()
    if (!rebuild) for (const site of this.sites) nextSites.add(site)
    const usedRoots = new Set<string>()
    const availableSurfaces = new Set<string>()
    const sidebar = uniqueVisible(this.document, '[data-app-action-sidebar-scroll]')
    const toolbar = uniqueVisible(this.document, 'header[data-app-shell-application-menu-bar]')
    const environment = uniqueVisible(this.document, '[data-pip-home-surface="thread-summary-panel"]')
      ?? uniqueVisible(this.document, '[data-app-shell-focus-area="right-panel"]')
    const sidebarNavigation = sidebar === undefined ? undefined : resolveSidebarNavigationParent(this.document, sidebar)
    const sidebarFooterControl = sidebar === undefined ? undefined : resolveSidebarFooterControl(this.document, sidebar)
    const accountControl = sidebar === undefined ? undefined : resolveAccountControl(sidebar)
    const toolbarControl = toolbar === undefined ? undefined : resolveToolbarControl(toolbar)
    const toolbarMenuControl = toolbar === undefined ? undefined : resolveToolbarMenuControl(toolbar)
    const sessionId = currentSessionId(this.document)
    const contextValues = {
      'sidebar.visible': sidebarNavigation !== undefined || sidebarFooterControl !== undefined,
      'toolbar.visible': toolbarControl !== undefined,
      'environment.visible': environment !== undefined,
      ...(sessionId === undefined ? {} : { 'session.active': sessionId }),
    }
    this.slots.contexts.replace(contextValues)
    this.routes.contexts.replace(contextValues)
    this.slots.registry.setToolbarAnchors(toolbarControl === undefined ? [] : ['workspace.primary'])

    const active = snapshots.filter(item => item.visible && item.authorized && item.valid && !item.pending)
    if (sidebarNavigation !== undefined) {
      availableSurfaces.add('sidebar.navigation.items')
      const items = active.filter(item => item.surface === 'sidebar.navigation.items')
      if (items.length > 0) {
        const root = this.placeRoot({
          key: 'sidebar.navigation', parent: sidebarNavigation, before: null, className: 'cordisx-sidebar-navigation',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderNavigation(root, items, nextSites, nativeButtons(sidebarNavigation)[0])
      }
    }
    if (sidebarFooterControl?.parentElement !== null && sidebarFooterControl?.parentElement !== undefined) {
      const parent = sidebarFooterControl.parentElement
      availableSurfaces.add('sidebar.footer.before-control')
      availableSurfaces.add('sidebar.footer.after-control')
      availableSurfaces.add('sidebar.footer.menu')
      const beforeItems = active.filter(item => item.surface === 'sidebar.footer.before-control')
      if (beforeItems.length > 0) {
        const root = this.placeRoot({
          key: 'sidebar.footer.before', parent, before: sidebarFooterControl, className: 'cordisx-sidebar-footer-before',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, beforeItems, nextSites, 'action', sidebarFooterControl)
      }
      const afterItems = active.filter(item => item.surface === 'sidebar.footer.after-control')
      if (afterItems.length > 0) {
        const root = this.placeRoot({
          key: 'sidebar.footer.after', parent, before: nextNativeSibling(sidebarFooterControl), className: 'cordisx-sidebar-footer-after',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, afterItems, nextSites, 'action', sidebarFooterControl)
      }
      const menuItems = active.filter(item => item.surface === 'sidebar.footer.menu')
      const menu = resolveOpenNativeMenu(this.document, sidebarFooterControl)
      if (menuItems.length > 0 && menu !== undefined) this.projectNativeMenu('sidebar.footer.menu', menu, sidebarFooterControl, menuItems, nextSites, usedRoots, rebuild)
    }
    if (accountControl !== undefined) {
      availableSurfaces.add('sidebar.account.menu')
      const menuItems = active.filter(item => item.surface === 'sidebar.account.menu')
      const menu = resolveOpenNativeMenu(this.document, accountControl)
      if (menuItems.length > 0 && menu !== undefined) this.projectNativeMenu('sidebar.account.menu', menu, accountControl, menuItems, nextSites, usedRoots, rebuild)
    }
    if (toolbarControl?.parentElement !== null && toolbarControl?.parentElement !== undefined) {
      const toolbarAnchor = nativeControlInsertionAnchor(this.document, toolbarControl)
      const parent = toolbarAnchor.parentElement
      if (parent === null) return
      availableSurfaces.add('workspace.toolbar.items')
      const beforeItems = active.filter(item => item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'before')
      if (beforeItems.length > 0) {
        const root = this.placeRoot({
          key: 'toolbar.before', parent, before: toolbarAnchor, className: 'cordisx-toolbar-before',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, beforeItems, nextSites, 'before', toolbarControl)
      }
      const afterItems = active.filter(item => item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'after')
      if (afterItems.length > 0) {
        const root = this.placeRoot({
          key: 'toolbar.after', parent, before: nextNativeSibling(toolbarAnchor), className: 'cordisx-toolbar-after',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, afterItems, nextSites, 'after', toolbarControl)
      }
      const menuItems = active.filter(item => item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'menu')
      const menu = resolveOpenNativeMenu(this.document, toolbarMenuControl)
      if (menuItems.length > 0 && menu !== undefined && toolbarMenuControl !== undefined) {
        this.projectNativeMenu('toolbar.menu', menu, toolbarMenuControl, menuItems, nextSites, usedRoots, rebuild)
      }
    }
    this.reconcileToolbarSlot(toolbarControl, usedRoots)
    if (environment !== undefined) {
      for (const surface of [
        'environment.panel.header-actions', 'environment.panel.sections', 'environment.section.actions',
        'environment.section.rows', 'environment.row.trailing-actions',
      ] as const) availableSurfaces.add(surface)
      const items = active.filter(item => item.surface.startsWith('environment.'))
      if (items.length > 0) {
        const root = this.placeRoot({
          key: 'environment', parent: environment, before: null, className: 'cordisx-environment',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderEnvironment(root, items, nextSites)
      }
    }
    for (const [key, root] of this.roots) {
      if (!usedRoots.has(key)) root.remove()
    }
    for (const snapshot of snapshots) {
      const rendered = snapshot.visible && snapshot.authorized && snapshot.valid && !snapshot.pending
        && availableSurfaces.has(snapshot.surface)
      this.slots.registry.markRendered(snapshot.surface, snapshot.qualifiedId, rendered)
    }
    for (const site of this.sites) {
      if (nextSites.has(site)) continue
      const [owner, ...rest] = site.split('\u0000')
      this.i18n.clearDiagnosticSite(owner!, rest.join('\u0000'))
    }
    this.sites.clear()
    for (const site of nextSites) this.sites.add(site)
  }

  private placeRoot(seat: NativeSurfaceSeat, usedRoots: Set<string>): HTMLElement {
    const root = this.roots.get(seat.key) ?? create(this.document, 'div')
    this.roots.set(seat.key, root)
    usedRoots.add(seat.key)
    root.className = `cordisx-native-seat ${seat.className}`
    root.dataset.cordisxSurfaceHost = seat.key
    root.dataset.cordisxNoDrag = 'true'
    root.style.setProperty('-webkit-app-region', 'no-drag')
    if (root.parentElement !== seat.parent || root.nextSibling !== seat.before) seat.parent.insertBefore(root, seat.before)
    root.hidden = false
    return root
  }

  private restoreToolbarSlot(): void {
    if (this.toolbarSlot === undefined) return
    this.toolbarSlot.element.style.width = this.toolbarSlot.width
    this.toolbarSlot.element.style.minWidth = this.toolbarSlot.minWidth
    this.toolbarSlot = undefined
  }

  private reconcileToolbarSlot(control: HTMLButtonElement | undefined, usedRoots: Set<string>): void {
    const roots = ['toolbar.before', 'toolbar.after']
      .filter(key => usedRoots.has(key))
      .map(key => this.roots.get(key))
      .filter((root): root is HTMLElement => root !== undefined)
    const slot = control?.closest<HTMLElement>('[data-test-id="header-shell-slot"]')
    if (slot === null || slot === undefined || roots.length === 0) {
      this.restoreToolbarSlot()
      return
    }
    if (this.toolbarSlot?.element !== slot) {
      this.restoreToolbarSlot()
      this.toolbarSlot = { element: slot, width: slot.style.width, minWidth: slot.style.minWidth }
    }
    const originalWidth = Number.parseFloat(this.toolbarSlot.width) || 0
    const originalMinimum = Number.parseFloat(this.toolbarSlot.minWidth)
      || Number.parseFloat(this.document.defaultView?.getComputedStyle(slot).minWidth ?? '')
      || 0
    const contributionWidth = roots.reduce((total, root) => total + root.getBoundingClientRect().width, 0)
    slot.style.width = `${Math.ceil(Math.max(originalWidth, originalMinimum) + contributionWidth + roots.length * 6)}px`
  }

  private text(snapshot: SurfaceContributionSnapshot, value: CordisXLocalizedText, path: string, nextSites: Set<string>): string {
    const site = `surface:${snapshot.surface}:${snapshot.qualifiedId}:${path}`
    nextSites.add(`${snapshot.owner}\u0000${site}`)
    return this.i18n.resolveFor(snapshot.owner, value, site).text
  }

  private button(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
    path: string,
    nextSites: Set<string>,
    nativePattern?: 'toolbar' | 'footer' | 'shortcut',
    nativeTemplate?: HTMLButtonElement,
    afterActivate?: () => void,
  ): HTMLButtonElement {
    const button = this.document.createElement('button')
    button.type = 'button'
    button.className = nativePattern === undefined
      ? 'cordisx-action'
      : `${nativeTemplate?.className ?? ''} cordisx-action cordisx-native-icon-action cordisx-${nativePattern}-action`.trim()
    button.dataset.cordisxNoDrag = 'true'
    button.style.setProperty('-webkit-app-region', 'no-drag')
    const label = this.text(snapshot, action.label, `${path}.label`, nextSites)
    if (nativePattern === undefined) {
      if (action.icon !== undefined) button.append(createHostSurfaceIcon(this.document, action.icon))
      const copy = create(this.document, 'span', 'cordisx-action-label')
      copy.textContent = label
      button.append(copy)
    } else {
      button.append(createHostSurfaceIcon(this.document, action.icon))
      button.dataset.cordisxTooltip = label
      const placement: HostTooltipPlacement = nativePattern === 'toolbar' ? 'bottom' : 'top'
      this.tooltips.attach(button, () => button.dataset.cordisxTooltip, placement)
    }
    button.setAttribute('aria-label', action.ariaLabel === undefined
      ? label
      : this.text(snapshot, action.ariaLabel, `${path}.ariaLabel`, nextSites))
    const command = this.commands.snapshot().find(item => item.qualifiedId === (action.command.id.includes(':') ? action.command.id : `${snapshot.owner}:${action.command.id}`))
    const actionState = action as CordisXStructuredAction & { when?: Parameters<typeof evaluateWhen>[0]; disabled?: { value: boolean; reason?: CordisXLocalizedText } }
    button.hidden = !evaluateWhen(actionState.when, this.slots.contexts.getSnapshot())
    button.disabled = snapshot.disabled || actionState.disabled?.value === true || (command?.running ?? 0) > 0
    const reason = actionState.disabled?.reason
    if (button.disabled && reason !== undefined) button.dataset.cordisxTooltip = this.text(snapshot, reason, `${path}.disabled`, nextSites)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      afterActivate?.()
      void this.commands.executeFor(snapshot.owner, action.command, `${snapshot.surface}:${snapshot.qualifiedId}:${path}`, {
        pointId: snapshot.surface,
        contributionId: snapshot.qualifiedId,
      }).catch(error => {
        button.dataset.error = error instanceof Error ? error.message : String(error)
        this.schedule(true)
      })
    })
    return button
  }

  private renderNavigation(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>, _nativeTemplate?: HTMLButtonElement): void {
    root.replaceChildren()
    const navigation = create(this.document, 'div', 'cordisx-navigation')
    for (const snapshot of snapshots) {
      const item = snapshot.item as { label: CordisXLocalizedText; description?: CordisXLocalizedText; icon?: string; command?: { id: string; arguments?: never }; route?: { id: string; params?: never }; actions?: readonly (CordisXStructuredAction & { id: string })[] }
      const row = create(this.document, 'div', 'cordisx-nav-row')
      const primary = this.document.createElement('button')
      primary.type = 'button'
      primary.className = 'cordisx-nav-primary'
      primary.dataset.cordisxNoDrag = 'true'
      primary.style.setProperty('-webkit-app-region', 'no-drag')
      primary.append(createHostSurfaceIcon(this.document, item.icon))
      const copy = create(this.document, 'span', 'cordisx-nav-copy')
      copy.textContent = this.text(snapshot, item.label, 'label', sites)
      const description = item.description === undefined ? undefined : this.text(snapshot, item.description, 'description', sites)
      if (description !== undefined) primary.dataset.cordisxTooltip = description
      primary.append(copy)
      const activate = (): void => {
        const operation = item.command !== undefined
          ? this.commands.executeFor(snapshot.owner, item.command, `nav:${snapshot.qualifiedId}`, {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
            })
          : item.route === undefined ? Promise.reject(new Error('navigation item has no activation')) : this.routes.navigateFor(snapshot.owner, item.route)
        void operation.catch(error => { row.dataset.error = error instanceof Error ? error.message : String(error); this.schedule(true) })
      }
      primary.addEventListener('click', activate)
      row.append(primary)
      const actions = create(this.document, 'span', 'cordisx-nav-actions')
      for (const [index, action] of (item.actions ?? []).entries()) actions.append(this.button(snapshot, action, `actions.${index}`, sites, 'shortcut'))
      row.append(actions)
      navigation.append(row)
    }
    root.append(navigation)
  }

  private renderActions(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>, path: string, template: HTMLButtonElement): void {
    root.replaceChildren()
    const pattern = template.closest('header[data-app-shell-application-menu-bar]') === null ? 'footer' : 'toolbar'
    for (const snapshot of snapshots) root.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, path, sites, pattern, template))
  }

  private projectNativeMenu(
    key: string,
    menu: HTMLElement,
    control: HTMLButtonElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
    usedRoots: Set<string>,
    rebuild: boolean,
  ): void {
    const root = this.placeRoot({
      key, parent: menu, before: nativeMenuInsertionPoint(menu), className: 'cordisx-native-menu-root',
    }, usedRoots)
    if (!rebuild && root.childElementCount > 0) return
    root.replaceChildren()
    const template = nativeMenuItemTemplate(menu)
    if (menu.dataset.cordisxKeyboard !== 'true') {
      menu.dataset.cordisxKeyboard = 'true'
      menu.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        if ((event.target as Element | null)?.closest('[role="menu"]') !== menu) return
        const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          .filter(item => item.getAttribute('aria-disabled') !== 'true' && !item.hasAttribute('disabled'))
        if (items.length === 0) return
        const current = items.indexOf(this.document.activeElement as HTMLElement)
        const index = event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
              : (current - 1 + items.length) % items.length
        event.preventDefault()
        event.stopImmediatePropagation()
        items[index]?.focus()
      }, true)
    }
    for (const snapshot of snapshots) {
      const action = snapshot.item as CordisXStructuredAction
      const item = create(this.document, 'div', `cordisx-native-menu-item ${template?.className ?? ''}`.trim())
      item.setAttribute('role', 'menuitem')
      item.tabIndex = -1
      item.dataset.cordisxNoDrag = 'true'
      item.style.setProperty('-webkit-app-region', 'no-drag')
      const row = create(this.document, 'div', 'cordisx-native-menu-row')
      row.append(createHostSurfaceIcon(this.document, action.icon))
      const label = create(this.document, 'span', 'cordisx-native-menu-label')
      label.textContent = this.text(snapshot, action.label, 'menu.label', sites)
      row.append(label)
      item.append(row)
      item.addEventListener('pointermove', () => item.focus())
      const activate = (): void => {
        control.click()
        void this.commands.executeFor(snapshot.owner, action.command, `${snapshot.surface}:${snapshot.qualifiedId}:menu`, {
          pointId: snapshot.surface,
          contributionId: snapshot.qualifiedId,
        }).catch(error => { item.dataset.error = error instanceof Error ? error.message : String(error); this.schedule(true) })
      }
      item.addEventListener('click', event => { event.stopPropagation(); activate() })
      item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        activate()
      })
      root.append(item)
    }
  }

  private renderEnvironment(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>): void {
    root.replaceChildren()
    const header = create(this.document, 'div', 'cordisx-env-header')
    header.append(create(this.document, 'strong'))
    header.firstElementChild!.textContent = 'CordisX'
    for (const snapshot of snapshots.filter(item => item.surface === 'environment.panel.header-actions')) header.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'header', sites, 'shortcut'))
    root.append(header)
    for (const sectionSnapshot of snapshots.filter(item => item.surface === 'environment.panel.sections')) {
      const section = sectionSnapshot.item as { sectionId: string; title: CordisXLocalizedText; description?: CordisXLocalizedText }
      const panel = create(this.document, 'section', 'cordisx-env-section')
      const title = create(this.document, 'strong')
      title.textContent = this.text(sectionSnapshot, section.title, 'title', sites)
      panel.append(title)
      if (section.description !== undefined) {
        const description = create(this.document, 'p')
        description.textContent = this.text(sectionSnapshot, section.description, 'description', sites)
        panel.append(description)
      }
      for (const snapshot of snapshots.filter(item => item.surface === 'environment.section.actions' && (item.item as { sectionId: string }).sectionId === section.sectionId)) {
        panel.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'section-action', sites, 'shortcut'))
      }
      for (const rowSnapshot of snapshots.filter(item => item.surface === 'environment.section.rows' && (item.item as { sectionId: string }).sectionId === section.sectionId)) {
        const rowData = rowSnapshot.item as { rowId: string; label: CordisXLocalizedText; value?: CordisXLocalizedText | string | number | boolean | null; status?: string }
        const row = create(this.document, 'div', 'cordisx-env-row')
        const label = create(this.document, 'span')
        if (rowData.status !== undefined) label.append(createHostSurfaceIcon(this.document, rowData.status))
        const labelCopy = create(this.document, 'span')
        labelCopy.textContent = this.text(rowSnapshot, rowData.label, 'label', sites)
        label.append(labelCopy)
        row.append(label)
        if (rowData.value !== undefined) {
          const value = create(this.document, 'code')
          value.textContent = typeof rowData.value === 'object' && rowData.value !== null
            ? this.text(rowSnapshot, rowData.value, 'value', sites)
            : String(rowData.value)
          row.append(value)
        }
        for (const actionSnapshot of snapshots.filter(item => item.surface === 'environment.row.trailing-actions' && (item.item as { rowId: string }).rowId === rowData.rowId)) {
          row.append(this.button(actionSnapshot, actionSnapshot.item as CordisXStructuredAction, 'trailing', sites, 'shortcut'))
        }
        panel.append(row)
      }
      root.append(panel)
    }
  }
}

function installStyles(document: Document): () => void {
  const style = document.createElement('style')
  style.id = 'cordisx-structured-styles'
  style.textContent = `
    [data-cordisx-no-drag="true"] { -webkit-app-region: no-drag !important; }
    .cordisx-native-seat { box-sizing: border-box; color: inherit; font: inherit; pointer-events: auto; -webkit-app-region: no-drag; }
    .cordisx-native-seat[hidden] { display: none !important; }
    .cordisx-sidebar-navigation { display: block; width: 100%; min-width: 0; }
    .cordisx-sidebar-footer-before, .cordisx-sidebar-footer-after { display: flex; flex: 0 0 auto; height: 32px; align-items: center; gap: 4px; min-width: 0; }
    .cordisx-toolbar-before, .cordisx-toolbar-after { display: flex; flex: 0 0 auto; height: 28px; align-items: center; gap: 4px; min-width: 0; }
    .cordisx-environment { display: block; width: 100%; min-width: 0; padding: 6px; }
    .cordisx-navigation, .cordisx-env-section { display: grid; gap: 1px; }
    .cordisx-nav-row { display: grid; grid-template-columns: minmax(0,1fr) max-content; align-items: center; height: var(--height-token-row,30px); padding: 0 8px; border-radius: var(--radius-lg,10px); -webkit-app-region: no-drag; }
    .cordisx-nav-row:hover { background: var(--color-background-primary-ghost-hover,rgba(255,255,255,.078)); }
    .cordisx-nav-primary { display: grid; grid-template-columns: 16px minmax(0,1fr); align-items: center; gap: 8px; height: 100%; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: 445 13px/18px system-ui,sans-serif; text-align: left; cursor: default; }
    .cordisx-nav-primary:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: -2px; border-radius: var(--radius-lg,10px); }
    .cordisx-nav-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-nav-actions { display: flex; align-items: center; gap: 2px; }
    .cordisx-env-row, .cordisx-env-header { display: flex; align-items: center; gap: 5px; }
    .cordisx-env-header { justify-content: flex-end; }
    .cordisx-action:not(.cordisx-native-icon-action) { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; border: 1px solid transparent; border-radius: var(--radius-lg,10px); background: transparent; color: inherit; cursor: default; padding: 4px 7px; font: inherit; white-space: nowrap; user-select: none; -webkit-user-select: none; -webkit-app-region: no-drag; }
    .cordisx-native-icon-action { flex: 0 0 auto; -webkit-app-region: no-drag; }
    .cordisx-shortcut-action:not([class*="size-"]):not([class*="h-"]) { display: inline-flex; width: 24px; min-width: 24px; height: 24px; min-height: 24px; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius-lg,8px); background: transparent; color: var(--color-text-tertiary,rgba(255,255,255,.5)); }
    .cordisx-host-icon { display: inline-flex; flex: 0 0 auto; width: 20px; height: 20px; align-items: center; justify-content: center; line-height: 0; pointer-events: none; user-select: none; -webkit-user-select: none; }
    .cordisx-host-icon svg { display: block; width: 20px; height: 20px; fill: currentColor; pointer-events: none; }
    .cordisx-nav-primary > .cordisx-host-icon { width: 16px; height: 16px; }
    .cordisx-nav-primary > .cordisx-host-icon svg, .cordisx-shortcut-action .cordisx-host-icon, .cordisx-shortcut-action .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-native-menu-root { display: contents; }
    .cordisx-native-menu-item { -webkit-app-region: no-drag; }
    .cordisx-native-menu-row { display: flex; width: 100%; align-items: center; gap: 6px; }
    .cordisx-native-menu-row > .cordisx-host-icon { flex: 0 0 auto; opacity: .75; }
    .cordisx-native-menu-item:hover .cordisx-host-icon, .cordisx-native-menu-item:focus .cordisx-host-icon { opacity: 1; }
    .cordisx-native-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-env-section { margin-top: 6px; padding: 7px; border-radius: 8px; background: rgba(255,255,255,.04); }
    .cordisx-env-section p { margin: 3px 0; opacity: .68; font-size: 10px; }
    .cordisx-env-row { justify-content: space-between; }
  `
  ;(document.head ?? document.documentElement).append(style)
  return () => style.remove()
}

export interface CodexAdapterHandle {
  dispose(): void
}

export function installCodexAdapter(
  document: Document,
  slots: CordisXSlotService,
  commands: CordisXCommandService,
  routes: CordisXRouteService,
  i18n: CordisXI18nService,
  extensionPoints: ExtensionPointDescriptorRegistry,
): CodexAdapterHandle {
  const unregisterExtensionPoints = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  let lastProjectKey: string | undefined
  const app = new DomOutletController(document, 'app', 'fixed', () => {
    if (document.body === null) return undefined
    return { anchor: document.body, contextKey: 'renderer', pageChromeSafeLeft: titlebarTrafficLightInset(document) }
  })
  const main = new DomOutletController(document, 'main', 'portal', () => {
    const anchor = uniqueVisible(document, '[data-app-shell-main-content-layout="thread-edge-scroll"]')
      ?? uniqueVisible(document, '[data-app-shell-main-content-layout]')
    if (anchor === undefined) return undefined
    const selected = uniqueVisible(document, '[data-app-action-sidebar-thread-selected="true"]')
    const project = selected?.closest('[data-app-action-sidebar-project-list-id]')?.getAttribute('data-app-action-sidebar-project-list-id')
    if (project !== null && project !== undefined) lastProjectKey = project
    return { anchor, contextKey: `main:${lastProjectKey ?? 'default'}` }
  })
  const session = new DomOutletController(document, 'session.content', 'absolute', () => {
    const sessionId = currentSessionId(document)
    const anchor = sessionId === undefined ? undefined : sessionContentAnchor(document, sessionId)
    if (anchor === undefined || sessionId === undefined) return undefined
    return { anchor, contextKey: `session:${sessionId}`, nativeSessionId: sessionId }
  })
  const undeclare = [
    routes.outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, app, path => path !== '/main' && !path.startsWith('/main/') && path !== '/sessions' && !path.startsWith('/sessions/')),
    routes.outlets.declare({
      schemaVersion: 1, id: 'main', authority: 'host-adapter', scope: 'main', preferredPlacement: 'portal', contextPolicy: 'semantic',
    }, main, path => path.startsWith('/main/') && path.length > '/main/'.length),
    routes.outlets.declare({
      schemaVersion: 1, id: 'session.content', authority: 'host-adapter', scope: 'session', preferredPlacement: 'absolute', contextPolicy: 'semantic',
    }, session, path => path.startsWith('/sessions/:sessionId/') && path.length > '/sessions/:sessionId/'.length),
  ]
  const removeStyles = installStyles(document)
  const surfaces = new StructuredSurfaceRenderer(document, slots, commands, routes, i18n)
  return {
    dispose() {
      surfaces.dispose()
      removeStyles()
      for (const dispose of undeclare.reverse()) dispose()
      session.dispose()
      main.dispose()
      app.dispose()
      unregisterExtensionPoints()
    },
  }
}
