import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

it('sets and reads local priority and failure notice settings through the configured management endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-priority-cli-'))
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'default',
    access: () => undefined,
    native: () => undefined,
  })
  const tools = new ChannelConversationTools(() => undefined, consumer)
  const handler = configuredChannelManagementToolHandler(tools)
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'fixture',
    processStartedAt: (await processStartIdentity(process.pid))!,
    service: {} as PluginManagementService,
    channel: handler.channel!,
  })
  vi.stubEnv('CORDISX_HOME', root)
  vi.stubEnv('CODEX_THREAD_ID', '')
  try {
    const output: string[] = []
    const run = async (operation: string, input: unknown = {}) => {
      await runConfiguredChannelCommand([operation, '--input', JSON.stringify(input)], line => output.push(line))
      return JSON.parse(output.at(-1)!)
    }
    expect(await run('model-priority-set', { expectedRevision: 0, candidates: [{ providerId: 'p', model: 'm' }] }))
      .toMatchObject({ status: 'ok', revision: 1 })
    expect(await run('model-priority')).toMatchObject({ candidates: [{ providerId: 'p', model: 'm' }] })
    expect(await run('failure-notices-set', { expectedRevision: 0, enabled: false }))
      .toMatchObject({ status: 'ok', revision: 1, enabled: false })
    expect(await run('failure-notices')).toMatchObject({ status: 'ok', enabled: false })
  } finally {
    vi.unstubAllEnvs()
    tools.dispose()
    await consumer.dispose()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
