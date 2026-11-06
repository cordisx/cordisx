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
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, right, bottom: 981, width: right, height: 981 }) as DOMRect
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
