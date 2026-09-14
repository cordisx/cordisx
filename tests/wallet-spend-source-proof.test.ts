import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import {
  fetchWalletSpendSource,
  verifyWalletSpendSource,
} from '../packages/cli/src/launcher/wallet-spend-source-proof.js'

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
afterEach(() => vi.unstubAllGlobals())

describe('wallet spend origin proof', () => {
  it('uses only the fixed HTTPS metadata endpoint with no credentials or redirect following', async () => {
    const source = { serviceOrigin: 'https://fixture.example', servicePublicKey: publicKey, serverId: 'fixture' }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ contract: 'economy.spend-service/v1', ...source })))
    vi.stubGlobal('fetch', fetcher)
    expect(await fetchWalletSpendSource(source.serviceOrigin, new AbortController().signal)).toEqual(source)
    expect(fetcher).toHaveBeenCalledWith(
      'https://fixture.example/v1/spend/identity',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      }),
    )
  })

  it('rejects redirect responses and a key that differs from the pinned identity', async () => {
    const source = { serviceOrigin: 'https://fixture.example', servicePublicKey: publicKey, serverId: 'fixture' }
    vi.stubGlobal(
      'fetch',
      async () => new Response('', { status: 302, headers: { location: 'https://other.example' } }),
    )
    await expect(fetchWalletSpendSource(source.serviceOrigin, new AbortController().signal)).rejects.toThrow(
      'source unavailable',
    )
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ contract: 'economy.spend-service/v1', ...source, servicePublicKey: other })),
    )
    await expect(verifyWalletSpendSource(source, new AbortController().signal)).rejects.toThrow(
      'source identity mismatch',
    )
  })

  it('requires explicit deployment allowance for real loopback HTTP and rejects a foreign claimed origin', async () => {
    let origin = '', claimed = ''
    const server = createServer((request, response) => {
      expect(request.url).toBe('/v1/spend/identity')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
      response.end(
        JSON.stringify({
          contract: 'economy.spend-service/v1',
          serviceOrigin: claimed || origin,
          servicePublicKey: publicKey,
          serverId: 'fixture',
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    try {
      await expect(fetchWalletSpendSource(origin, new AbortController().signal)).rejects.toThrow('invalid origin')
      expect((await fetchWalletSpendSource(origin, new AbortController().signal, true)).serviceOrigin).toBe(origin)
      claimed = 'https://google.com'
      await expect(fetchWalletSpendSource(origin, new AbortController().signal, true)).rejects.toThrow(
        'source identity mismatch',
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('bounds metadata bytes before JSON parsing and forbids remote HTTP even with local allowance', async () => {
    vi.stubGlobal('fetch', async () => new Response(' '.repeat(4097)))
    await expect(fetchWalletSpendSource('https://fixture.example', new AbortController().signal)).rejects.toThrow(
      'oversized',
    )
    await expect(fetchWalletSpendSource('http://remote.example', new AbortController().signal, true)).rejects.toThrow(
      'invalid origin',
    )
  })
})
