import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ChannelMessageOperationLedger } from '../packages/cli/src/launcher/channel-message-operation-ledger.js'
import { channelMessageOperationsRpc } from '../packages/cli/src/launcher/channel-message-operations-rpc.js'

it('rejects cross-account/conversation and non-source reaction reads before platform access', async () => {
  const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
  const source = {
    ...account,
    conversationId: 'oc_chat',
    kind: 'group' as const,
    threadId: 'oc_chat',
    semantics: 'conversation' as const,
    eventId: 'event',
    messageId: 'om_source',
  }
  const channel = vi.fn(() => undefined)
  const context = {
    source,
    callerScope: 'caller',
    ledger: await ChannelMessageOperationLedger.open(
      path.join(await mkdtemp(path.join(os.tmpdir(), 'operation-rpc-')), 'ledger.json'),
    ),
    channel,
    authorize: vi.fn(),
    active: () => true,
    ownsPlainCard: () => false,
  }
  await expect(channelMessageOperationsRpc('pin-list', { account, conversationId: 'oc_other', kind: 'group' }, context))
    .rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
  expect(channel).not.toHaveBeenCalled()
  await expect(
    channelMessageOperationsRpc('reaction-list', {
      account,
      conversationId: 'oc_chat',
      kind: 'group',
      messageId: 'om_other',
    }, context),
  ).rejects.toThrow('CHANNEL_SOURCE_MESSAGE_REQUIRED')
  expect(context.authorize).toHaveBeenCalledWith(source, false)
})
