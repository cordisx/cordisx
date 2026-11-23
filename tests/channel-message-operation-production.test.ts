import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelRuntime } from '@cordisx/channel-runtime'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelMessageOperationLedger } from '../packages/cli/src/launcher/channel-message-operation-ledger.js'
import { channelMessageOperationsRpc } from '../packages/cli/src/launcher/channel-message-operations-rpc.js'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-adapter.js'

it('routes the public tools through authorization, the durable ledger and live adapter', async () => {
  const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
  const remove = vi.fn(async () => ({ code: 0 }))
  const channel = {
    rawClient: {
      im: {
        v1: {
          message: {
            get: async () => ({
              code: 0,
              data: {
                items: [{
                  message_id: 'om_owned',
                  chat_id: 'oc_chat',
                  sender: { sender_type: 'app', id_type: 'app_id', id: 'app' },
                }],
              },
            }),
            delete: remove,
          },
        },
      },
    },
  } as unknown as FeishuSdkChannel
  const ledger = await ChannelMessageOperationLedger.open(
    path.join(await mkdtemp(path.join(os.tmpdir(), 'production-operations-')), 'ledger.json'),
  )
  const access = {
    generation: 'one',
    accounts: () => [{ ref: account, state: 'ready' }],
    messageOperations: (operation, input, context) =>
      channelMessageOperationsRpc(operation, input, {
        ...context,
        ledger,
        channel: () => channel,
        active: () => true,
        ownsPlainCard: () => false,
      }),
  } as ChannelConversationAccess
  const tools = new ChannelConversationTools(() => access)
  const request = { account, conversationId: 'oc_chat', kind: 'group', messageId: 'om_owned', operationId: 'recall' }
  expect(await tools.call('message-recall', request)).toMatchObject({ status: 'ok' })
  expect(await tools.call('message-recall', request)).toMatchObject({ status: 'ok' })
  expect(
    await tools.call('message-operation-receipt', {
      account,
      conversationId: 'oc_chat',
      kind: 'group',
      operationId: 'recall',
    }),
  ).toMatchObject({ receipt: { status: 'ok' } })
  expect(remove).toHaveBeenCalledTimes(1)
  tools.dispose()
})

it('requires a durable plain-card send record, excluding ask and unacknowledged sends', async () => {
  const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
  const target = {
    ...account,
    conversationId: 'oc_chat',
    kind: 'group' as const,
    threadId: 'oc_chat',
    semantics: 'conversation' as const,
  }
  const runtime = await ChannelRuntime.open({
    storePath: path.join(await mkdtemp(path.join(os.tmpdir(), 'plain-card-owner-')), 'transport.json'),
    permissions: { authorize: async () => 'allow' },
  })
  const caller = { source: 'test', pluginId: 'test', generation: 'one' }
  await runtime.activate({
    descriptor: {
      ref: account,
      kind: 'feishu',
      implementationStatus: 'experimental',
      configurationRevision: 1,
      secretState: 'ready',
    },
    start: async () => ({
      outboundTypes: ['card'],
      send: async delivery => ({
        externalMessageId: delivery.deliveryId === 'delivery:plain' ? 'om_plain' : 'om_question',
      }),
      stop: async () => {},
    }),
  }, caller)
  try {
    await runtime.notifyOnce(
      {
        target,
        kind: 'reply',
        text: '',
        content: { type: 'card', title: 'Note', body: 'Body' },
        fallback: { mode: 'reject' },
      },
      caller,
      'delivery:plain',
    )
    expect(runtime.ownsPlainCard(target, 'om_plain')).toBe(false)
    await runtime.drainOutbound(account)
    expect(runtime.ownsPlainCard(target, 'om_plain')).toBe(true)
    await runtime.notifyOnce(
      {
        target,
        kind: 'approval',
        text: 'Question',
        questionCard: {
          token: 'a'.repeat(64),
          question: 'Choose?',
          options: ['Yes', 'No'],
        },
      },
      caller,
      'delivery:question',
    )
    await runtime.drainOutbound(account)
    expect(runtime.ownsPlainCard({ ...target, conversationId: 'oc_other' }, 'om_plain')).toBe(false)
    expect(runtime.ownsPlainCard(target, 'om_question')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})
