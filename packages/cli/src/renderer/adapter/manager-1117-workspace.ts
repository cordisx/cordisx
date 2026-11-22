const THREAD = '[data-app-shell-main-content-layout="thread-edge-scroll"][data-app-shell-workspace-layout="split"]'
const HOME = '[data-app-shell-main-content-layout="default"][data-app-shell-workspace-layout="split"]'
const HOME_COMPOSER = '[data-codex-composer-root][data-composer-placement="home"]'

function isSupportedAnchor(anchor: Element): boolean {
  if (anchor.matches(THREAD)) return true
  if (!anchor.matches(HOME) || anchor.closest('main[data-app-shell-main-surface="default"]') === null) return false
  const composers = anchor.querySelectorAll(HOME_COMPOSER)
  return composers.length === 1 && composers[0]!.getClientRects().length > 0
}

/** Recognize the marker-light thread and home layouts measured in the 26.1117 native shell. */
export function isManager1117WorkspaceHeader(header: HTMLElement): boolean {
  const surface = header.parentElement
  const page = surface?.parentElement
  const anchors = page?.querySelectorAll(`${THREAD}, ${HOME}`)
  return header.getAttribute('data-app-shell-header-layout') === null
    && surface?.getAttribute('data-app-shell-page-surface') === 'true'
    && ((surface.getAttribute('data-app-shell-unified-tab-strip') === 'true'
      && surface.getAttribute('data-app-shell-compact-page-gutter') === 'true')
      || (surface.getAttribute('data-app-shell-unified-tab-strip') === 'false'
        && surface.getAttribute('data-app-shell-compact-page-gutter') === 'false'))
    && surface.getAttribute('data-app-shell-header-placement') === null
    && (page?.getAttribute('data-app-shell-active-page') === 'true'
      || (page?.getAttribute('data-app-shell-shared-local-frame') === 'true'
        && page.getAttribute('data-app-shell-active-page') === null))
    && anchors?.length === 1 && isSupportedAnchor(anchors[0]!)
    && (!anchors[0]!.matches(HOME) || (page?.getAttribute('data-app-shell-active-page') === 'true'
      && surface.getAttribute('data-app-shell-unified-tab-strip') === 'false'
      && surface.getAttribute('data-app-shell-compact-page-gutter') === 'false'))
    && header.querySelector('[data-app-shell-titlebar-slot], [data-app-shell-header-obstacle]') === null
}

/** Without a right panel, this thread extends underneath the fixed-height header. */
export function isManager1117UnderHeaderThread(anchor: HTMLElement, sidebarTop?: number): boolean {
  if (!anchor.matches(THREAD)) return false
  const page = anchor.closest<HTMLElement>('[data-app-shell-page-surface="true"]')?.parentElement
  const headers = page?.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')
  const header = headers?.[0]
  if (
    headers?.length !== 1 || header === undefined || !isManager1117WorkspaceHeader(header)
    || header.parentElement?.getAttribute('data-app-shell-unified-tab-strip') !== 'false'
  ) return false
  const main = anchor.getBoundingClientRect()
  const bar = header.getBoundingClientRect()
  return Math.abs(main.top - bar.top) <= 2 && bar.height >= 40 && bar.height <= 48
    && (sidebarTop === undefined || Math.abs(sidebarTop - bar.bottom) <= 2)
}

/** Return only the measured nested frame, not an arbitrary main-content child. */
export function resolveManager1117WorkspaceFrame(anchor: HTMLElement): HTMLElement | undefined {
  const page = anchor.closest<HTMLElement>('[data-app-shell-page-surface="true"]')?.parentElement
  const headers = page?.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')
  const ElementClass = anchor.ownerDocument.defaultView?.HTMLElement
  if (
    ElementClass === undefined || headers?.length !== 1 || !isManager1117WorkspaceHeader(headers[0]!)
    || !isSupportedAnchor(anchor)
  ) return undefined
  const children = [...anchor.children]
  const hosts = children.filter(child => child.hasAttribute('data-cordisx-react-manager'))
  if (
    hosts.length > 1 || (hosts.length === 1 && (hosts[0] !== children.at(-1) || hosts[0]?.tagName !== 'DIV'
      || hosts[0]?.getAttribute('data-cordisx-react-manager') !== 'true'))
  ) return undefined
  const nativeChildren = children.filter(child => !child.hasAttribute('data-cordisx-react-manager'))
  const frame = nativeChildren[0]
  const inner = frame?.firstElementChild
  if (
    nativeChildren.length !== 1 || !(frame instanceof ElementClass)
    || frame.hasAttribute('data-app-shell-thread-edge-divider') || frame.children.length !== 1
    || !(inner instanceof ElementClass) || inner.children.length !== 2
    || inner.firstElementChild?.getAttribute('aria-hidden') !== 'true'
    || inner.lastElementChild?.getAttribute('data-app-shell-focus-area') !== 'main'
    || frame.querySelectorAll('[data-app-shell-focus-area="main"]').length !== 1
    || (anchor.matches(HOME) && frame.querySelectorAll(HOME_COMPOSER).length !== 1)
  ) return undefined
  return frame
}
