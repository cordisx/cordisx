import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as lark from '@larksuiteoapi/node-sdk'
import { expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'

it('reports actual SDK socket loss, recovery, and terminal failure through the service owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feishu-transport-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const entry = bundledPluginEntry('channel')
  const ref = { adapterId: 'feishu', accountId: 'cli_0123456789abcdef', tenantId: 'tenant-fixture' }
  const configuration = {
    ...SIMULATOR_CHANNEL_SERVICE_CONFIG,
    connections: [{
      ref,
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/CORDISX_TEST_SECRET',
    }],
  }
  let endpointRequests = 0
  let releaseEndpoint: (() => void) | undefined
  let failEndpoint = false
  const clientConfig = { PingInterval: 60, ReconnectCount: -1, ReconnectInterval: 0.05, ReconnectNonce: 0 }
  const http = {
    post: async () => ({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }),
    request: async (options: { url: string }) => {
      if (options.url.includes('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_fixture' } }
      if (!options.url.includes('/callback/ws/endpoint')) throw new Error('Unexpected fixture request')
      endpointRequests += 1
      if (endpointRequests === 2 || endpointRequests === 3) {
        await new Promise<void>(resolve => {
          releaseEndpoint = resolve
        })
      }
      const result = {
        code: failEndpoint ? 400 : 0,
        msg: 'fixture',
        data: { URL: `ws://127.0.0.1:${port}/?x=1&device_id=1&service_id=1`, ClientConfig: clientConfig },
      }
      failEndpoint = false
      return result
    },
  }
  const createChannel = lark.createLarkChannel
  const createSdk = vi.spyOn(lark, 'createLarkChannel').mockImplementation(options =>
    createChannel({
      ...options,
      httpInstance: http as never,
      cache: { get: async () => undefined, set: async () => false },
    })
  )
  const service = createLocalChannelService({
    artifactDirectory: path.dirname(entry),
    dataDir: path.join(root, 'runtime'),
    source: pathToFileURL(entry).href,
    environment: { CORDISX_TEST_SECRET: 'fixture-only' },
  })
  const state = async () =>
    (await service.readManagementSnapshot({
      configuration,
      revision: 1,
      lastGoodRevision: 1,
    }))?.projection.accounts.find(account => account.ref.accountId === ref.accountId)?.connectionState
  const closeSocket = () => {
    const socket = [...server.clients].find(client => client.readyState === 1)
    if (!socket) throw new Error('Fixture socket is unavailable')
    socket.terminate()
  }
  try {
    const generation = await service.start(configuration)
    await expect.poll(state, { timeout: 3_000 }).toBe('ready')
    closeSocket()
    await expect.poll(() => releaseEndpoint !== undefined, { timeout: 3_000 }).toBe(true)
    await expect.poll(state, { timeout: 3_000 }).toBe('retrying')
    releaseEndpoint!()
    releaseEndpoint = undefined
    await expect.poll(state, { timeout: 3_000 }).toBe('ready')
    closeSocket()
    await expect.poll(() => releaseEndpoint !== undefined, { timeout: 3_000 }).toBe(true)
    await expect.poll(state, { timeout: 3_000 }).toBe('retrying')
    failEndpoint = true
    releaseEndpoint!()
    releaseEndpoint = undefined
    await expect.poll(state, { timeout: 3_000 }).toBe('unavailable')
    await expect(service.manager.connections.reconnect({ ref, generation })).resolves.toMatchObject({
      status: 'applied',
    })
    await expect.poll(state, { timeout: 3_000 }).toBe('ready')
    expect(createSdk).toHaveBeenCalledTimes(2)
  } finally {
    releaseEndpoint?.()
    await service.dispose()
    createSdk.mockRestore()
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
