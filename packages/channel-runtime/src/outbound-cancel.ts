import type { JsonChannelStore } from './store.js'
import { appendAudit, auditRecord } from './runtime-audit.js'

export async function cancelOutboundDelivery(
  store: JsonChannelStore,
  deliveryId: string,
  now: string,
): Promise<'cancelled' | 'irreversible' | 'not-found'> {
  return store.transaction(state => {
    const current = state.outbox[deliveryId]
    if (current === undefined) return 'not-found'
    if (current.status === 'processing' || current.status === 'sent' || current.status === 'unknown') {
      return 'irreversible'
    }
    if (current.status !== 'queued' && current.status !== 'retrying') return 'not-found'
    state.outbox[deliveryId] = { ...current, status: 'cancelled', updatedAt: now }
    appendAudit(
      state,
      auditRecord({
        caller: current.caller,
        recordedAt: now,
        accountKey: current.accountKey,
        generation: current.generation,
        operationId: deliveryId,
        action: 'channel.delivery.cancel',
        outcome: 'cancelled-before-claim',
      }),
    )
    return 'cancelled'
  })
}
