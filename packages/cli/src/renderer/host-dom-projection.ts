import type {
  HostDomAttributeValue,
  HostDomReadableAttribute,
  HostDomReadProjection,
} from '@cordisx/protocol/host-dom/v1'
export const MAX_TEXT = 16 * 1024
export const MAX_TEXT_VISITED_NODES = 4096
export const MAX_WRITE_TEXT = 4 * 1024
export const PROHIBITED_ELEMENT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'])
export function elementKind(
  element: Element,
): Extract<HostDomReadProjection, { kind: 'structure' }>['nodes'][number]['kind'] {
  const role = element.getAttribute('role')
  if (role === 'status') return 'status'
  if (role === 'list') return 'list'
  if (role === 'listitem') return 'list-item'
  if (role === 'region') return 'region'
  if (role === 'group') return 'group'
  if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) || role === 'button') return 'control'
  return element.children.length === 0 ? 'text' : 'group'
}

export function privateElement(element: Element): boolean {
  return element.matches('input[type="password"], [data-cordisx-private="true"], [data-cordisx-sensitive="true"]')
    || element.closest('[data-cordisx-private="true"], [data-cordisx-sensitive="true"]') !== null
}

export function hiddenElement(element: Element): boolean {
  for (let candidate: Element | null = element; candidate !== null; candidate = candidate.parentElement) {
    if (candidate.hasAttribute('hidden') || candidate.getAttribute('aria-hidden') === 'true') return true
    try {
      const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate)
      if (style?.display === 'none' || style?.visibility === 'hidden') return true
    } catch {
      return true
    }
  }
  return false
}

export function redactedSubtree(element: Element): boolean {
  return privateElement(element) || hiddenElement(element)
    || [...PROHIBITED_ELEMENT_TAGS].some(tag => element.closest(tag.toLowerCase()) !== null)
}

export function boundedText(element: Element): Extract<HostDomReadProjection, { kind: 'text' }> {
  if (redactedSubtree(element)) return { kind: 'text', text: '', truncated: false, redacted: true }
  let text = ''
  let truncated = false
  let redacted = false
  let visited = 0
  const visit = (node: Node): void => {
    visited += 1
    if (visited > MAX_TEXT_VISITED_NODES) {
      truncated = true
      return
    }
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? ''
      const remaining = MAX_TEXT - text.length
      if (value.length > remaining) {
        text += value.slice(0, Math.max(remaining, 0))
        truncated = true
      } else text += value
      return
    }
    if (node.nodeType !== 1) return
    const child = node as Element
    if (child !== element && redactedSubtree(child)) {
      redacted = true
      return
    }
    for (const entry of child.childNodes) {
      if (truncated) return
      visit(entry)
    }
  }
  visit(element)
  return { kind: 'text', text, truncated, redacted }
}

export function attributeValue(element: Element, attribute: HostDomReadableAttribute): HostDomAttributeValue {
  if (attribute === 'checked' || attribute === 'disabled' || attribute === 'hidden') {
    return element.hasAttribute(attribute)
  }
  if (attribute === 'tabindex') {
    const value = element.getAttribute(attribute)
    if (value === null) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : value.slice(0, MAX_WRITE_TEXT)
  }
  return element.getAttribute(attribute)?.slice(0, MAX_WRITE_TEXT) ?? null
}

export function normalizeAttributeValue(value: HostDomAttributeValue): string | null {
  if (value === null || value === false) return null
  return value === true ? '' : String(value)
}
