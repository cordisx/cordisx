/** Projects standard Host header anchors relative to the mounted body's content box. */
export function projectPageContentAlignment(
  content: HTMLElement,
  body: HTMLElement,
  anchors: { leading: HTMLElement; title: HTMLElement },
): () => void {
  const window = body.ownerDocument.defaultView!
  const names = ['--cordisx-page-content-title-inset', '--cordisx-page-content-leading-center'] as const
  let disposed = false
  let frame: number | undefined
  const refresh = () => {
    frame = undefined
    if (disposed || !body.isConnected) return
    const rectangle = body.getBoundingClientRect()
    if (!rectangle.width) return
    const style = window.getComputedStyle(body)
    const origin = rectangle.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0)
    const leading = anchors.leading.getBoundingClientRect()
    const values = [anchors.title.getBoundingClientRect().left - origin, leading.left + leading.width / 2 - origin]
    values.forEach((value, index) => {
      if (Number.isFinite(value)) body.style.setProperty(names[index]!, `${value}px`)
    })
  }
  const schedule = () => {
    if (!disposed && frame === undefined) {
      frame = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(refresh)
        : window.setTimeout(refresh, 0)
    }
  }
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(schedule) : undefined
  for (const node of [content, body, anchors.leading, anchors.title]) observer?.observe(node)
  const mutation = new window.MutationObserver(schedule)
  // The native adapter updates inherited geometry variables on content. React roots
  // attach padding/class to body after this helper is installed.
  mutation.observe(content, { attributes: true, attributeFilter: ['style', 'class'] })
  mutation.observe(body, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', schedule)
  schedule()
  return () => {
    disposed = true
    if (frame !== undefined) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
      else window.clearTimeout(frame)
    }
    observer?.disconnect()
    mutation.disconnect()
    window.removeEventListener('resize', schedule)
    names.forEach(name => body.style.removeProperty(name))
  }
}
