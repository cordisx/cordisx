/** The 26.1103 header has a native contents wrapper inside its viewport frame. */
export function placeNativeViewportTitlebar(header: HTMLElement, right = 1719): {
  frame: HTMLElement
  surface: HTMLElement
} {
  const document = header.ownerDocument
  const frame = document.createElement('div')
  frame.dataset.appShellFrame = 'true'
  frame.style.position = 'relative'
  frame.getClientRects = () => ({ length: 1 }) as DOMRectList
  setRect(frame, () => ({ left: 0, top: 0, right, bottom: 981, width: right, height: 981 }) as DOMRect)
  const surface = document.createElement('div')
  surface.dataset.appShellPageSurface = 'true'
  surface.dataset.appShellHeaderPlacement = 'titlebar'
  surface.style.display = 'contents'
  header.replaceWith(frame)
  frame.append(surface)
  surface.append(header)
  header.style.position = 'absolute'
  return { frame, surface }
}

/** Actual 26.1103 compact shell: the workspace owns the header; the frame adds 4px. */
export function placeNativeWorkspaceTitlebar(header: HTMLElement, right = 1719): {
  frame: HTMLElement
  surface: HTMLElement
  activePage: HTMLElement
  workspace: HTMLElement
  workspaceRow: HTMLElement
} {
  const { frame, surface } = placeNativeViewportTitlebar(header, right + 4)
  frame.dataset.appShellCompactPageGutter = 'true'
  frame.dataset.appShellPageSurface = 'true'
  surface.dataset.appShellUnifiedTabStrip = 'false'
  surface.dataset.appShellCompactPageGutter = 'false'
  const activePage = header.ownerDocument.createElement('div')
  activePage.dataset.appShellActivePage = 'true'
  activePage.style.display = 'contents'
  const workspace = header.ownerDocument.createElement('div')
  workspace.dataset.appShellWorkspace = 'true'
  const workspaceRow = header.ownerDocument.createElement('div')
  workspaceRow.dataset.appShellWorkspaceRow = 'true'
  for (const element of [workspace, workspaceRow]) {
    element.style.position = 'relative'
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    setRect(element, () => ({ left: 0, top: 0, right, bottom: 977, width: right, height: 977 }) as DOMRect)
  }
  frame.append(workspaceRow)
  workspaceRow.append(workspace)
  workspace.append(activePage)
  activePage.append(surface)
  return { frame, surface, activePage, workspace, workspaceRow }
}

/** The ordinary main title keeps its 6px inset behind the single native layout toggle. */
export function insetNativeWorkspaceTitle(header: HTMLElement): void {
  const document = header.ownerDocument
  const title = header.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
  const slot = header.querySelector<HTMLElement>('[data-app-shell-titlebar-slot="main"]')!
  const end = header.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
  header.dataset.appShellHeaderLayout = 'default'
  title.style.position = 'absolute'
  const wrapper = document.createElement('div')
  wrapper.dataset.appShellHeaderObstacle = 'true'
  slot.replaceWith(wrapper)
  wrapper.append(slot)
  const rect = title.getBoundingClientRect()
  setRect(slot, () => ({ ...rect, right: rect.right - 6, width: rect.width - 6 }) as DOMRect)
  wrapper.getClientRects = () => ({ length: 1 }) as DOMRectList
  setRect(wrapper, () => slot.getBoundingClientRect())
  end.querySelector('button')!.setAttribute('data-app-shell-workspace-layout-toggle', 'main')
}
function setRect(element: HTMLElement, read: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, writable: true, value: read })
}
