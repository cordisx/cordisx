/** Native modal isolation affects interaction, not the lifetime of the Composer seat. */
function isCurrentStartupDialog(dialog: HTMLElement): boolean {
  const view = dialog.ownerDocument.defaultView as
    | (Window & {
      __cordisxStartupDocument?: {
        snapshot(): { receipt?: Record<string, unknown> }
        ownsDialog(candidate: HTMLElement, receipt: Record<string, unknown>): boolean
      }
    })
    | null
  const api = view?.__cordisxStartupDocument
  const receipt = api?.snapshot().receipt
  return receipt !== undefined && api?.ownsDialog(dialog, receipt) === true
}

export function nativeModelProviderInteractionAllowed(element: HTMLElement | null): boolean {
  if (!element?.isConnected) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute('inert')) return false
    if (ancestor.getAttribute('aria-hidden') === 'true' && ancestor.dataset.cordisxModelProviderHidden !== 'true') {
      return false
    }
  }
  const document = element.ownerDocument
  // Native <dialog> makes the background inert without adding an inert attribute.
  const dialogs = document.querySelectorAll<HTMLElement>(
    'dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]',
  )
  for (const dialog of dialogs) {
    if (dialog.contains(element) || dialog.hidden || dialog.getAttribute('aria-hidden') === 'true') continue
    if (isCurrentStartupDialog(dialog)) continue
    if (dialog.localName === 'dialog' && dialog.getAttribute('aria-modal') !== 'true') {
      try {
        if (!dialog.matches(':modal')) continue
      } catch {
        // Older DOM implementations need an explicit modal accessibility contract.
        continue
      }
    }
    const style = document.defaultView?.getComputedStyle(dialog)
    if (style?.display !== 'none' && style?.visibility !== 'hidden' && dialog.getClientRects().length > 0) return false
  }
  return true
}

export const nativeModelProviderObservedAttributes = [
  'inert',
  'aria-hidden',
  'aria-modal',
  'role',
  'open',
  'hidden',
  'style',
  'class',
  'data-state',
]
