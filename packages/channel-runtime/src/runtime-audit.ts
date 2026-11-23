import { randomUUID } from 'node:crypto'
import type { ChannelStoreState, StoredAuditRecord } from './store.js'
import type { ChannelPluginIdentity } from './types.js'

export function appendAudit(state: ChannelStoreState, record: StoredAuditRecord): void {
  state.audit = [...state.audit, record].slice(-2000)
}
export function auditRecord(
  input: Omit<StoredAuditRecord, 'auditId' | 'source' | 'pluginId' | 'pluginGeneration'> & {
    caller: ChannelPluginIdentity
  },
): StoredAuditRecord {
  const { caller, ...record } = input
  return {
    ...record,
    source: caller.source,
    pluginId: caller.pluginId,
    pluginGeneration: caller.generation,
    auditId: `audit:${randomUUID()}`,
  }
}
