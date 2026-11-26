import type { ChannelStoreState } from './store.js'
import type { ChannelRuntimeSnapshot } from './types.js'
import type { ChannelPermissionBroker, ChannelPluginIdentity } from './types.js'
import { digest } from './runtime-validation.js'

export async function visibleConnections(
  snapshot: ChannelRuntimeSnapshot,
  permissions: ChannelPermissionBroker,
  caller: ChannelPluginIdentity,
) {
  const visible: ChannelRuntimeSnapshot['accounts'][number][] = []
  for (const account of snapshot.accounts) {
    const decision = await permissions.authorize({
      caller,
      capability: 'channel.accounts.read',
      source: account.ref,
      generation: account.generation,
      operationId: `connections:${digest([caller, account.ref, account.generation])}`,
    })
    if (decision === 'allow') visible.push(account)
  }
  return visible
}

export function runtimeSnapshot(
  state: ChannelStoreState,
  observedAt: string,
  active: ReadonlyMap<string, { readonly generation: number }>,
): ChannelRuntimeSnapshot {
  const accounts = Object.entries(state.adapters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, adapter]) => {
      const inbox = Object.values(state.inbox).filter(record => record.accountKey === key)
      const outbox = Object.values(state.outbox).filter(record => record.accountKey === key)
      return {
        ref: adapter.ref,
        adapterKind: adapter.kind,
        implementationStatus: adapter.implementationStatus,
        // A persisted ready state is not evidence that this runtime still owns a connection.
        connectionState: adapter.connectionState === 'ready' && active.get(key)?.generation !== adapter.generation
          ? 'unavailable' as const
          : adapter.connectionState,
        secretState: adapter.secretState,
        generation: adapter.generation,
        lastGoodRevision: adapter.lastGoodRevision,
        ...(adapter.cursorUpdatedAt === undefined ? {} : { cursorUpdatedAt: adapter.cursorUpdatedAt }),
        ...(adapter.lastErrorCode === undefined ? {} : { lastErrorCode: adapter.lastErrorCode }),
        inbound: {
          pending: inbox.filter(record => record.status === 'queued' || record.status === 'processing').length,
          retrying: inbox.filter(record => record.status === 'retrying').length,
          deadLetter: inbox.filter(record => record.status === 'dead-letter').length,
        },
        outbound: {
          pending: outbox.filter(record => record.status === 'queued' || record.status === 'processing').length,
          retrying: outbox.filter(record => record.status === 'retrying').length,
          deadLetter: outbox.filter(record => record.status === 'dead-letter').length,
        },
      }
    })
  return Object.freeze({
    contract: 'cordisx.channel-runtime-snapshot/v1',
    schemaVersion: 1,
    observedAt: observedAt,
    accounts,
  })
}
