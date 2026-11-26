import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { startServiceModelApi } from '../packages/cli/src/launcher/service-model-api.js'

it('retains the plugin reservation for the lifetime of a model API WebSocket', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cx-service-model-api-'))
  const configPath = path.join(home, 'config.json')
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
  const upstream = createServer()
  const sockets = new WebSocketServer({ server: upstream })
  let upstreamAuthorization: string | undefined
  sockets.on('connection', (socket, request) => {
    upstreamAuthorization = request.headers.authorization
    socket.on('message', value => socket.send(value))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const activation = {
    nativeProviderIds: ['fixture'],
    prepareNativeConnection() {
      return {
        value: {
          service: { pluginId: 'fixture-plugin', serviceId: 'gateway', generation: 'one' },
          endpoint: {
            origin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
            apiPath: '/v1',
            auth: { scheme: 'bearer', token: 'fixture-secret' },
          },
          models: {
            generation: 'one',
            defaultAlias: 'model',
            aliases: [{ alias: 'model', gatewayModelId: 'model' }],
          },
          cleanup: { authorityId: 'fixture' },
        },
        dispose() {},
      }
    },
  } as unknown as ManagedServiceNativeActivation
  const api = await startServiceModelApi({
    homeDir: home,
    configPath,
    profileId: 'fixture',
    environment: { CORDISX_MODEL_API_PORT: '0' },
    activation,
  })
  const key = (await readFile(api.accessKeyFile, 'utf8')).trim()
  const client = new WebSocket(api.baseUrl.replace('http:', 'ws:') + '/responses', {
    headers: { authorization: `Bearer ${key}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const reply = new Promise<string>((resolve, reject) => {
      client.once('message', data => resolve(data.toString()))
      client.once('error', reject)
    })
    client.send(JSON.stringify({ type: 'response.create', model: 'fixture::model' }))
    expect(JSON.parse(await reply)).toMatchObject({ type: 'response.create', model: 'model' })
    expect(upstreamAuthorization).toBe('Bearer fixture-secret')
    expect(api.reserveForLifecycle(['fixture-plugin'])).toBeUndefined()
    expect(api.reserveForLifecycle(['unrelated'])?.release()).toBe(true)
    client.close()
    await new Promise<void>(resolve => client.once('close', () => resolve()))
    await vi.waitFor(() => expect(api.reserveForLifecycle(['fixture-plugin'])?.release()).toBe(true))
  } finally {
    client.terminate()
    await api.close()
    sockets.clients.forEach(socket => socket.terminate())
    sockets.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
