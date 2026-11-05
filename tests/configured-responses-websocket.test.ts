import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { expect, it } from 'vitest'
import { configuredEncryptedReplay } from '../packages/cli/src/launcher/configured-encrypted-replay.js'
import { startResponsesEncryptedReplay } from '../packages/cli/src/launcher/responses-encrypted-replay.js'

const key = Buffer.alloc(16, 8).toString('base64')
function upgrade(url: string) {
  return new Promise<{ status: number | undefined; socket?: Duplex; head?: Buffer }>((resolve, reject) => {
    const client = request(url, {
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Authorization: 'Bearer fixture-native-key',
        'X-Custom': 'fixture-runtime-header',
      },
    })
    client.setTimeout(3000, () => client.destroy(new Error('Upgrade timed out')))
    client.once('error', reject)
    client.once('response', response => {
      response.resume()
      resolve({ status: response.statusCode })
    })
    client.once('upgrade', (response, socket, head) => {
      socket.setTimeout(0)
      resolve({ status: response.statusCode, socket, head })
    })
    client.end()
  })
}

it('relays configured Responses WebSockets only for the enabled route and closes owned upgrades', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'configured-replay-ws-'))
  const transport = await startResponsesEncryptedReplay()
  const upstream = createServer()
  const observed: unknown[] = []
  const upstreamSockets = new Set<Duplex>()
  upstream.on('upgrade', (incoming, socket) => {
    observed.push([incoming.url, incoming.headers.authorization, incoming.headers['x-custom']])
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
    socket.on('data', frame => socket.write(frame))
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })
  let client: Duplex | undefined
  try {
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('No upstream')
    const target = `http://127.0.0.1:${address.port}/v1`
    const config = (enabled: boolean) =>
      writeFile(
        path.join(home, 'config.toml'),
        [
          '[model_providers.fixture]',
          `base_url = "${target}"`,
          'wire_api = "responses"',
          `supports_websockets = ${enabled}`,
        ].join('\n'),
      )
    const prepare = configuredEncryptedReplay(home, transport.route)
    const url = async () => {
      const providers = await prepare('fixture')
      const entry = providers['model_providers.fixture'] as { base_url: string }
      return entry.base_url + '/responses'
    }
    await config(false)
    expect(await upgrade(await url())).toEqual({ status: 404 })
    expect(observed).toEqual([])
    await config(true)
    const result = await upgrade(await url())
    expect(result.status).toBe(101)
    client = result.socket!
    expect(observed).toEqual([['/v1/responses', 'Bearer fixture-native-key', 'fixture-runtime-header']])
    const received = once(client, 'data')
    const frame = Buffer.from([0x89, 0x80, 0, 0, 0, 0])
    client.write(frame)
    expect((await received)[0]).toEqual(frame)
    const closed = once(client, 'close')
    await transport.close()
    await closed
  } finally {
    client?.destroy()
    await transport.close()
    for (const socket of upstreamSockets) socket.destroy()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
