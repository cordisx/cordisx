import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runChannelCommand } from '../packages/cli/src/cli/channel-command.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { ChannelGenericCardActions } from '../packages/cli/src/launcher/channel-generic-card-actions.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-channel-types.js'

it('configured CLI dispatches explicit owned action publication/read/receipt through live authenticated RPC and tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generic-card-cli-'))
  const configPath = path.join(root, 'config.json')
  const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
  const service = await ChannelGenericCardActions.open(path.join(root, 'actions.json'))
  const patch = vi.fn(async (_input: { data: { content: string } }) => ({ code: 0 }))
  const channel = {
    rawClient: {
      im: {
        v1: {
          message: {
            get: async () => ({
              code: 0,
              data: {
                items: [{
                  message_id: 'om_notice',
                  chat_id: 'oc_chat',
                  msg_type: 'interactive',
                  sender: { sender_type: 'app', id_type: 'app_id', id: 'app' },
                  body: {
                    content: JSON.stringify({
                      config: { wide_screen_mode: true },
                      header: { title: { tag: 'plain_text', content: 'Notice' } },
                      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Notice' } }],
                    }),
                  },
                }],
              },
            }),
            patch,
          },
        },
      },
    },
  } as unknown as FeishuSdkChannel
  const access: Pick<ChannelConversationAccess, 'generation' | 'accounts' | 'messageOperations'> = {
    generation: 'generation',
    accounts: () => [{ ref: account, state: 'ready' }],
    messageOperations: (operation, input, context) =>
      service.execute(operation, input, {
        ...context,
        channel: () => channel,
        active: () => true,
        ownsPlainCard: () => true,
      }),
  }
  const tools = new ChannelConversationTools(() => access as ChannelConversationAccess)
  await ensureHomeConfig(configPath)
  const processStartedAt = await processStartIdentity(process.pid)
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'launcher',
    processStartedAt: processStartedAt!,
    service: {} as PluginManagementService,
    channel: (operation, input) => tools.callLocal(operation, input),
  })
  vi.stubEnv('CORDISX_HOME', root)
  vi.stubEnv('CODEX_THREAD_ID', '')
  const target = { account, conversationId: 'oc_chat', kind: 'direct' }
  const call = async (operation: string, input: unknown) => {
    const output: string[] = []
    await runChannelCommand(
      [operation, '--profile', 'default', '--input', JSON.stringify(input)],
      line => output.push(line),
    )
    return JSON.parse(output[0]!)
  }
  try {
    const publish = {
      ...target,
      operationId: 'publish',
      messageId: 'om_notice',
      expectedVersion: 0,
      template: 'action-notice',
      title: 'Review',
      body: 'Choose',
      actions: [{ id: 'review', label: 'Review' }],
      expiresInSeconds: 60,
    }
    expect(await call('card-action-publish', publish)).toMatchObject({
      status: 'ok',
      operation: 'card-action-publish',
      version: 1,
    })
    expect(await call('card-action-publish', publish)).toMatchObject({ status: 'ok' })
    expect(patch).toHaveBeenCalledTimes(1)
    const value = JSON.parse(patch.mock.calls[0]![0].data.content).elements[1].actions[0].value
    service.observe(
      account,
      { chatId: 'oc_chat', messageId: 'om_notice', operator: { openId: 'ou_operator' }, action: { value } } as never,
      channel,
    )
    const page = await call('card-action-read', { ...target, messageId: 'om_notice', version: 1 })
    expect(page).toMatchObject({
      status: 'ok',
      operation: 'card-action-read',
      hasMore: false,
      events: [{ actionId: 'review', operatorId: 'ou_operator' }],
    })
    expect(JSON.stringify(page)).not.toContain(value.channelGenericAction)
    expect(await call('card-action-receipt', { ...target, operationId: 'publish' })).toMatchObject({
      status: 'ok',
      operation: 'card-action-publish',
    })
    expect(await call('card-action-receipt', { ...target, operationId: 'missing' })).toBeNull()
    service.invalidate(account)
    await expect(call('card-action-read', { ...target, messageId: 'om_notice', version: 1 })).rejects.toThrow(
      'CHANNEL_OPERATION_REJECTED',
    )
    expect(await call('card-action-receipt', { ...target, operationId: 'publish' })).toMatchObject({ status: 'ok' })
  } finally {
    vi.unstubAllEnvs()
    tools.dispose()
    service.dispose()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
