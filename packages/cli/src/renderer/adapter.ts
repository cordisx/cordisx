import {
  CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
  type CordisXLocalizedText,
  type CordisXReasoningIntensityPresentation,
  type CordisXRouteReference,
  type CordisXStructuredAction,
  type CordisXSurfaceInvocationContextV1,
  type CordisXSurfaceName,
} from '../contracts.js'
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

function strictlyVisible(element: Element): element is HTMLElement {
  if (!visible(element)) return false
  const rect = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (rect.width <= 0 || rect.height <= 0 || view === null) return false
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) return false
  const style = view.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function uniqueStrictlyVisible(document: Document, selector: string): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll(selector)].filter(strictlyVisible)
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

function pageChromeSafeLeft(document: Document, anchor: HTMLElement): number {
  const anchorLeft = Math.max(0, anchor.getBoundingClientRect().left)
  return Math.max(0, titlebarTrafficLightInset(document) - anchorLeft)
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
  const selected = selectedSessionId(document)
  if (selected === undefined) return undefined
  const observed = [
    uniqueAttribute(document, '[data-response-annotation-conversation]', 'data-response-annotation-conversation'),
    uniqueAttribute(document, '[data-above-composer-conversation-id]', 'data-above-composer-conversation-id'),
  ].filter((value): value is string => value !== undefined)
  if (observed.length === 0 || observed.some(value => value !== selected)) return undefined
  return selected
}

function matchingSessionContentAnchors(document: Document, selector: string, sessionId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(visible)
    .filter((candidate) => {
      const response = [...candidate.querySelectorAll('[data-response-annotation-conversation]')]
        .some(element => element.getAttribute('data-response-annotation-conversation') === sessionId)
      const composer = [...candidate.querySelectorAll('[data-above-composer-conversation-id]')]
        .some(element => element.getAttribute('data-above-composer-conversation-id') === sessionId)
      return response && composer
    })
}

function sessionContentAnchor(document: Document, sessionId: string): HTMLElement | undefined {
  const current = matchingSessionContentAnchors(
    document,
    '[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]',
    sessionId,
  )
  if (current.length > 0) return current.length === 1 ? current[0] : undefined
  const legacy = matchingSessionContentAnchors(
    document,
    '[data-codex-thread-reference-drop-target]',
    sessionId,
  )
  return legacy.length === 1 ? legacy[0] : undefined
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

interface NativeActionSeat extends NativeSurfaceSeat {
  readonly template: HTMLButtonElement
}

type NativeActionPattern = 'toolbar' | 'footer' | 'shortcut' | 'composer'

export function partitionDirectActions<Item>(items: readonly Item[], directLimit: number): Readonly<{
  direct: readonly Item[]
  overflow: readonly Item[]
}> {
  const limit = Math.max(0, Math.floor(directLimit))
  return Object.freeze({ direct: items.slice(0, limit), overflow: items.slice(limit) })
}

function resolveSessionHeaderSeat(document: Document, sessionId: string | undefined): NativeActionSeat | undefined {
  if (sessionId === undefined) return undefined
  const surface = uniqueStrictlyVisible(document, '[data-testid="app-shell-header-context-menu-surface"]')
  if (surface === undefined) return undefined
  const template = nativeButtons(surface).at(-1)
  if (template === undefined) return undefined
  const anchor = nativeControlInsertionAnchor(document, template)
  const parent = anchor.parentElement
  if (parent === null || !surface.contains(parent)) return undefined
  return {
    key: 'session.header.actions',
    parent,
    before: anchor,
    className: 'cordisx-session-header-actions',
    template,
  }
}

function resolveComposerSubmitSeat(document: Document, sessionId: string | undefined): NativeActionSeat | undefined {
  if (sessionId === undefined) return undefined
  const roots = [...document.querySelectorAll<HTMLElement>('[data-codex-composer-root][data-composer-placement]')]
    .filter(strictlyVisible)
    .filter(root => [...root.querySelectorAll('[data-above-composer-conversation-id]')]
      .some(marker => marker.getAttribute('data-above-composer-conversation-id') === sessionId))
  if (roots.length !== 1) return undefined
  const footers = [...roots[0]!.querySelectorAll<HTMLElement>('[data-composer-footer-responsive]')].filter(strictlyVisible)
  if (footers.length !== 1) return undefined
  const footer = footers[0]!
  const template = nativeButtons(footer).at(-1)
  if (template === undefined) return undefined
  const anchor = nativeControlInsertionAnchor(document, template)
  const parent = anchor.parentElement
  if (parent === null || !footer.contains(parent)) return undefined
  return {
    key: 'composer.submit.before',
    parent,
    before: anchor,
    className: 'cordisx-composer-submit-before',
    template,
  }
}

function resolveReasoningIntensityRange(document: Document, sessionId: string | undefined): HTMLInputElement | undefined {
  if (sessionId === undefined) return undefined
  const Input = document.defaultView?.HTMLInputElement
  if (Input === undefined) return undefined
  const candidates = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    .filter((candidate): candidate is HTMLInputElement => candidate instanceof Input && strictlyVisible(candidate))
    .filter(candidate => candidate.dataset.cordisxReasoningNative !== 'true')
    .filter((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.width >= 120 && rect.height <= 96 && Number.isFinite(candidate.valueAsNumber)
    })
  return candidates.length === 1 ? candidates[0] : undefined
}

/** @internal Host-owned projection used by the Codex adapter and focused renderer tests. */
export class ReasoningIntensityProjection {
  private readonly root: HTMLElement
  private readonly fill: HTMLElement
  private readonly thumb: HTMLElement
  private readonly ticks: HTMLElement
  private readonly particles: HTMLElement
  private native: HTMLInputElement | undefined
  private nativeOpacity = ''
  private nativeAccentColor = ''
  private resizeObserver: ResizeObserver | undefined
  private dragging = false
  private pointerX = 0
  private presentation: CordisXReasoningIntensityPresentation | undefined
  private title = ''
  private labels: readonly string[] = []

  constructor(private readonly document: Document) {
    this.root = create(document, 'div', 'cordisx-reasoning-intensity')
    this.root.dataset.cordisxSurfaceHost = 'composer.reasoning-intensity'
    this.root.dataset.cordisxNoDrag = 'true'
    this.root.setAttribute('aria-hidden', 'true')
    this.fill = create(document, 'span', 'cordisx-reasoning-fill')
    this.ticks = create(document, 'span', 'cordisx-reasoning-ticks')
    this.particles = create(document, 'span', 'cordisx-reasoning-particles')
    this.thumb = create(document, 'span', 'cordisx-reasoning-thumb')
    this.thumb.append(create(document, 'i'), create(document, 'i'))
    for (let index = 0; index < 14; index += 1) {
      const particle = create(document, 'i')
      particle.style.setProperty('--particle-index', String(index))
      particle.style.setProperty('--particle-y', `${12 + ((index * 37) % 76)}%`)
      particle.style.setProperty('--particle-delay', `${-((index * 173) % 1100)}ms`)
      this.particles.append(particle)
    }
    this.root.append(this.fill, this.ticks, this.particles, this.thumb)
    Object.assign(this.root.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483190' })
    ;(document.body ?? document.documentElement).append(this.root)
  }

  update(
    native: HTMLInputElement,
    presentation: CordisXReasoningIntensityPresentation,
    title: string,
    stageLabels: readonly string[],
  ): void {
    if (this.native !== native) this.connect(native)
    this.presentation = presentation
    this.title = title
    this.labels = stageLabels
    this.root.dataset.motion = presentation.motion ?? 'smooth'
    this.ticks.replaceChildren(...presentation.stages.map(() => create(this.document, 'i')))
    this.sync(presentation, title, stageLabels)
    this.align()
  }

  dispose(): void {
    this.disconnect()
    this.root.remove()
  }

  private readonly onInput = (): void => {
    if (this.presentation !== undefined) this.sync(this.presentation, this.title, this.labels)
  }
  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerX = event.clientX
    this.dragging = false
  }
  private readonly onPointerMove = (event: PointerEvent): void => {
    if ((event.buttons & 1) === 0 || Math.abs(event.clientX - this.pointerX) < 4) return
    this.dragging = true
    this.root.dataset.dragging = 'true'
  }
  private readonly onPointerUp = (): void => {
    this.dragging = false
    delete this.root.dataset.dragging
  }
  private readonly align = (): void => {
    if (this.native === undefined || !this.native.isConnected) return
    const rect = this.native.getBoundingClientRect()
    Object.assign(this.root.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
  }

  private connect(native: HTMLInputElement): void {
    this.disconnect()
    this.native = native
    this.nativeOpacity = native.style.opacity
    this.nativeAccentColor = native.style.accentColor
    native.dataset.cordisxReasoningNative = 'true'
    native.style.opacity = '0'
    native.style.accentColor = 'transparent'
    native.addEventListener('input', this.onInput)
    native.addEventListener('change', this.onInput)
    native.addEventListener('pointerdown', this.onPointerDown)
    native.addEventListener('pointermove', this.onPointerMove)
    native.addEventListener('pointerup', this.onPointerUp)
    const Resize = this.document.defaultView?.ResizeObserver
    if (Resize !== undefined) {
      this.resizeObserver = new Resize(this.align)
      this.resizeObserver.observe(native)
    }
    this.document.defaultView?.addEventListener('resize', this.align)
    this.document.defaultView?.addEventListener('scroll', this.align, true)
  }

  private disconnect(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    this.document.defaultView?.removeEventListener('resize', this.align)
    this.document.defaultView?.removeEventListener('scroll', this.align, true)
    if (this.native === undefined) return
    this.native.removeEventListener('input', this.onInput)
    this.native.removeEventListener('change', this.onInput)
    this.native.removeEventListener('pointerdown', this.onPointerDown)
    this.native.removeEventListener('pointermove', this.onPointerMove)
    this.native.removeEventListener('pointerup', this.onPointerUp)
    this.native.style.opacity = this.nativeOpacity
    this.native.style.accentColor = this.nativeAccentColor
    delete this.native.dataset.cordisxReasoningNative
    this.native = undefined
  }

  private sync(presentation: CordisXReasoningIntensityPresentation, title: string, stageLabels: readonly string[]): void {
    if (this.native === undefined) return
    this.root.dataset.title = title
    const min = Number(this.native.min || 0)
    const max = Number(this.native.max || 100)
    const value = Number.isFinite(this.native.valueAsNumber) ? this.native.valueAsNumber : Number(this.native.value)
    const progress = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
    const index = Math.round(progress * (presentation.stages.length - 1))
    const stage = presentation.stages[index] ?? presentation.stages[0]!
    const label = stageLabels[index] ?? title
    this.root.dataset.material = stage.material
    this.root.title = `${title}: ${label}`
    this.root.style.setProperty('--cordisx-reasoning-progress', `${progress * 100}%`)
    this.fill.style.width = `${progress * 100}%`
    this.thumb.style.left = `${progress * 100}%`
    this.root.dataset.peak = index === presentation.stages.length - 1 ? 'true' : 'false'
  }
}

function nativeToolbarCornerRadius(template: HTMLButtonElement): string {
  const style = template.ownerDocument.defaultView?.getComputedStyle(template)
  const radius = (style?.borderTopLeftRadius || style?.borderRadius || '').trim()
  return radius === '' ? '8px' : radius
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
  private nextContext = 0
  private readonly routeProjectors = new Map<HTMLButtonElement, () => void>()
  private reasoningProjection: ReasoningIntensityProjection | undefined

  constructor(
    private readonly document: Document,
    private readonly slots: CordisXSlotService,
    private readonly commands: CordisXCommandService,
    private readonly routes: CordisXRouteService,
    private readonly i18n: CordisXI18nService,
    private readonly adapterIdentity: Readonly<{
      generation: string
      adapterVersion: string
      hostId: string
    }>,
  ) {
    this.tooltips = new HostTooltipController(document)
    this.unsubscribers = [
      slots.subscribeInternal(() => this.schedule(true)),
      commands.subscribeInternal(() => this.schedule(true)),
      routes.subscribeInternal(() => this.schedule(false)),
      i18n.subscribeInternal(() => this.schedule(true)),
    ]
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer((records) => {
        const nativeMutation = records.some((record) => {
          const target = record.target.nodeType === 1
            ? record.target as Element
            : record.target.parentElement
          if (record.type === 'attributes' && target?.matches('[data-cordisx-manager-modal]') === true) return true
          return target?.closest('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]') === null
        })
        if (nativeMutation) this.schedule(false)
      })
      this.observer.observe(document.documentElement, {
        childList: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'data-app-action-sidebar-thread-selected'],
        subtree: true,
      })
    }
    this.schedule(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.restoreToolbarSlot()
    this.reasoningProjection?.dispose()
    this.reasoningProjection = undefined
    this.tooltips.dispose()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    for (const root of this.roots.values()) root.remove()
    this.roots.clear()
    this.routeProjectors.clear()
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
    const nextSites = new Set<string>()
    if (!rebuild) for (const site of this.sites) nextSites.add(site)
    const usedRoots = new Set<string>()
    const availableSurfaces = new Set<string>()
    const managerOverlay = [...this.document.querySelectorAll<HTMLElement>('[data-cordisx-manager-modal]')]
      .some(element => !element.hidden)
    const sidebar = managerOverlay ? undefined : uniqueVisible(this.document, '[data-app-action-sidebar-scroll]')
    const toolbar = managerOverlay ? undefined : uniqueVisible(this.document, 'header[data-app-shell-application-menu-bar]')
    const environmentCandidates = managerOverlay ? [] : [
      ...this.document.querySelectorAll<HTMLElement>('[data-pip-home-surface="thread-summary-panel"], [data-app-shell-focus-area="right-panel"]'),
    ].filter(strictlyVisible)
    const environment = managerOverlay ? undefined
      : uniqueStrictlyVisible(this.document, '[data-pip-home-surface="thread-summary-panel"]')
        ?? uniqueStrictlyVisible(this.document, '[data-app-shell-focus-area="right-panel"]')
    const sidebarNavigation = sidebar === undefined ? undefined : resolveSidebarNavigationParent(this.document, sidebar)
    const sidebarFooterControl = sidebar === undefined ? undefined : resolveSidebarFooterControl(this.document, sidebar)
    const accountControl = sidebar === undefined ? undefined : resolveAccountControl(sidebar)
    const toolbarControl = toolbar === undefined ? undefined : resolveToolbarControl(toolbar)
    const toolbarMenuControl = toolbar === undefined ? undefined : resolveToolbarMenuControl(toolbar)
    const sessionId = managerOverlay ? undefined : currentSessionId(this.document)
    const sessionHeaderSeat = resolveSessionHeaderSeat(this.document, sessionId)
    const composerSubmitSeat = resolveComposerSubmitSeat(this.document, sessionId)
    const reasoningRange = managerOverlay ? undefined : resolveReasoningIntensityRange(this.document, sessionId)
    const contextValues = {
      'sidebar.visible': sidebarNavigation !== undefined || sidebarFooterControl !== undefined,
      'toolbar.visible': toolbarControl !== undefined,
      'environment.visible': environment !== undefined,
      ...(sessionId === undefined ? {} : { 'session.active': sessionId }),
    }
    this.slots.contexts.replace(contextValues)
    this.routes.contexts.replace(contextValues)
    this.slots.registry.setToolbarAnchors(toolbarControl === undefined ? [] : ['workspace.primary'])
    this.slots.registry.setSurfaceAnchors('composer.toolbar.items', composerSubmitSeat === undefined ? [] : [{ id: 'submit', placements: ['before'] }])
    const contextDetail = (key: string, fallback: string) => ({ key: `runtime-context.${key}`, fallback })
    const sessionContextState = sessionId === undefined ? 'not-mounted' as const : 'inactive' as const
    const shellContextState = managerOverlay ? 'not-mounted' as const : 'inactive' as const
    const shellContextCode = managerOverlay ? 'context.not-mounted' : 'anchor.unresolved'
    const shellDetail = (key: string, label: string) => managerOverlay
      ? contextDetail(`${key}.not-mounted`, `The ${label} context is not mounted while CordisX Manager is open.`)
      : contextDetail(`${key}.unresolved`, `The ${label} anchor could not be resolved uniquely.`)
    const environmentState = environment !== undefined ? 'active' as const
      : environmentCandidates.length > 0 ? 'inactive' as const : 'not-mounted' as const
    this.slots.registry.setCurrentContext([
      { surface: 'sidebar.navigation.items', state: sidebarNavigation === undefined ? shellContextState : 'active', ...(sidebarNavigation === undefined ? { code: shellContextCode, detail: shellDetail('sidebar-navigation', 'sidebar navigation') } : {}) },
      { surface: 'sidebar.footer.before-control', state: sidebarFooterControl === undefined ? shellContextState : 'active', ...(sidebarFooterControl === undefined ? { code: shellContextCode, detail: shellDetail('sidebar-footer', 'sidebar footer') } : {}) },
      { surface: 'sidebar.footer.after-control', state: sidebarFooterControl === undefined ? shellContextState : 'active', ...(sidebarFooterControl === undefined ? { code: shellContextCode, detail: shellDetail('sidebar-footer', 'sidebar footer') } : {}) },
      { surface: 'sidebar.footer.menu', state: sidebarFooterControl === undefined ? shellContextState : 'active', ...(sidebarFooterControl === undefined ? { code: shellContextCode, detail: shellDetail('sidebar-footer-menu', 'sidebar footer menu') } : {}) },
      { surface: 'sidebar.account.menu', state: accountControl === undefined ? shellContextState : 'active', ...(accountControl === undefined ? { code: shellContextCode, detail: shellDetail('account-menu', 'account menu') } : {}) },
      { surface: 'workspace.toolbar.items', state: toolbarControl === undefined ? shellContextState : 'active', ...(toolbarControl === undefined ? { code: shellContextCode, detail: shellDetail('workspace-toolbar', 'workspace toolbar') } : {}) },
      { surface: 'session.header.actions', state: sessionHeaderSeat === undefined ? sessionContextState : 'active', ...(sessionHeaderSeat === undefined ? { code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved', detail: contextDetail(sessionId === undefined ? 'session-header.not-mounted' : 'session-header.unresolved', sessionId === undefined ? 'The session header is not mounted in the current page.' : 'The active session header anchor could not be resolved uniquely.') } : {}) },
      {
        surface: 'composer.toolbar.items', state: composerSubmitSeat === undefined ? sessionContextState : 'active',
        ...(composerSubmitSeat === undefined ? { code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved', detail: contextDetail(sessionId === undefined ? 'composer.not-mounted' : 'composer.unresolved', sessionId === undefined ? 'The composer is not mounted in the current page.' : 'The active session composer anchor could not be resolved uniquely.') } : {}),
        anchors: [
          { id: 'submit', placements: ['before'], state: composerSubmitSeat === undefined ? sessionContextState : 'active', ...(composerSubmitSeat === undefined ? { code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved', detail: contextDetail(sessionId === undefined ? 'composer-submit.not-mounted' : 'composer-submit.unresolved', sessionId === undefined ? 'The native submit control is not mounted in the current context.' : 'The native submit anchor could not be resolved uniquely.') } : {}) },
          { id: 'leading', placements: ['before', 'after'], state: 'not-mounted', code: 'anchor.not-mounted', detail: contextDetail('composer-leading.not-mounted', 'The leading anchor is not mounted by this adapter.') },
          { id: 'model', placements: ['before', 'after', 'menu'], state: 'not-mounted', code: 'anchor.not-mounted', detail: contextDetail('composer-model.not-mounted', 'The model anchor is not mounted by this adapter.') },
        ],
      },
      { surface: 'composer.reasoning-intensity', state: reasoningRange === undefined ? sessionContextState : 'active', ...(reasoningRange === undefined ? { code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved', detail: contextDetail(sessionId === undefined ? 'reasoning-intensity.not-mounted' : 'reasoning-intensity.unresolved', sessionId === undefined ? 'The native reasoning control is not mounted in the current page.' : 'The native reasoning range could not be resolved uniquely.') } : {}) },
      ...(['environment.panel.header-actions', 'environment.panel.sections', 'environment.section.actions', 'environment.section.rows', 'environment.row.trailing-actions'] as const)
        .map(surface => ({ surface, state: environmentState, ...(environment === undefined
          ? environmentCandidates.length > 0
            ? { code: 'anchor.unresolved', detail: contextDetail('environment.unresolved', 'The environment panel anchor could not be resolved uniquely.') }
            : { code: 'context.not-mounted', detail: contextDetail('environment.not-mounted', 'The environment panel context is not mounted.') }
          : {}) })),
    ])

    const snapshots = this.slots.snapshot()

    const active = snapshots.filter(item => item.visible && item.authorized && item.valid && !item.pending)
    let renderedReasoningId: string | undefined
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
        this.configureToolbarIconControlVariant(root, toolbarControl)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, beforeItems, nextSites, 'before', toolbarControl)
      }
      const afterItems = active.filter(item => item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'after')
      if (afterItems.length > 0) {
        const root = this.placeRoot({
          key: 'toolbar.after', parent, before: nextNativeSibling(toolbarAnchor), className: 'cordisx-toolbar-after',
        }, usedRoots)
        this.configureToolbarIconControlVariant(root, toolbarControl)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, afterItems, nextSites, 'after', toolbarControl)
      }
      const menuItems = active.filter(item => item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'menu')
      const menu = resolveOpenNativeMenu(this.document, toolbarMenuControl)
      if (menuItems.length > 0 && menu !== undefined && toolbarMenuControl !== undefined) {
        this.projectNativeMenu('toolbar.menu', menu, toolbarMenuControl, menuItems, nextSites, usedRoots, rebuild)
      }
    }
    this.reconcileToolbarSlot(toolbarControl, usedRoots)
    if (sessionHeaderSeat !== undefined) {
      availableSurfaces.add('session.header.actions')
      const items = active.filter(item => item.surface === 'session.header.actions')
      if (items.length > 0) {
        const root = this.placeRoot(sessionHeaderSeat, usedRoots)
        this.configureToolbarIconControlVariant(root, sessionHeaderSeat.template)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, items, nextSites, 'header', sessionHeaderSeat.template, 'toolbar', 3)
      }
    }
    if (composerSubmitSeat !== undefined) {
      availableSurfaces.add('composer.toolbar.items')
      const items = active.filter(item => item.surface === 'composer.toolbar.items'
        && (item.item as { anchor: string; placement: string }).anchor === 'submit'
        && (item.item as { anchor: string; placement: string }).placement === 'before')
      if (items.length > 0) {
        const root = this.placeRoot(composerSubmitSeat, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderActions(root, items, nextSites, 'submit.before', composerSubmitSeat.template, 'composer', 2, false)
      }
    }
    if (reasoningRange !== undefined) {
      availableSurfaces.add('composer.reasoning-intensity')
      const snapshot = active.find(item => item.surface === 'composer.reasoning-intensity')
      if (snapshot !== undefined) {
        const presentation = snapshot.item as CordisXReasoningIntensityPresentation
        const title = this.text(snapshot, presentation.title, 'title', nextSites)
        const labels = presentation.stages.map((stage, index) => this.text(snapshot, stage.label, `stages.${index}.label`, nextSites))
        this.reasoningProjection ??= new ReasoningIntensityProjection(this.document)
        this.reasoningProjection.update(reasoningRange, presentation, title, labels)
        renderedReasoningId = snapshot.qualifiedId
      } else {
        this.reasoningProjection?.dispose()
        this.reasoningProjection = undefined
      }
    } else {
      this.reasoningProjection?.dispose()
      this.reasoningProjection = undefined
    }
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
    for (const [button, project] of this.routeProjectors) {
      if (!button.isConnected) {
        this.routeProjectors.delete(button)
        continue
      }
      project()
    }
    for (const snapshot of snapshots) {
      const rendered = snapshot.visible && snapshot.authorized && snapshot.valid && !snapshot.pending
        && availableSurfaces.has(snapshot.surface)
        && (snapshot.surface !== 'composer.reasoning-intensity' || snapshot.qualifiedId === renderedReasoningId)
      const renderToken = this.slots.registry.renderToken(snapshot.surface, snapshot.qualifiedId)
      if (renderToken !== undefined) this.slots.registry.markRendered(snapshot.surface, snapshot.qualifiedId, renderToken, rendered)
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
    slot.style.width = `${Math.ceil(Math.max(originalWidth, originalMinimum) + contributionWidth)}px`
  }

  private configureToolbarIconControlVariant(root: HTMLElement, template: HTMLButtonElement): void {
    root.dataset.cordisxIconControlVariant = 'toolbar'
    root.style.setProperty('--cordisx-toolbar-action-corner-radius', nativeToolbarCornerRadius(template))
  }

  private text(snapshot: SurfaceContributionSnapshot, value: CordisXLocalizedText, path: string, nextSites: Set<string>): string {
    const site = `surface:${snapshot.surface}:${snapshot.qualifiedId}:${path}`
    nextSites.add(`${snapshot.owner}\u0000${site}`)
    return this.i18n.resolveFor(snapshot.owner, value, site).text
  }

  private invocationContext(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
  ): CordisXSurfaceInvocationContextV1 | undefined {
    if (action.command === undefined) return undefined
    const commandId = action.command.id.includes(':') ? action.command.id : `${snapshot.owner}:${action.command.id}`
    const sessionKey = currentSessionId(this.document)
    if ((snapshot.surface === 'session.header.actions' || snapshot.surface === 'composer.toolbar.items') && sessionKey === undefined) return undefined
    return {
      $schema: CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
      schemaVersion: 1,
      generation: this.adapterIdentity.generation,
      contextRef: `context-${this.adapterIdentity.generation}-${++this.nextContext}`,
      pointId: snapshot.surface,
      contributionId: snapshot.qualifiedId,
      commandId,
      provenance: 'observed',
      source: {
        kind: 'adapter',
        adapterId: 'codex',
        adapterVersion: this.adapterIdentity.adapterVersion,
        hostId: this.adapterIdentity.hostId,
      },
      identity: sessionKey === undefined ? {} : { agent: { sessionKey } },
    }
  }

  private contextualRouteReference(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
  ): CordisXRouteReference | undefined {
    if (action.route === undefined) return undefined
    const qualifiedId = action.route.id.includes(':') ? action.route.id : `${snapshot.owner}:${action.route.id}`
    const route = this.routes.snapshot().routes.find(candidate => candidate.qualifiedId === qualifiedId)
    const params = { ...(action.route.params ?? {}) }
    if (snapshot.surface === 'session.header.actions' && route?.definition.path.split('/').includes(':sessionId')) {
      const sessionId = currentSessionId(this.document)
      if (sessionId === undefined) return undefined
      params.sessionId = sessionId
    }
    return { id: action.route.id, ...(Object.keys(params).length === 0 ? {} : { params }) }
  }

  private button(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
    path: string,
    nextSites: Set<string>,
    nativePattern?: NativeActionPattern,
    nativeTemplate?: HTMLButtonElement,
    afterActivate?: () => void,
    reduceGlyph = true,
  ): HTMLButtonElement {
    const button = this.document.createElement('button')
    button.type = 'button'
    const nativeClasses = nativePattern === 'composer' || nativePattern === 'toolbar'
      ? ''
      : nativeTemplate?.className ?? ''
    button.draggable = false
    button.className = nativePattern === undefined
      ? 'cordisx-action'
      : `${nativeClasses} cordisx-action${reduceGlyph ? ' cordisx-icon-only-control' : ''} cordisx-native-icon-action cordisx-${nativePattern}-action`.trim()
    if (nativePattern !== undefined) button.dataset.cordisxIconControlVariant = nativePattern
    button.dataset.cordisxOwner = snapshot.owner
    button.dataset.cordisxSurface = snapshot.surface
    button.dataset.cordisxContributionId = snapshot.qualifiedId
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
    const commandId = action.command?.id
    const command = commandId === undefined ? undefined : this.commands.snapshot().find(item => item.qualifiedId === (commandId.includes(':') ? commandId : `${snapshot.owner}:${commandId}`))
    const actionState = action as CordisXStructuredAction & { when?: Parameters<typeof evaluateWhen>[0]; disabled?: { value: boolean; reason?: CordisXLocalizedText } }
    button.hidden = !evaluateWhen(actionState.when, this.slots.contexts.getSnapshot())
    button.disabled = snapshot.disabled || actionState.disabled?.value === true || (command?.running ?? 0) > 0
    const reason = actionState.disabled?.reason
    if (button.disabled && reason !== undefined) button.dataset.cordisxTooltip = this.text(snapshot, reason, `${path}.disabled`, nextSites)
    if (action.route !== undefined && action.routeBehavior === 'toggle') {
      const project = (): void => {
        const reference = this.contextualRouteReference(snapshot, action)
        const projection = reference === undefined
          ? { active: false, presented: false }
          : this.routes.routeProjection(snapshot.owner, reference)
        button.setAttribute('aria-pressed', String(projection.presented))
        button.dataset.cordisxRouteState = projection.presented ? 'presented' : projection.active ? 'active' : 'inactive'
      }
      this.routeProjectors.set(button, project)
      project()
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      afterActivate?.()
      const context = this.invocationContext(snapshot, action)
      const operation = action.command !== undefined
        ? (context === undefined && (snapshot.surface === 'session.header.actions' || snapshot.surface === 'composer.toolbar.items'))
          ? Promise.reject(new Error('active session identity is unavailable'))
          : this.commands.executeFor(snapshot.owner, action.command, `${snapshot.surface}:${snapshot.qualifiedId}:${path}`, {
            pointId: snapshot.surface,
            contributionId: snapshot.qualifiedId,
            ...(context === undefined ? {} : { context }),
          })
        : action.route !== undefined
          ? (() => {
              const reference = this.contextualRouteReference(snapshot, action)
              if (reference === undefined) return Promise.reject(new Error('active session identity is unavailable'))
              return action.routeBehavior === 'toggle'
                ? this.routes.toggleFromSurface(snapshot.owner, reference, snapshot.surface, snapshot.qualifiedId, button)
                : this.routes.navigateFromSurface(snapshot.owner, reference, snapshot.surface, snapshot.qualifiedId, button)
            })()
          : Promise.reject(new Error('surface action has no activation'))
      void operation.catch(error => {
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
      if (item.route !== undefined) {
        const project = (): void => {
          const routeId = item.route!.id.includes(':') ? item.route!.id : `${snapshot.owner}:${item.route!.id}`
          const outlet = this.routes.snapshot().outlets.find(candidate => candidate.activeRoute === routeId)
          const presentation = outlet?.presentation ?? 'inactive'
          row.dataset.cordisxRouteState = presentation
          if (presentation === 'presented') primary.setAttribute('aria-current', 'page')
          else primary.removeAttribute('aria-current')
        }
        this.routeProjectors.set(primary, project)
        project()
      }
      const activate = (): void => {
        const operation = item.command !== undefined
          ? this.commands.executeFor(snapshot.owner, item.command, `nav:${snapshot.qualifiedId}`, {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
            })
          : item.route === undefined ? Promise.reject(new Error('navigation item has no activation')) : this.routes.navigateFromSurface(snapshot.owner, item.route, snapshot.surface, snapshot.qualifiedId)
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

  private renderActions(
    root: HTMLElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
    path: string,
    template: HTMLButtonElement,
    preferredPattern?: NativeActionPattern,
    directLimit = Number.POSITIVE_INFINITY,
    reduceGlyph = true,
  ): void {
    root.replaceChildren()
    const pattern = preferredPattern ?? (template.closest('header[data-app-shell-application-menu-bar]') === null ? 'footer' : 'toolbar')
    const partition = partitionDirectActions(snapshots, directLimit)
    for (const snapshot of partition.direct) root.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, path, sites, pattern, template, undefined, reduceGlyph))
    if (partition.overflow.length === 0) return
    const overflow = this.document.createElement('details')
    overflow.className = 'cordisx-surface-overflow'
    overflow.dataset.cordisxNoDrag = 'true'
    const summary = this.document.createElement('summary')
    if (reduceGlyph) summary.className = 'cordisx-icon-only-control'
    summary.setAttribute('aria-label', 'More actions')
    summary.dataset.cordisxTooltip = 'More actions'
    summary.append(createHostSurfaceIcon(this.document, 'host:more'))
    this.tooltips.attach(summary, () => summary.dataset.cordisxTooltip, pattern === 'toolbar' ? 'bottom' : 'top')
    const menu = create(this.document, 'div', 'cordisx-surface-overflow-menu')
    menu.setAttribute('role', 'menu')
    for (const snapshot of partition.overflow) {
      const action = this.button(snapshot, snapshot.item as CordisXStructuredAction, `${path}.overflow`, sites, undefined, undefined, () => { overflow.open = false })
      action.setAttribute('role', 'menuitem')
      menu.append(action)
    }
    overflow.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      overflow.open = false
      summary.focus()
    })
    overflow.append(summary, menu)
    root.append(overflow)
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
        const context = this.invocationContext(snapshot, action)
        const operation = action.command !== undefined
          ? this.commands.executeFor(snapshot.owner, action.command, `${snapshot.surface}:${snapshot.qualifiedId}:menu`, {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
              ...(context === undefined ? {} : { context }),
            })
          : action.route !== undefined
            ? this.routes.navigateFromSurface(snapshot.owner, action.route, snapshot.surface, snapshot.qualifiedId)
            : Promise.reject(new Error('surface menu item has no activation'))
        void operation.catch(error => { item.dataset.error = error instanceof Error ? error.message : String(error); this.schedule(true) })
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
    [data-cordisx-no-drag="true"], [data-cordisx-no-drag="true"] * { -webkit-app-region: no-drag !important; }
    .cordisx-native-seat { box-sizing: border-box; color: inherit; font: inherit; pointer-events: auto; -webkit-app-region: no-drag; }
    .cordisx-native-seat[hidden] { display: none !important; }
    .cordisx-reasoning-intensity { --cordisx-reasoning-edge: #dad7cf; --cordisx-reasoning-light: #f8f7f2; --cordisx-reasoning-mid: #cbc6ba; --cordisx-reasoning-dark: #5a5650; box-sizing: border-box; display: block; min-height: 28px; padding: 5px; overflow: visible; border: 1px solid color-mix(in oklab,var(--cordisx-reasoning-edge) 74%,#111); border-radius: 999px; background: linear-gradient(180deg,color-mix(in oklab,var(--cordisx-reasoning-dark) 50%,#111),color-mix(in oklab,var(--cordisx-reasoning-dark) 78%,#000)); box-shadow: inset 0 1px 2px rgba(255,255,255,.12),0 2px 8px rgba(0,0,0,.22); }
    .cordisx-reasoning-intensity[data-material="plastic"] { --cordisx-reasoning-edge:#eeeae1; --cordisx-reasoning-light:#fffefa; --cordisx-reasoning-mid:#d8d4cb; --cordisx-reasoning-dark:#77736c; }
    .cordisx-reasoning-intensity[data-material="bronze"] { --cordisx-reasoning-edge:#d09b5b; --cordisx-reasoning-light:#ffd197; --cordisx-reasoning-mid:#a9632d; --cordisx-reasoning-dark:#4d2a19; }
    .cordisx-reasoning-intensity[data-material="steel"] { --cordisx-reasoning-edge:#9fb1b7; --cordisx-reasoning-light:#dce7e9; --cordisx-reasoning-mid:#70868e; --cordisx-reasoning-dark:#27383e; }
    .cordisx-reasoning-intensity[data-material="silver"] { --cordisx-reasoning-edge:#e8e9ea; --cordisx-reasoning-light:#fff; --cordisx-reasoning-mid:#aeb4ba; --cordisx-reasoning-dark:#555d65; }
    .cordisx-reasoning-intensity[data-material="gold"] { --cordisx-reasoning-edge:#ffe68a; --cordisx-reasoning-light:#fff3b2; --cordisx-reasoning-mid:#d69b16; --cordisx-reasoning-dark:#5b3a06; }
    .cordisx-reasoning-fill { position:absolute; inset:5px auto 5px 5px; max-width:calc(100% - 10px); border-radius:999px; background:linear-gradient(180deg,var(--cordisx-reasoning-light) 0%,var(--cordisx-reasoning-mid) 42%,color-mix(in oklab,var(--cordisx-reasoning-mid) 70%,var(--cordisx-reasoning-dark)) 100%); box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 -2px 3px rgba(0,0,0,.28),0 0 10px color-mix(in oklab,var(--cordisx-reasoning-mid) 45%,transparent); transition:width 280ms cubic-bezier(.22,.8,.2,1),background 320ms ease,box-shadow 320ms ease; }
    .cordisx-reasoning-fill::after { content:""; position:absolute; inset:14% 5% auto; height:24%; border-radius:999px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.52),transparent); opacity:.72; }
    .cordisx-reasoning-ticks { position:absolute; inset:5px; display:flex; justify-content:space-between; align-items:center; padding:0 3px; }
    .cordisx-reasoning-ticks i { display:block; width:4px; height:4px; border-radius:50%; background:color-mix(in oklab,var(--cordisx-reasoning-light) 72%,transparent); box-shadow:0 1px 1px rgba(0,0,0,.38); opacity:.72; }
    .cordisx-reasoning-thumb { position:absolute; top:50%; width:max(44px,calc(100% / 7)); height:calc(100% - 6px); min-height:22px; max-height:46px; display:flex; gap:3px; align-items:center; justify-content:center; padding:3px; border:1px solid color-mix(in oklab,var(--cordisx-reasoning-edge) 74%,#5b451b); border-radius:999px; background:linear-gradient(145deg,var(--cordisx-reasoning-light),var(--cordisx-reasoning-mid)); box-shadow:inset 0 1px 1px rgba(255,255,255,.75),inset 0 -2px 2px rgba(0,0,0,.16),0 3px 7px rgba(0,0,0,.30); transform:translate(-50%,-50%); transition:left 280ms cubic-bezier(.22,.8,.2,1),background 320ms ease,border-color 320ms ease,box-shadow 320ms ease; }
    .cordisx-reasoning-thumb i { display:block; width:42%; aspect-ratio:1; border-radius:50%; background:radial-gradient(circle at 36% 30%,#fff 0%,var(--cordisx-reasoning-light) 38%,var(--cordisx-reasoning-mid) 100%); box-shadow:inset -1px -2px 3px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.16); }
    .cordisx-reasoning-particles { position:absolute; inset:-14px -6px; overflow:visible; opacity:0; transition:opacity 420ms ease; }
    .cordisx-reasoning-particles i { position:absolute; left:var(--cordisx-reasoning-progress); top:var(--particle-y); width:4px; height:2px; border-radius:100% 0 100% 0; background:var(--cordisx-reasoning-light); box-shadow:0 0 6px var(--cordisx-reasoning-mid); transform:translate(-50%,-50%) rotate(calc(var(--particle-index) * 29deg)); }
    .cordisx-reasoning-intensity[data-peak="true"][data-motion="ascension"] .cordisx-reasoning-particles { opacity:1; }
    .cordisx-reasoning-intensity[data-peak="true"][data-motion="ascension"] .cordisx-reasoning-particles i { animation:cordisx-reasoning-spark 1.45s var(--particle-delay) ease-in-out infinite; }
    .cordisx-reasoning-intensity[data-dragging="true"] .cordisx-reasoning-fill,.cordisx-reasoning-intensity[data-dragging="true"] .cordisx-reasoning-thumb { transition-duration:0ms; }
    @keyframes cordisx-reasoning-spark { 0%,100% { opacity:.15; transform:translate(-8px,-50%) scale(.55) rotate(calc(var(--particle-index) * 29deg)); } 42% { opacity:1; transform:translate(calc(8px + var(--particle-index) * 1.4px),calc(-50% - 7px)) scale(1) rotate(calc(24deg + var(--particle-index) * 29deg)); } 75% { opacity:.35; transform:translate(calc(18px + var(--particle-index) * 2px),calc(-50% + 5px)) scale(.7) rotate(calc(56deg + var(--particle-index) * 29deg)); } }
    @media (prefers-reduced-motion:reduce) { .cordisx-reasoning-intensity * { animation:none!important; transition-duration:0ms!important; } }
    .cordisx-sidebar-navigation { display: block; width: 100%; min-width: 0; }
    .cordisx-sidebar-footer-before, .cordisx-sidebar-footer-after { display: flex; flex: 0 0 auto; height: 32px; align-items: center; gap: 4px; min-width: 0; }
    .cordisx-toolbar-before, .cordisx-toolbar-after, .cordisx-session-header-actions { --cordisx-toolbar-action-target-size: 28px; --cordisx-toolbar-action-corner-radius: 8px; --cordisx-toolbar-action-idle-background: transparent; --cordisx-toolbar-action-hover-background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); --cordisx-toolbar-action-focus-ring: var(--color-ring,rgba(131,195,255,.76)); --cordisx-toolbar-action-disabled-opacity: .4; --cordisx-toolbar-action-pressed-background: color-mix(in oklab,var(--color-text,currentColor) 5%,transparent); --cordisx-toolbar-action-pressed-hover-background: color-mix(in oklab,var(--color-text,currentColor) 10%,transparent); --cordisx-toolbar-action-pressed-foreground: var(--color-text,currentColor); --cordisx-toolbar-action-gap: 6px; display: flex; flex: 0 0 auto; height: var(--cordisx-toolbar-action-target-size); align-items: center; gap: var(--cordisx-toolbar-action-gap); min-width: 0; }
    .cordisx-session-header-actions { --cordisx-toolbar-outer-group-gap: 6px; margin-inline-end: var(--cordisx-toolbar-outer-group-gap); }
    .cordisx-composer-submit-before { display: flex; flex: 0 0 auto; height: 28px; align-items: center; gap: 8px; min-width: 0; }
    .cordisx-environment { display: block; width: 100%; min-width: 0; padding: 6px; }
    .cordisx-navigation, .cordisx-env-section { display: grid; gap: 1px; }
    .cordisx-nav-row { display: grid; grid-template-columns: minmax(0,1fr) max-content; align-items: center; height: var(--height-token-row,30px); padding: 0 8px; border-radius: var(--radius-lg,10px); -webkit-app-region: no-drag; }
    .cordisx-nav-row:hover { background: var(--color-background-primary-ghost-hover,rgba(255,255,255,.078)); }
    .cordisx-nav-row[data-cordisx-route-state="presented"] { background: var(--color-background-primary-ghost-hover,rgba(255,255,255,.078)); }
    .cordisx-nav-primary { display: grid; grid-template-columns: 16px minmax(0,1fr); align-items: center; gap: 8px; height: 100%; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: 445 13px/18px system-ui,sans-serif; text-align: left; cursor: default; }
    .cordisx-nav-primary:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: -2px; border-radius: var(--radius-lg,10px); }
    .cordisx-nav-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-nav-actions { display: flex; align-items: center; gap: 2px; }
    .cordisx-env-row, .cordisx-env-header { display: flex; align-items: center; gap: 5px; }
    .cordisx-env-header { justify-content: flex-end; }
    .cordisx-action:not(.cordisx-native-icon-action) { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; border: 1px solid transparent; border-radius: var(--radius-lg,10px); background: transparent; color: inherit; cursor: default; padding: 4px 7px; font: inherit; white-space: nowrap; user-select: none; -webkit-user-select: none; -webkit-app-region: no-drag; }
    .cordisx-native-icon-action { flex: 0 0 auto; -webkit-app-region: no-drag; }
    .cordisx-toolbar-before > .cordisx-toolbar-action, .cordisx-toolbar-after > .cordisx-toolbar-action, .cordisx-session-header-actions > .cordisx-toolbar-action { display: inline-flex; flex: 0 0 auto; width: var(--cordisx-toolbar-action-target-size); min-width: var(--cordisx-toolbar-action-target-size); height: var(--cordisx-toolbar-action-target-size); min-height: var(--cordisx-toolbar-action-target-size); align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--cordisx-toolbar-action-corner-radius); background-color: var(--cordisx-toolbar-action-idle-background); color: var(--color-text-tertiary,rgba(127,127,127,.78)); opacity: 1; cursor: default; white-space: nowrap; user-select: none; -webkit-user-select: none; }
    .cordisx-toolbar-before > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-toolbar-after > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-session-header-actions > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-toolbar-before > .cordisx-toolbar-action[data-state="open"], .cordisx-toolbar-after > .cordisx-toolbar-action[data-state="open"], .cordisx-session-header-actions > .cordisx-toolbar-action[data-state="open"] { background-color: var(--cordisx-toolbar-action-hover-background); }
    .cordisx-toolbar-before > .cordisx-toolbar-action:focus, .cordisx-toolbar-after > .cordisx-toolbar-action:focus, .cordisx-session-header-actions > .cordisx-toolbar-action:focus { outline: none; }
    .cordisx-toolbar-before > .cordisx-toolbar-action:focus-visible, .cordisx-toolbar-after > .cordisx-toolbar-action:focus-visible, .cordisx-session-header-actions > .cordisx-toolbar-action:focus-visible { box-shadow: 0 0 0 2px var(--cordisx-toolbar-action-focus-ring); }
    .cordisx-toolbar-before > .cordisx-toolbar-action:disabled, .cordisx-toolbar-after > .cordisx-toolbar-action:disabled, .cordisx-session-header-actions > .cordisx-toolbar-action:disabled { cursor: default; opacity: var(--cordisx-toolbar-action-disabled-opacity); }
    .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"], .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"], .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"] { background-color: var(--cordisx-toolbar-action-pressed-background); color: var(--cordisx-toolbar-action-pressed-foreground); }
    .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"], .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"], .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"] { background-color: var(--cordisx-toolbar-action-pressed-hover-background); }
    .cordisx-shortcut-action:not([class*="size-"]):not([class*="h-"]) { display: inline-flex; width: 24px; min-width: 24px; height: 24px; min-height: 24px; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius-lg,8px); background: transparent; color: var(--color-text-tertiary,rgba(255,255,255,.5)); }
    .cordisx-composer-action { display: inline-flex; flex: 0 0 auto; width: 28px; min-width: 28px; height: 28px; min-height: 28px; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: 9999px; background: transparent; color: var(--color-text-tertiary,currentColor); cursor: default; }
    .cordisx-composer-action:hover:not(:disabled), .cordisx-composer-action[data-state="open"] { background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); }
    .cordisx-composer-action:focus { outline: none; }
    .cordisx-composer-action:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: 0; }
    .cordisx-composer-action:disabled { cursor: default; opacity: .4; }
    .cordisx-host-icon { display: inline-flex; flex: 0 0 auto; width: 20px; height: 20px; align-items: center; justify-content: center; line-height: 0; pointer-events: none; user-select: none; -webkit-user-select: none; }
    .cordisx-host-icon svg { display: block; width: 20px; height: 20px; fill: currentColor; pointer-events: none; }
    .cordisx-nav-primary > .cordisx-host-icon { width: 16px; height: 16px; }
    .cordisx-nav-primary > .cordisx-host-icon svg, .cordisx-shortcut-action .cordisx-host-icon, .cordisx-shortcut-action .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-icon-only-control { --cordisx-icon-only-glyph-size: 16px; }
    .cordisx-icon-only-control.cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 12px; }
    .cordisx-icon-only-control .cordisx-host-icon svg { width: var(--cordisx-icon-only-glyph-size); height: var(--cordisx-icon-only-glyph-size); }
    .cordisx-composer-action .cordisx-host-icon, .cordisx-composer-action .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-native-menu-root { display: contents; }
    .cordisx-native-menu-item { -webkit-app-region: no-drag; }
    .cordisx-native-menu-row { display: flex; width: 100%; align-items: center; gap: 6px; }
    .cordisx-native-menu-row > .cordisx-host-icon { flex: 0 0 auto; opacity: .75; }
    .cordisx-native-menu-item:hover .cordisx-host-icon, .cordisx-native-menu-item:focus .cordisx-host-icon { opacity: 1; }
    .cordisx-native-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-surface-overflow { position: relative; display: inline-flex; flex: 0 0 auto; -webkit-app-region: no-drag; }
    .cordisx-surface-overflow > summary { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: var(--radius-lg,8px); color: var(--color-text-tertiary,rgba(255,255,255,.5)); cursor: default; list-style: none; -webkit-app-region: no-drag; }
    .cordisx-surface-overflow > summary::-webkit-details-marker { display: none; }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary, .cordisx-toolbar-after > .cordisx-surface-overflow > summary, .cordisx-session-header-actions > .cordisx-surface-overflow > summary { width: var(--cordisx-toolbar-action-target-size); min-width: var(--cordisx-toolbar-action-target-size); height: var(--cordisx-toolbar-action-target-size); min-height: var(--cordisx-toolbar-action-target-size); padding: 0; border: 1px solid transparent; border-radius: var(--cordisx-toolbar-action-corner-radius); background-color: var(--cordisx-toolbar-action-idle-background); color: var(--color-text-tertiary,rgba(127,127,127,.78)); }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:hover, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:hover, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:hover, .cordisx-toolbar-before > .cordisx-surface-overflow[open] > summary, .cordisx-toolbar-after > .cordisx-surface-overflow[open] > summary, .cordisx-session-header-actions > .cordisx-surface-overflow[open] > summary { background-color: var(--cordisx-toolbar-action-hover-background); }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:focus, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:focus, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:focus { outline: none; }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:focus-visible, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:focus-visible, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:focus-visible { box-shadow: 0 0 0 2px var(--cordisx-toolbar-action-focus-ring); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary { width: 28px; height: 28px; border: 1px solid transparent; border-radius: 9999px; background: transparent; color: var(--color-text-tertiary,currentColor); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:hover, .cordisx-composer-submit-before > .cordisx-surface-overflow[open] > summary { background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:focus { outline: none; }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: 0; }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary .cordisx-host-icon, .cordisx-composer-submit-before > .cordisx-surface-overflow > summary .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-surface-overflow-menu { position: absolute; z-index: 20; top: calc(100% + 4px); right: 0; display: grid; min-width: 160px; padding: 4px; border: 1px solid var(--color-border,rgba(255,255,255,.084)); border-radius: var(--radius-lg,10px); background: var(--color-background-elevated-secondary,#242424); box-shadow: 0 8px 28px rgba(0,0,0,.28); }
    .cordisx-surface-overflow:not([open]) > .cordisx-surface-overflow-menu { display: none; }
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

export interface CodexAdapterOptions {
  readonly generation?: string
  readonly adapterVersion?: string
  readonly hostId?: string
}

export function installCodexAdapter(
  document: Document,
  slots: CordisXSlotService,
  commands: CordisXCommandService,
  routes: CordisXRouteService,
  i18n: CordisXI18nService,
  extensionPoints: ExtensionPointDescriptorRegistry,
  options: CodexAdapterOptions = {},
): CodexAdapterHandle {
  const unregisterExtensionPoints = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  let lastProjectKey: string | undefined
  const app = new DomOutletController(document, 'app', 'fixed', () => {
    if (document.body === null) return undefined
    return { anchor: document.body, contextKey: 'renderer', pageChromeSafeLeft: pageChromeSafeLeft(document, document.body) }
  })
  const main = new DomOutletController(document, 'main', 'portal', () => {
    const anchor = uniqueVisible(document, '[data-app-shell-main-content-layout="thread-edge-scroll"]')
      ?? uniqueVisible(document, '[data-app-shell-main-content-layout]')
    if (anchor === undefined) return undefined
    const selected = uniqueVisible(document, '[data-app-action-sidebar-thread-selected="true"]')
    const project = selected?.closest('[data-app-action-sidebar-project-list-id]')?.getAttribute('data-app-action-sidebar-project-list-id')
    if (project !== null && project !== undefined) lastProjectKey = project
    return {
      anchor,
      contextKey: `main:${lastProjectKey ?? 'default'}`,
      pageChromeSafeLeft: pageChromeSafeLeft(document, anchor),
    }
  })
  const session = new DomOutletController(document, 'session.content', 'absolute', () => {
    const sessionId = currentSessionId(document)
    const anchor = sessionId === undefined ? undefined : sessionContentAnchor(document, sessionId)
    if (anchor === undefined || sessionId === undefined) return undefined
    return { anchor, contextKey: `session:${sessionId}`, nativeSessionId: sessionId }
  })
  const undeclare = [
    routes.outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation', presentationGroup: 'primary',
    }, app, path => path !== '/main' && !path.startsWith('/main/') && path !== '/sessions' && !path.startsWith('/sessions/')),
    routes.outlets.declare({
      schemaVersion: 1, id: 'main', authority: 'host-adapter', scope: 'main', preferredPlacement: 'portal', contextPolicy: 'semantic', presentationGroup: 'primary',
    }, main, path => path.startsWith('/main/') && path.length > '/main/'.length),
    routes.outlets.declare({
      schemaVersion: 1, id: 'session.content', authority: 'host-adapter', scope: 'session', preferredPlacement: 'absolute', contextPolicy: 'semantic', presentationGroup: 'primary',
    }, session, path => path.startsWith('/sessions/:sessionId/') && path.length > '/sessions/:sessionId/'.length),
  ]
  const removeStyles = installStyles(document)
  const generation = options.generation ?? (typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const surfaces = new StructuredSurfaceRenderer(document, slots, commands, routes, i18n, {
    generation,
    adapterVersion: options.adapterVersion ?? 'ui-catalog-v2',
    hostId: options.hostId ?? 'com.openai.codex',
  })
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

/**
 * Explicit local-development seats.  Unlike the Codex adapter this path never
 * queries Codex DOM, selectors, sessions, or native controls.  It deliberately
 * exposes only Host-owned page seats; structured shell contributions remain
 * inspectable in Manager when a Playground has not declared a corresponding
 * simulated seat.
 */
export function installPlaygroundAdapter(
  document: Document,
  _slots: CordisXSlotService,
  _commands: CordisXCommandService,
  routes: CordisXRouteService,
  _i18n: CordisXI18nService,
  extensionPoints: ExtensionPointDescriptorRegistry,
): CodexAdapterHandle {
  const unregisterExtensionPoints = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  const seat = (name: string): HTMLElement | undefined => document.querySelector<HTMLElement>(`[data-cordisx-playground-seat="${name}"]`) ?? undefined
  const controllers = [
    ['app', 'fixed', () => seat('app')],
    ['main', 'portal', () => seat('main')],
    ['session.content', 'absolute', () => seat('session.content')],
  ] as const
  const declared = controllers.map(([id, placement, resolve]) => {
    const controller = new DomOutletController(document, id, placement, () => {
      const anchor = resolve()
      return anchor === undefined ? undefined : { anchor, contextKey: `playground:${id}` }
    })
    const path = id === 'app'
      ? (value: string) => value !== '/main' && !value.startsWith('/main/') && value !== '/sessions' && !value.startsWith('/sessions/')
      : id === 'main'
        ? (value: string) => value.startsWith('/main/') && value.length > '/main/'.length
        : (value: string) => value.startsWith('/sessions/:sessionId/') && value.length > '/sessions/:sessionId/'.length
    return { controller, dispose: routes.outlets.declare({
      schemaVersion: 1, id, authority: 'host-adapter', scope: 'playground', preferredPlacement: placement,
      contextPolicy: 'generation', presentationGroup: 'primary',
    }, controller, path) }
  })
  return {
    dispose() {
      for (const item of declared.reverse()) {
        item.dispose()
        item.controller.dispose()
      }
      unregisterExtensionPoints()
    },
  }
}
