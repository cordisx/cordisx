/** Reclaim only the measured space of native controls the Manager suppresses. */
export function managerTitlebarPresentationRight(
  header: HTMLElement,
  slot: HTMLElement,
  suppressed: readonly HTMLElement[],
  fallback: number,
  ceiling: number,
): number {
  const view = header.ownerDocument.defaultView
  if (view === null || suppressed.length !== 1) return fallback
  const group = suppressed[0]!
  const groupRect = group.getBoundingClientRect()
  const buttons = [...group.querySelectorAll<HTMLElement>('button')]
  // Do not claim space unless the actual suppressed actions have measurable bounds.
  if (
    groupRect.width <= 0 || groupRect.height <= 0 || buttons.length === 0 || buttons.some(button => {
      const rect = button.getBoundingClientRect()
      return rect.width <= 0 || rect.height <= 0 || rect.left < groupRect.left || rect.right > groupRect.right
    })
  ) return fallback
  let right = Math.min(header.getBoundingClientRect().right, ceiling, groupRect.right)
  // A clipped title or a live right tab remains the boundary of the Host seat.
  for (let node: HTMLElement | null = slot; node !== null && node !== header; node = node.parentElement) {
    let style: CSSStyleDeclaration
    try {
      style = view.getComputedStyle(node)
    } catch {
      return fallback
    }
    if (
      ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
      || /\b(paint|content|strict)\b/u.test(style.contain)
    ) {
      right = Math.min(right, node.getBoundingClientRect().right)
    }
  }
  if (right <= fallback) return fallback
  const controls = header.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[role="button"]')
  for (const element of controls) {
    if (element.closest('[data-cordisx-manager-titlebar-seat]') !== null) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= fallback || rect.left >= right) continue
    if (!suppressed.some(node => node.contains(element))) return fallback
  }
  return right
}
