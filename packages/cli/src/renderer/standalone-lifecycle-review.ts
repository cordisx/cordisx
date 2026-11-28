import type { StandalonePermissionSigner } from '../independent-manager/standalone-permission-signer.js'
import type { DeferredPermissionPlan } from '../permission-deferral.js'
import type { ManagerPermissionSnapshot, ManagerPluginSnapshot } from './manager.js'
import { requestPluginAuthorizationV7 } from './manager/permission-review.js'

type Review = {
  readonly signer: StandalonePermissionSigner
  readonly verify: () => Promise<boolean>
  readonly signal?: AbortSignal
  busy: boolean
}
const reviews = new WeakMap<Document, Review>()

/** The signer remains in a Host-only closure, never in plugin metadata. */
export function bindStandaloneLifecycleReview(
  document: Document,
  signer: StandalonePermissionSigner,
  verify: () => Promise<boolean>,
  signal?: AbortSignal,
): () => void {
  if (reviews.has(document)) throw new Error('standalone-lifecycle-review-unavailable')
  const review: Review = { signer, verify, ...(signal === undefined ? {} : { signal }), busy: false }
  reviews.set(document, review)
  return () => {
    if (reviews.get(document) === review) reviews.delete(document)
  }
}

/** Only the trusted Host dialog can turn a session-issued plan into a signed choice. */
export async function reviewStandaloneLifecycle(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: DeferredPermissionPlan,
  permissions: readonly ManagerPermissionSnapshot[],
  token: string,
) {
  const review = reviews.get(document)
  if (!review || review.busy || review.signal?.aborted || plan.binding.requestId !== token) {
    throw new Error('standalone-lifecycle-review-unavailable')
  }
  review.busy = true
  try {
    if (!await review.verify() || reviews.get(document) !== review || review.signal?.aborted) {
      throw new Error('standalone-lifecycle-review-unavailable')
    }
    const decision = await requestPluginAuthorizationV7(document, plugin, plan, permissions, {
      sessionOnly: true,
      requireTrustedEvents: true,
      externalStyles: true,
    })
    if (!decision) return undefined
    if (!await review.verify() || reviews.get(document) !== review || review.signal?.aborted) {
      throw new Error('standalone-lifecycle-review-unavailable')
    }
    const requestId = globalThis.crypto.randomUUID()
    const proof = await review.signer.signLifecycle(requestId, token, plan, decision)
    if (reviews.get(document) !== review || review.signal?.aborted) {
      throw new Error('standalone-lifecycle-review-unavailable')
    }
    return { requestId, decision, proof }
  } finally {
    review.busy = false
  }
}
