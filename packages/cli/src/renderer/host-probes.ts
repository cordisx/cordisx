function visible(element: Element): element is HTMLElement {
  const ElementClass = element.ownerDocument.defaultView?.HTMLElement
  if (ElementClass === undefined || !(element instanceof ElementClass)) return false
  return element.getClientRects().length > 0
}

/** Private fallback probe for the current manager trigger. Structured adapters use semantic probes. */
export function resolveManagerTriggerTarget(document: Document): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
  const visibleCandidates = [...candidates].filter(candidate =>
    visible(candidate) && candidate.textContent?.trim() === 'Codex'
  )
  return visibleCandidates.length === 1 ? visibleCandidates[0] : undefined
}
