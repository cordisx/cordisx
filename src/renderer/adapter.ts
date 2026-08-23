import type { CordisXLocalizedText, CordisXStructuredAction, CordisXSurfaceName } from '../contracts.js'
import type { CordisXCommandService } from './commands.js'
import type { CordisXI18nService } from './i18n.js'
import type { CordisXRouteService, OutletController, OutletHostSnapshot, OutletPlacement } from './navigation.js'
import type { CordisXSlotService, SurfaceContributionSnapshot } from './surfaces.js'
import { evaluateWhen } from './validation.js'

interface ResolvedOutletAnchor {
  readonly anchor: HTMLElement
  readonly contextKey: string
  readonly nativeSessionId?: string
}

type OutletResolver = () => ResolvedOutletAnchor | undefined

function visible(element: Element): element is HTMLElement {
  const ElementClass = element.ownerDocument.defaultView?.HTMLElement
  return ElementClass !== undefined && element instanceof ElementClass
    && (element.getClientRects().length > 0 || element.ownerDocument.defaultView === null)
}

function uniqueVisible(document: Document, selector: string): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll(selector)].filter(visible)
  return candidates.length === 1 ? candidates[0] : undefined
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
    const isApp = this.outletId === 'app'
    const hostPosition = this.document.defaultView?.getComputedStyle(resolved.anchor).position
    const positioned = isApp || (hostPosition !== undefined && hostPosition !== '' && hostPosition !== 'static')
    const placement: OutletPlacement = isApp ? 'fixed' : positioned ? 'absolute' : 'portal'
    if (placement === 'portal') {
      if (this.layer.parentElement !== this.document.body) this.document.body.append(this.layer)
      this.installGeometryObserver(resolved.anchor)
      this.projectGeometry(resolved.anchor)
    } else {
      this.resizeObserver?.disconnect()
      this.resizeObserver = undefined
      if (this.layer.parentElement !== resolved.anchor) resolved.anchor.append(this.layer)
      Object.assign(this.layer.style, isApp
        ? { position: 'fixed', inset: '0', left: '', top: '', width: '', height: '' }
        : { position: 'absolute', inset: '0', left: '', top: '', width: '', height: '' })
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
    this.resizeObserver = new Observer(() => this.projectGeometry(anchor))
    this.resizeObserver.observe(anchor)
  }

  private projectGeometry(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect()
    Object.assign(this.layer.style, {
      position: 'fixed',
      inset: 'auto',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
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

const ICON_TEXT: Readonly<Record<string, string>> = {
  'host:analytics': '⌁', 'host:back': '←', 'host:close': '×', 'host:error': '!', 'host:files': '▤',
  'host:history': '↶', 'host:info': 'i', 'host:layers': '◇', 'host:more': '•••', 'host:open': '↗',
  'host:refresh': '↻', 'host:review': '✓', 'host:settings': '⚙', 'host:success': '●', 'host:warning': '△',
}

function create(document: Document, tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  return element
}

class StructuredSurfaceRenderer {
  private readonly roots = new Map<string, HTMLElement>()
  private readonly sites = new Set<string>()
  private readonly observer?: MutationObserver
  private readonly unsubscribers: (() => void)[]
  private scheduled = false
  private disposed = false

  constructor(
    private readonly document: Document,
    private readonly slots: CordisXSlotService,
    private readonly commands: CordisXCommandService,
    private readonly routes: CordisXRouteService,
    private readonly i18n: CordisXI18nService,
  ) {
    this.unsubscribers = [
      slots.subscribeInternal(() => this.schedule()),
      commands.subscribeInternal(() => this.schedule()),
      routes.subscribeInternal(() => this.schedule()),
      i18n.subscribeInternal(() => this.schedule()),
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
        if (nativeMutation) this.schedule()
      })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    this.schedule()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    for (const root of this.roots.values()) root.remove()
    this.roots.clear()
    for (const site of this.sites) {
      const [owner, ...rest] = site.split('\u0000')
      this.i18n.clearDiagnosticSite(owner!, rest.join('\u0000'))
    }
    this.sites.clear()
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.render()
    })
  }

  private render(): void {
    const snapshots = this.slots.snapshot()
    const nextSites = new Set<string>()
    const sidebar = uniqueVisible(this.document, '[data-app-action-sidebar-scroll]')
    const toolbar = uniqueVisible(this.document, 'header[data-app-shell-application-menu-bar]')
    const environment = uniqueVisible(this.document, '[data-pip-home-surface="thread-summary-panel"]')
      ?? uniqueVisible(this.document, '[data-app-shell-focus-area="right-panel"]')
    const sessionId = currentSessionId(this.document)
    const contextValues = {
      'sidebar.visible': sidebar !== undefined,
      'toolbar.visible': toolbar !== undefined,
      'environment.visible': environment !== undefined,
      ...(sessionId === undefined ? {} : { 'session.active': sessionId }),
    }
    this.slots.contexts.replace(contextValues)
    this.routes.contexts.replace(contextValues)
    this.slots.registry.setToolbarAnchors(toolbar === undefined ? [] : ['workspace.primary'])
    this.renderGroup('sidebar', sidebar, snapshots.filter(item => item.surface.startsWith('sidebar.')), nextSites)
    this.renderGroup('toolbar', toolbar, snapshots.filter(item => item.surface.startsWith('workspace.')), nextSites)
    this.renderGroup('environment', environment, snapshots.filter(item => item.surface.startsWith('environment.')), nextSites)
    for (const snapshot of snapshots) {
      const rendered = snapshot.visible && snapshot.valid && !snapshot.pending
        && ((snapshot.surface.startsWith('sidebar.') && sidebar !== undefined)
          || (snapshot.surface.startsWith('workspace.') && toolbar !== undefined)
          || (snapshot.surface.startsWith('environment.') && environment !== undefined))
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

  private renderGroup(
    group: string,
    anchor: HTMLElement | undefined,
    snapshots: readonly SurfaceContributionSnapshot[],
    nextSites: Set<string>,
  ): void {
    const existing = this.roots.get(group)
    if (anchor === undefined) {
      existing?.remove()
      return
    }
    const root = existing ?? create(this.document, 'section', `cordisx-structured cordisx-${group}`)
    this.roots.set(group, root)
    root.dataset.cordisxSurfaceHost = group
    if (root.parentElement !== this.document.body) this.document.body.append(root)
    this.positionRoot(group, root, anchor)
    root.replaceChildren()
    const active = snapshots.filter(item => item.visible && item.valid && !item.pending)
    if (active.length === 0) {
      root.hidden = true
      return
    }
    root.hidden = false
    if (group === 'sidebar') this.renderSidebar(root, active, nextSites)
    if (group === 'toolbar') this.renderToolbar(root, active, nextSites)
    if (group === 'environment') this.renderEnvironment(root, active, nextSites)
  }

  private positionRoot(group: string, root: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect()
    Object.assign(root.style, {
      position: 'fixed', zIndex: '2147483100', boxSizing: 'border-box', color: 'inherit',
      font: '12px/1.35 ui-sans-serif, system-ui, sans-serif', pointerEvents: 'auto',
    })
    if (group === 'sidebar') Object.assign(root.style, { left: `${rect.left + 8}px`, top: `${Math.max(rect.top + 60, rect.bottom - 220)}px`, width: `${Math.max(180, rect.width - 16)}px` })
    if (group === 'toolbar') Object.assign(root.style, { left: `${Math.max(rect.left + 8, rect.right - 430)}px`, top: `${rect.top + 7}px`, width: '360px' })
    if (group === 'environment') Object.assign(root.style, { left: `${Math.max(rect.left + 8, rect.right - 330)}px`, top: `${Math.max(rect.top + 52, rect.bottom - 270)}px`, width: '310px' })
  }

  private text(snapshot: SurfaceContributionSnapshot, value: CordisXLocalizedText, path: string, nextSites: Set<string>): string {
    const site = `surface:${snapshot.surface}:${snapshot.qualifiedId}:${path}`
    nextSites.add(`${snapshot.owner}\u0000${site}`)
    return this.i18n.resolveFor(snapshot.owner, value, site).text
  }

  private button(snapshot: SurfaceContributionSnapshot, action: CordisXStructuredAction, path: string, nextSites: Set<string>): HTMLButtonElement {
    const button = this.document.createElement('button')
    button.type = 'button'
    button.className = 'cordisx-action'
    button.textContent = `${action.icon === undefined ? '' : `${ICON_TEXT[action.icon] ?? '·'} `}${this.text(snapshot, action.label, `${path}.label`, nextSites)}`
    const command = this.commands.snapshot().find(item => item.qualifiedId === (action.command.id.includes(':') ? action.command.id : `${snapshot.owner}:${action.command.id}`))
    const actionState = action as CordisXStructuredAction & { when?: Parameters<typeof evaluateWhen>[0]; disabled?: { value: boolean; reason?: CordisXLocalizedText } }
    button.hidden = !evaluateWhen(actionState.when, this.slots.contexts.getSnapshot())
    button.disabled = snapshot.disabled || actionState.disabled?.value === true || (command?.running ?? 0) > 0
    const reason = actionState.disabled?.reason
    if (button.disabled && reason !== undefined) button.title = this.text(snapshot, reason, `${path}.disabled`, nextSites)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.commands.executeFor(snapshot.owner, action.command, `${snapshot.surface}:${snapshot.qualifiedId}:${path}`).catch(error => {
        button.dataset.error = error instanceof Error ? error.message : String(error)
        this.schedule()
      })
    })
    return button
  }

  private renderSidebar(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>): void {
    const navigation = create(this.document, 'div', 'cordisx-navigation')
    for (const snapshot of snapshots.filter(item => item.surface === 'sidebar.navigation.items')) {
      const item = snapshot.item as { label: CordisXLocalizedText; description?: CordisXLocalizedText; icon?: string; command?: { id: string; arguments?: never }; route?: { id: string; params?: never }; actions?: readonly (CordisXStructuredAction & { id: string })[] }
      const row = create(this.document, 'div', 'cordisx-nav-row')
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      const copy = create(this.document, 'span', 'cordisx-nav-copy')
      copy.textContent = `${item.icon === undefined ? '' : `${ICON_TEXT[item.icon] ?? '·'} `}${this.text(snapshot, item.label, 'label', sites)}`
      if (item.description !== undefined) copy.title = this.text(snapshot, item.description, 'description', sites)
      const activate = (): void => {
        const operation = item.command !== undefined
          ? this.commands.executeFor(snapshot.owner, item.command, `nav:${snapshot.qualifiedId}`)
          : item.route === undefined ? Promise.reject(new Error('navigation item has no activation')) : this.routes.navigateFor(snapshot.owner, item.route)
        void operation.catch(error => { row.dataset.error = error instanceof Error ? error.message : String(error); this.schedule() })
      }
      row.addEventListener('click', activate)
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } })
      row.append(copy)
      const actions = create(this.document, 'span', 'cordisx-nav-actions')
      for (const [index, action] of (item.actions ?? []).entries()) actions.append(this.button(snapshot, action, `actions.${index}`, sites))
      row.append(actions)
      navigation.append(row)
    }
    root.append(navigation)
    const footer = create(this.document, 'div', 'cordisx-footer')
    for (const surface of ['sidebar.footer.before-control', 'sidebar.footer.after-control'] as const) {
      for (const snapshot of snapshots.filter(item => item.surface === surface)) footer.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'action', sites))
    }
    const menuItems = snapshots.filter(item => item.surface === 'sidebar.footer.menu')
    if (menuItems.length > 0) {
      const details = this.document.createElement('details')
      const summary = this.document.createElement('summary')
      summary.textContent = ICON_TEXT['host:more'] ?? '•••'
      summary.setAttribute('aria-label', 'CordisX menu')
      const menu = create(this.document, 'div', 'cordisx-menu')
      menu.setAttribute('role', 'menu')
      for (const snapshot of menuItems) menu.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'menu', sites))
      details.append(summary, menu)
      footer.append(details)
    }
    root.append(footer)
  }

  private renderToolbar(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>): void {
    const bar = create(this.document, 'div', 'cordisx-toolbar')
    for (const placement of ['before', 'after'] as const) {
      for (const snapshot of snapshots.filter(item => (item.item as { placement: string }).placement === placement)) {
        bar.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, placement, sites))
      }
    }
    const menus = snapshots.filter(item => (item.item as { placement: string }).placement === 'menu')
    if (menus.length > 0) {
      const details = this.document.createElement('details')
      const summary = this.document.createElement('summary')
      summary.textContent = 'CX'
      const menu = create(this.document, 'div', 'cordisx-menu')
      for (const snapshot of menus) menu.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'menu', sites))
      details.append(summary, menu)
      bar.append(details)
    }
    root.append(bar)
  }

  private renderEnvironment(root: HTMLElement, snapshots: readonly SurfaceContributionSnapshot[], sites: Set<string>): void {
    const header = create(this.document, 'div', 'cordisx-env-header')
    header.append(create(this.document, 'strong'))
    header.firstElementChild!.textContent = 'CordisX'
    for (const snapshot of snapshots.filter(item => item.surface === 'environment.panel.header-actions')) header.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'header', sites))
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
        panel.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, 'section-action', sites))
      }
      for (const rowSnapshot of snapshots.filter(item => item.surface === 'environment.section.rows' && (item.item as { sectionId: string }).sectionId === section.sectionId)) {
        const rowData = rowSnapshot.item as { rowId: string; label: CordisXLocalizedText; value?: CordisXLocalizedText | string | number | boolean | null; status?: string }
        const row = create(this.document, 'div', 'cordisx-env-row')
        const label = create(this.document, 'span')
        label.textContent = `${rowData.status === undefined ? '' : `${ICON_TEXT[rowData.status] ?? '·'} `}${this.text(rowSnapshot, rowData.label, 'label', sites)}`
        row.append(label)
        if (rowData.value !== undefined) {
          const value = create(this.document, 'code')
          value.textContent = typeof rowData.value === 'object' && rowData.value !== null
            ? this.text(rowSnapshot, rowData.value, 'value', sites)
            : String(rowData.value)
          row.append(value)
        }
        for (const actionSnapshot of snapshots.filter(item => item.surface === 'environment.row.trailing-actions' && (item.item as { rowId: string }).rowId === rowData.rowId)) {
          row.append(this.button(actionSnapshot, actionSnapshot.item as CordisXStructuredAction, 'trailing', sites))
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
    .cordisx-structured { border: 1px solid color-mix(in srgb, #8b5cf6 45%, transparent); border-radius: 12px; background: color-mix(in srgb, #17141f 94%, transparent); box-shadow: 0 12px 40px rgba(0,0,0,.3); padding: 6px; }
    .cordisx-navigation, .cordisx-env-section { display: grid; gap: 5px; }
    .cordisx-nav-row, .cordisx-env-row, .cordisx-env-header, .cordisx-footer, .cordisx-toolbar { display: flex; align-items: center; gap: 5px; }
    .cordisx-nav-row { justify-content: space-between; padding: 6px; border-radius: 8px; cursor: pointer; }
    .cordisx-nav-row:hover { background: rgba(139,92,246,.16); }
    .cordisx-nav-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-footer, .cordisx-toolbar, .cordisx-env-header { justify-content: flex-end; }
    .cordisx-action, .cordisx-structured summary { min-height: 27px; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; background: rgba(255,255,255,.06); color: inherit; cursor: pointer; padding: 4px 7px; font: inherit; }
    .cordisx-action:disabled { opacity: .48; cursor: wait; }
    .cordisx-menu { position: absolute; right: 4px; display: grid; gap: 4px; min-width: 170px; padding: 6px; border: 1px solid rgba(255,255,255,.16); border-radius: 9px; background: #17141f; box-shadow: 0 14px 36px rgba(0,0,0,.4); }
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
): CodexAdapterHandle {
  let lastProjectKey: string | undefined
  const app = new DomOutletController(document, 'app', 'fixed', () => {
    return document.body === null ? undefined : { anchor: document.body, contextKey: 'renderer' }
  })
  const main = new DomOutletController(document, 'main', 'absolute', () => {
    const anchor = uniqueVisible(document, '[data-app-shell-main-content-layout="thread-edge-scroll"]')
      ?? uniqueVisible(document, '[data-app-shell-main-content-layout]')
    if (anchor === undefined) return undefined
    const selected = uniqueVisible(document, '[data-app-action-sidebar-thread-selected="true"]')
    const project = selected?.closest('[data-app-action-sidebar-project-list-id]')?.getAttribute('data-app-action-sidebar-project-list-id')
    if (project !== null && project !== undefined) lastProjectKey = project
    return { anchor, contextKey: `main:${lastProjectKey ?? 'default'}` }
  })
  const session = new DomOutletController(document, 'session.content', 'absolute', () => {
    const anchor = uniqueVisible(document, '[data-codex-thread-reference-drop-target]')
    const sessionId = currentSessionId(document)
    if (anchor === undefined || sessionId === undefined) return undefined
    return { anchor, contextKey: `session:${sessionId}`, nativeSessionId: sessionId }
  })
  const undeclare = [
    routes.outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, app, path => path !== '/main' && !path.startsWith('/main/') && path !== '/sessions' && !path.startsWith('/sessions/')),
    routes.outlets.declare({
      schemaVersion: 1, id: 'main', authority: 'host-adapter', scope: 'main', preferredPlacement: 'absolute', contextPolicy: 'semantic',
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
    },
  }
}
