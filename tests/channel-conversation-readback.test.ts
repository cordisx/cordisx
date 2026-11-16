import { describe, expect, it } from 'vitest'
import { conversationReadback, localConversationRefs } from '../packages/channel-runtime/src/conversation-readback.js'
import type { ChannelStoreState, StoredInboxRecord, StoredOutboxRecord } from '../packages/channel-runtime/src/store.js'
import { simulatedInput } from '../packages/channel-runtime/src/simulator.js'

const account = { adapterId: 'feishu', accountId: 'cli_own', tenantId: 'own' }
const conversation = { ...account, conversationId: 'group', kind: 'group' as const }
const caller = {
  source: 'cordisx:native-channel',
  pluginId: 'host-channel-tools',
  generation: '01a1e159-21f3-7c50-8d80-9ba719e34bf3',
}
function fixture(): ChannelStoreState {
  return {
    contract: 'cordisx.channel-store/v1',
    schemaVersion: 1,
    revision: 4,
    adapters: {},
    inbox: {},
    outbox: {},
    audit: [],
  }
}
function incoming(id: string, status: StoredInboxRecord['status'], foreign = false): StoredInboxRecord {
  const input = simulatedInput(id, `Incoming ${id}`)
  return {
    recordId: id,
    fingerprint: id,
    accountKey: id,
    operationId: id,
    caller,
    generation: 1,
    receivedAt: '2026-11-16T01:00:00Z',
    updatedAt: '2026-11-16T01:00:01Z',
    status,
    attempts: 1,
    envelope: {
      input: {
        ...input,
        source: {
          kind: 'channel',
          event: { ...input.source.event, ...conversation, ...(foreign ? { accountId: 'cli_foreign' } : {}) },
        },
      },
    },
  }
}
function outgoing(id: string, status: StoredOutboxRecord['status'], receipt?: string): StoredOutboxRecord {
  return {
    deliveryId: id,
    operationId: id,
    accountKey: id,
    generation: 1,
    caller,
    kind: 'message',
    target: { ...conversation, threadId: 'group', semantics: 'conversation' },
    text: `Explicit send ${id}`,
    createdAt: '2026-11-16T02:00:00Z',
    updatedAt: '2026-11-16T02:00:01Z',
    status,
    attempts: 1,
    ...(receipt === undefined ? {} : { externalMessageId: receipt }),
  }
}
describe('actual Channel conversation transport facts', () => {
  it('separates accounts, keeps permission/failed/unknown states, and requires a positive send receipt', () => {
    const state = fixture()
    for (const status of ['applied', 'permission-pending', 'denied', 'retrying', 'dead-letter'] as const) {
      state.inbox[status] = incoming(status, status)
    }
    state.inbox.foreign = incoming('foreign', 'applied', true)
    state.outbox.sent = outgoing('sent', 'sent', 'platform-receipt')
    state.outbox.uncertain = outgoing('uncertain', 'sent')
    state.outbox.queued = outgoing('queued', 'queued')
    state.outbox.failed = outgoing('failed', 'dead-letter')
    const page = conversationReadback(state, conversation)
    expect(page.revision).toBe(4)
    expect(page.entries).toHaveLength(9)
    expect(page.entries.find(entry => entry.id === 'foreign')).toBeUndefined()
    expect(Object.fromEntries(page.entries.map(entry => [entry.id, entry.state]))).toMatchObject({
      applied: 'received',
      'permission-pending': 'permission-pending',
      denied: 'denied',
      retrying: 'retrying',
      'dead-letter': 'failed',
      sent: 'sent',
      uncertain: 'unknown',
      queued: 'queued',
      failed: 'failed',
    })
    expect(page.entries.find(entry => entry.id === 'sent')?.sessionId).toBe(caller.generation)
    expect(page.entries.some(entry => entry.text.includes('local final'))).toBe(false)
  })
  it('does not guess native task attribution from unrelated plugins and discovers only the selected account', () => {
    const state = fixture()
    state.inbox.foreign = incoming('foreign', 'applied', true)
    state.outbox.sent = { ...outgoing('sent', 'sent', 'receipt'), caller: { ...caller, pluginId: 'different' } }
    expect(conversationReadback(state, conversation).entries[0]).not.toHaveProperty('sessionId')
    expect(localConversationRefs(state, account)).toEqual([conversation])
    expect(() => conversationReadback(state, { ...account, conversationId: '' })).toThrow()
  })
})
