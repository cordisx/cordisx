import type { StoredInboxRecord } from './store.js'
import type { ChannelAdapterDefinition, ChannelClock } from './types.js'

export const RUNTIME_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  leaseMs: 30_000,
  retryBaseMs: 1_000,
  clock: Object.freeze({ now: () => new Date() }) as ChannelClock,
})

export interface ActiveConnection {
  readonly generation: number
  readonly connection: Awaited<ReturnType<ChannelAdapterDefinition['start']>>
}

export function isEligibleInbox(record: StoredInboxRecord, now: number): boolean {
  if (record.status === 'queued') return true
  if (record.status === 'retrying') return Date.parse(record.nextAttemptAt ?? '') <= now
  return record.status === 'processing' && Date.parse(record.leaseExpiresAt ?? '') <= now
}
