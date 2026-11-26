import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { ChannelOutboundRpc } from '../packages/cli/src/launcher/channel-outbound-rpc.js'
import { channelOutboundRuntimeOptions } from '../packages/cli/src/launcher/channel-outbound-runtime-options.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { feishuDefinitionsForConfig } from '../packages/cli/src/launcher/feishu-adapter.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import {
  pluginManagementRpcPaths,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

const { sdkFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn() }))
vi.mock(
  '@larksuiteoapi/node-sdk',
  async original => ({ ...await original<typeof import('@larksuiteoapi/node-sdk')>(), createLarkChannel: sdkFactory }),
)

it('runs configured CLI over its real socket through scoped preparation, runtime and SDK post delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'richtext-configured-cli-'))
  const configPath = path.join(root, 'config.json')
  const account = { adapterId: 'feishu', accountId: 'cli_richtext_fixture', tenantId: 'fixture' }
  const target = { id: 'oc_fixture', kind: 'group' }
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const upload = vi.fn(async () => ({ image_key: 'img_socket_verified' }))
  const dispatch = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: 'om_socket_sent' } }))
  sdkFactory.mockReturnValue({
    connect: async () => {},
    disconnect: async () => {},
    on: () => () => {},
    rawClient: { im: { v1: { image: { create: upload }, message: { create: dispatch, reply: dispatch } } } },
  })
  const outbound = new ChannelOutboundRpc()
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'runtime.json'),
    permissions: { authorize: async () => 'allow' },
    ...channelOutboundRuntimeOptions(outbound),
  })
  const definitions = feishuDefinitionsForConfig({
    contract: 'cordisx.channel-service-config/v1',
    schemaVersion: 1,
    connections: [{
      ref: account,
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/SYNTHETIC_SOCKET_SECRET',
    }],
  }, {
    source: 'test',
    configurationRevision: 1,
    secretResolver: { environment: { SYNTHETIC_SOCKET_SECRET: 'synthetic-only' } },
    outboundMediaAuthority: outbound.authority,
  })
  await runtime.activate(definitions[0]!, { source: 'adapter', pluginId: 'adapter', generation: 'one' })
  const access = {
    generation: 'socket-generation',
    runtime,
    outbound,
    accounts: () => [{ ref: account, state: 'ready' }],
    drain: async () => {
      await runtime.drainOutbound(account)
    },
  } as unknown as ChannelConversationAccess
  const tools = new ChannelConversationTools(() => access)
  await ensureHomeConfig(configPath)
  const before = await readFile(configPath, 'utf8')
  const identity = await processStartIdentity(process.pid)
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'socket-launch',
    processStartedAt: identity!,
    service: {} as PluginManagementService,
    channel: (operation, value, metadata) => tools.callLocal(operation, value, metadata),
  })
  vi.stubEnv('CORDISX_HOME', root)
  vi.stubEnv('CODEX_THREAD_ID', '')
  const command = async (operation: string, value: unknown) => {
    const output: string[] = []
    await runConfiguredChannelCommand(
      [operation, '--profile', 'default', '--input', JSON.stringify(value)],
      line => output.push(line),
    )
    return JSON.parse(output.at(-1)!)
  }
  try {
    const endpoint = JSON.parse(await readFile(pluginManagementRpcPaths(root, 'codex', 'default').state, 'utf8'))
    expect(endpoint).toMatchObject({ profileId: 'default' })
    const begin = await command('media-prepare', {
      action: 'begin',
      account,
      target,
      operationId: 'socket-image',
      type: 'image',
      format: 'png',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    await command('media-prepare', {
      action: 'chunk',
      uploadId: begin.uploadId,
      offset: 0,
      bytesBase64: bytes.toString('base64'),
    })
    const sealed = await command('media-prepare', { action: 'commit', uploadId: begin.uploadId })
    const content = {
      type: 'richtext',
      blocks: [
        {
          type: 'paragraph',
          nodes: [{ type: 'link', text: 'Docs', url: 'https://example.org' }, {
            type: 'image',
            handle: sealed.media.handle,
          }],
        },
        { type: 'inline-code', text: '<at user_id="all">literal</at>' },
        { type: 'code', text: 'return 42', language: 'GO' },
      ],
    }
    const request = { account, target, operationId: 'socket-send', content }
    expect(await command('send', request)).toMatchObject({
      deliveryState: 'sent',
      receipt: { state: 'sent', externalMessageId: 'om_socket_sent' },
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      data: {
        msg_type: 'post',
        content: JSON.stringify({
          en_us: {
            title: '',
            content: [
              [{ tag: 'a', text: 'Docs', href: 'https://example.org' }, {
                tag: 'img',
                image_key: 'img_socket_verified',
              }],
              [{ tag: 'md', text: '`<at user_id="all">literal</at>`' }],
              [{ tag: 'code_block', text: 'return 42', language: 'GO' }],
            ],
          },
        }),
      },
    })
    outbound.store.dispose()
    expect(await command('receipt', { account, operationId: 'socket-send' })).toMatchObject({ deliveryState: 'sent' })
    expect(await command('send', request)).toMatchObject({ deliveryState: 'sent' })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await expect(command('send', { ...request, operationId: 'new-after-expiry' })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(before)
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    tools.dispose()
    outbound.dispose()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
