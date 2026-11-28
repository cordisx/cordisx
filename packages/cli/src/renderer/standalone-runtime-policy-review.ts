import type { CordisXPluginIdentity } from '../contracts.js'
import type {
  CordisXPermissionCapabilityV2,
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyV2,
} from '../permission-contracts.js'
import type { StandalonePermissionSigner } from '../independent-manager/standalone-permission-signer.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'

type Review = Parameters<StandalonePermissionSigner['noteRuntimePolicy']>[0]
type Authorize = (
  review: Review,
  record: CordisXPermissionPolicyRecordV2,
  observed: CordisXPermissionPolicyV2,
) => (() => void) | undefined
const reviewers = new WeakMap<object, Authorize>()
const buttons = new WeakMap<EventTarget, {
  readonly button: HTMLElement
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPermissionCapabilityV2
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicyV2
}>()
const used = new WeakSet<Event>()

/** Install the signer callback before plugin code can access a Manager model. */
export function bindStandaloneRuntimePolicyReviewer(broker: object, authorize: Authorize): void {
  if (reviewers.has(broker)) throw new Error('runtime-policy-review-already-bound')
  reviewers.set(broker, authorize)
}

export function standaloneRuntimePolicyReviewer(broker: object): Authorize | undefined {
  return reviewers.get(broker)
}

/** Bind a user gesture to the exact Host-rendered setting and desired policy. */
export function registerStandaloneRuntimePolicyButton(
  button: HTMLElement,
  identity: CordisXPluginIdentity,
  capability: CordisXPermissionCapabilityV2,
  fingerprint: string,
  policy: CordisXPermissionPolicyV2,
  native = false,
): () => void {
  const view = button.ownerDocument.defaultView
  if (
    !view || !(button instanceof view.HTMLButtonElement)
    || !(native ? isNativeManagerDomTarget : isStandaloneManagerDomTarget)(identity, 'manager.content')
  ) return () => {}
  const registration = { button, identity: { ...identity }, capability, fingerprint, policy }
  buttons.set(button, registration)
  return () => {
    if (buttons.get(button) === registration) buttons.delete(button)
  }
}

export function consumeStandaloneRuntimePolicyClick(
  event: Event,
  identity: CordisXPluginIdentity,
  capability: CordisXPermissionCapabilityV2,
  fingerprint: string,
  policy: CordisXPermissionPolicyV2,
): boolean {
  try {
    if (event.type !== 'click' || !event.isTrusted || used.has(event)) return false
    for (const target of event.composedPath()) {
      const value = buttons.get(target)
      if (!value) continue
      const view = value.button.ownerDocument.defaultView
      if (
        !view || !(event instanceof view.Event) || !value.button.isConnected
        || value.identity.id !== identity.id || value.identity.source !== identity.source
        || value.capability !== capability || value.fingerprint !== fingerprint || value.policy !== policy
      ) return false
      used.add(event)
      return true
    }
    return false
  } catch {
    return false
  }
}
