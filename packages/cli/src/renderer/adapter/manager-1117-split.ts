/** Recognize the marker-light split thread measured in the 26.1117 native shell. */
export function isManager1117SplitHeader(header: HTMLElement): boolean {
  const surface = header.parentElement
  const page = surface?.parentElement
  const anchors = page?.querySelectorAll(
    '[data-app-shell-main-content-layout="thread-edge-scroll"][data-app-shell-workspace-layout="split"]',
  )
  return header.getAttribute('data-app-shell-header-layout') === null
    && surface?.getAttribute('data-app-shell-page-surface') === 'true'
    && surface.getAttribute('data-app-shell-unified-tab-strip') === 'true'
    && surface.getAttribute('data-app-shell-compact-page-gutter') === 'true'
    && surface.getAttribute('data-app-shell-header-placement') === null
    && page?.getAttribute('data-app-shell-active-page') === 'true'
    && anchors?.length === 1
    && header.querySelector('[data-app-shell-titlebar-slot], [data-app-shell-header-obstacle]') === null
}

/** Return only the measured nested frame, not an arbitrary main-content child. */
export function resolveManager1117SplitFrame(anchor: HTMLElement): HTMLElement | undefined {
  const page = anchor.closest<HTMLElement>('[data-app-shell-active-page="true"]')
  const headers = page?.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')
  const ElementClass = anchor.ownerDocument.defaultView?.HTMLElement
  if (
    ElementClass === undefined || headers?.length !== 1 || !isManager1117SplitHeader(headers[0]!)
    || !anchor.matches(
      '[data-app-shell-main-content-layout="thread-edge-scroll"][data-app-shell-workspace-layout="split"]',
    )
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
  ) return undefined
  return frame
}
