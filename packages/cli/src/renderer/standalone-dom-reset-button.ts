import type { CordisXPluginIdentity } from '../contracts.js'
import { isStandaloneDomReviewTarget } from '../standalone-permission-contract.js'

type Registration = {
  readonly button: HTMLElement
  readonly identity: CordisXPluginIdentity
  readonly pointId: string
}

const buttons = new WeakMap<EventTarget, Registration>()
const used = new WeakSet<Event>()

/** Only the Host's mounted reset control can authorize a reset interaction. */
export function registerStandaloneDomResetButton(
  button: HTMLElement,
  identity: CordisXPluginIdentity,
  pointId: string,
): () => void {
  const view = button.ownerDocument.defaultView
  if (!view || !(button instanceof view.HTMLButtonElement) || !isStandaloneDomReviewTarget(identity, pointId)) {
    return () => {}
  }
  const registration: Registration = { button, identity: { ...identity }, pointId }
  buttons.set(button, registration)
  return () => {
    if (buttons.get(button) === registration) buttons.delete(button)
  }
}

/** Consume one real click on the exact Host control, before its event dispatch ends. */
export function consumeStandaloneDomReset(
  event: Event,
  identity: CordisXPluginIdentity,
  pointId: string,
): boolean {
  try {
    if (event.type !== 'click' || !event.isTrusted || used.has(event)) return false
    for (const target of event.composedPath()) {
      const registration = buttons.get(target)
      if (!registration) continue
      const view = registration.button.ownerDocument.defaultView
      if (
        !view || !(event instanceof view.Event) || !registration.button.isConnected
        || registration.identity.id !== identity.id || registration.identity.source !== identity.source
        || registration.pointId !== pointId
      ) return false
      used.add(event)
      return true
    }
    return false
  } catch {
    return false
  }
}
