import type { LogicalContinuationState } from './logical-continuation-control.js'
import type { ChannelIdlePriorityGrant } from './channel-idle-priority-grant.js'

/** Binding changes revoke prior consent rather than resurrecting it on a later rebind. */
export function removeChannelIdlePriorityGrant(state: LogicalContinuationState | undefined, bindingId: string): void {
  if (!state?.idlePriorityGrants) return
  delete state.idlePriorityGrants[bindingId]
  if (!Object.keys(state.idlePriorityGrants).length) delete state.idlePriorityGrants
}

export function clearChannelIdlePriorityOffers(
  offers: Map<string, { grant: ChannelIdlePriorityGrant; expiresAt: number }>,
  bindingId: string,
): void {
  for (const [token, offer] of offers) if (offer.grant.bindingId === bindingId) offers.delete(token)
}
