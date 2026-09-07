import type { NativeActionSeat, NativeSurfaceSeat, ResolvedOutletAnchor } from './types.js'

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
  if (!renderedBox(element)) return false
  const rect = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (view === null) return false
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) return false
  return true
}

function renderedBox(element: Element): element is HTMLElement {
  if (!visible(element)) return false
  const rect = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (rect.width <= 0 || rect.height <= 0 || view === null) return false
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
  const values = new Set(
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .map(element => element.getAttribute(attribute))
      .filter((value): value is string => value !== null && value !== ''),
  )
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
  if (parents.size === 1) return [...parents][0]
  // Current Codex nests the primary actions inside a second vertical group
  // that also contains Explore. Select the unique deepest multi-action group;
  // keep failing closed when the DOM does not provide that distinction.
  const multiAction = [...parents].filter(parent =>
    nativeButtons(parent).filter(button => (
      button.closest('[data-app-action-sidebar-section]') === null
      && button.closest('[data-app-action-sidebar-project-list-id]') === null
    )).length > 1
  )
  const deepest = multiAction.filter(parent => !multiAction.some(other => other !== parent && parent.contains(other)))
  return deepest.length === 1 ? deepest[0] : undefined
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
  const separatorIndex = children.findIndex(child =>
    child.getAttribute('role') === 'separator'
    || child.querySelector(':scope > [class*="bg-border"]') !== null
  )
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

type NativeActionPattern = 'toolbar' | 'footer' | 'shortcut' | 'composer'

function horizontallyAligned(left: DOMRect, right: DOMRect): boolean {
  const overlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
  return overlap >= Math.min(left.width, right.width) * .75
}

function resolveEnvironmentSeat(document: Document): NativeSurfaceSeat | undefined {
  // Codex exposes this node as an absolute geometry obstacle. The actual
  // environment content lives in the native motion sibling's section flow.
  const marker = uniqueStrictlyVisible(
    document,
    '[data-pip-home-surface="thread-summary-panel"][data-pip-obstacle="thread-summary-panel"][aria-hidden="true"]',
  )
  const view = document.defaultView
  if (marker === undefined || view === null || view.getComputedStyle(marker).position !== 'absolute') return undefined
  const layout = marker.parentElement
  if (layout === null || view.getComputedStyle(layout).position === 'static') return undefined
  const markerRect = marker.getBoundingClientRect()
  const motionCandidates = [...layout.children]
    .filter((element): element is HTMLElement => strictlyVisible(element))
    .filter(element => element !== marker && element.closest(CORDISX_SURFACE_HOST_SELECTOR) === null)
    .filter(element => horizontallyAligned(markerRect, element.getBoundingClientRect()))
  if (motionCandidates.length !== 1) return undefined
  const motion = motionCandidates[0]!

  const candidateParents = new Set<HTMLElement>()
  for (const section of motion.querySelectorAll<HTMLElement>('section[role="presentation"]')) {
    if (!renderedBox(section) || section.closest(CORDISX_SURFACE_HOST_SELECTOR) !== null) continue
    if (section.parentElement !== null) candidateParents.add(section.parentElement)
  }
  const stacks = [...candidateParents].filter((stack) => {
    const nativeChildren = [...stack.children]
      .filter(child => child.closest(CORDISX_SURFACE_HOST_SELECTOR) === null)
    if (nativeChildren.length === 0 || nativeChildren.some(child => !child.matches('section[role="presentation"]'))) {
      return false
    }
    if (
      !nativeChildren.some(section => (
        section.querySelector(':scope > header button[aria-expanded]') !== null
        || section.querySelector('[data-slot^="thread-summary-panel-"]') !== null
      ))
    ) return false
    if (!strictlyVisible(stack)) return false
    const stackStyle = view.getComputedStyle(stack)
    if (stackStyle.display !== 'flex' || stackStyle.flexDirection !== 'column') return false
    const scrollport = stack.parentElement
    if (scrollport === null || !motion.contains(scrollport)) return false
    const overflowY = view.getComputedStyle(scrollport).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') return false
    return horizontallyAligned(markerRect, stack.getBoundingClientRect())
  })
  return stacks.length === 1
    ? {
      key: 'environment',
      parent: stacks[0]!,
      before: null,
      className: 'cordisx-environment',
    }
    : undefined
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
    .filter(root =>
      [...root.querySelectorAll('[data-above-composer-conversation-id]')]
        .some(marker => marker.getAttribute('data-above-composer-conversation-id') === sessionId)
    )
  if (roots.length !== 1) return undefined
  const footers = [...roots[0]!.querySelectorAll<HTMLElement>('[data-composer-footer-responsive]')].filter(
    strictlyVisible,
  )
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

function nativeToolbarCornerRadius(template: HTMLElement): string {
  const style = template.ownerDocument.defaultView?.getComputedStyle(template)
  const radius = (style?.borderTopLeftRadius || style?.borderRadius || '').trim()
  return radius === '' ? '8px' : radius
}

export {
  create,
  currentSessionId,
  nativeButtons,
  nativeControlInsertionAnchor,
  nativeMenuInsertionPoint,
  nativeMenuItemTemplate,
  nativeToolbarCornerRadius,
  nextNativeSibling,
  normalizedInsets,
  pageChromeSafeLeft,
  resolveAccountControl,
  resolveComposerSubmitSeat,
  resolveEnvironmentSeat,
  resolveOpenNativeMenu,
  resolveSessionHeaderSeat,
  resolveSidebarFooterControl,
  resolveSidebarNavigationParent,
  resolveToolbarControl,
  resolveToolbarMenuControl,
  sessionContentAnchor,
  strictlyVisible,
  uniqueVisible,
}

export type { NativeActionPattern }
