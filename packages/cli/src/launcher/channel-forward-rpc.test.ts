import { expect, it, vi } from 'vitest'
import { channelForwardRpc } from './channel-forward-rpc.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' }
const value = {
  account,
  source: { id: 'oc_source', kind: 'group' },
  target: { id: 'oc_target', kind: 'group' },
  operationId: 'one',
  messageIds: ['om_one'],
}
function fixture() {
  const forward = vi.fn(async () => ({ state: 'sent' }))
  const access = { accounts: () => [{ ref: account, state: 'ready' }], forward } as unknown as
    & ChannelConversationAccess
    & { forward: typeof forward }
  const authorize = vi.fn()
  return { forward, access, authorize }
}
it('checks independent source read and target forwarding before mutation', async () => {
  const { forward, access, authorize } = fixture()
  await channelForwardRpc({ operation: 'forward', value, access, scope: 'local', authorize })
  expect(authorize.mock.calls.map(call => call[1])).toEqual(['read', 'forward'])
  expect(forward).toHaveBeenCalledTimes(1)
})
it('denies revoked authorization before receipt disclosure', async () => {
  const { forward, access } = fixture()
  await expect(
    channelForwardRpc({
      operation: 'forward-receipt',
      value: { ...value, operation: 'forward' },
      access,
      scope: 'local',
      authorize: () => {
        throw new Error('DENIED')
      },
    }),
  ).rejects.toThrow('DENIED')
  expect(forward).not.toHaveBeenCalled()
})
it('does not accept another source, thread target, or duplicate merge IDs', async () => {
  const { forward, access, authorize } = fixture()
  const source = {
    ...account,
    conversationId: 'oc_foreign',
    kind: 'group' as const,
    threadId: 'oc_foreign',
    semantics: 'conversation' as const,
    eventId: 'event',
  }
  await expect(channelForwardRpc({ operation: 'forward', value, access, scope: 'agent', source, authorize })).rejects
    .toThrow('SOURCE_SCOPE')
  await expect(
    channelForwardRpc({
      operation: 'forward',
      value: { ...value, target: { ...value.target, replyMode: 'thread' } },
      access,
      scope: 'local',
      authorize,
    }),
  ).rejects.toThrow('UNSUPPORTED')
  await expect(
    channelForwardRpc({
      operation: 'merge-forward',
      value: { ...value, messageIds: ['om_one', 'om_one'] },
      access,
      scope: 'local',
      authorize,
    }),
  ).rejects.toThrow('INVALID_REQUEST')
  expect(forward).not.toHaveBeenCalled()
})
it('uses read-only ledger mode for receipt and distinguishes merge authorization', async () => {
  const { forward, access, authorize } = fixture()
  await channelForwardRpc({
    operation: 'forward-receipt',
    value: { ...value, operation: 'merge-forward', messageIds: ['om_one', 'om_two'] },
    access,
    scope: 'local',
    authorize,
  })
  expect(authorize.mock.calls.map(call => call[1])).toEqual(['read', 'merge-forward'])
  expect(forward.mock.calls[0]?.[2]).toBe(true)
})
