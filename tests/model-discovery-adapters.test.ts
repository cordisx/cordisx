import { describe, expect, it, vi } from 'vitest'
import { parseCatalogStrategy } from '../packages/cli/src/launcher/model-catalog/contracts.js'
import {
  deepSeekDiscoveryAdapter,
  isDeepSeekOfficialEndpoint,
} from '../packages/cli/src/launcher/model-catalog/deepseek.js'
import { DiscoveryAdapterRegistry } from '../packages/cli/src/launcher/model-catalog/registry.js'
import {
  createDiscoveryRequestCapability,
  type DiscoveryFetch,
} from '../packages/cli/src/launcher/model-catalog/request-capability.js'

const response = (ids: string[]) =>
  Response.json({
    object: 'list',
    data: ids.map(id => ({ id, object: 'model', owned_by: 'deepseek' })),
  })
const connection = (fetcher: DiscoveryFetch = async () => response([]), bearer = vi.fn(async () => 'fixture-key')) => ({
  endpoint: 'https://api.deepseek.com',
  scopeRevision: 'account-1',
  request: vi.fn(createDiscoveryRequestCapability({
    operation: { origin: 'https://api.deepseek.com', method: 'GET', path: '/models' },
    current: () => true,
    bearer,
    fetcher,
  })),
  current: () => true,
})

describe('discovery contracts', () => {
  it('accepts exclusive strategies and rejects accidental unions', () => {
    expect(parseCatalogStrategy({ kind: 'manual', ids: ['b', 'a', 'a'] })).toEqual({ kind: 'manual', ids: ['a', 'b'] })
    expect(parseCatalogStrategy({ kind: 'manual', ids: [] })).toEqual({ kind: 'manual', ids: [] })
    expect(() => parseCatalogStrategy({ kind: 'manual', ids: [], adapter: 'detect' })).toThrow('source-invalid')
    expect(() => parseCatalogStrategy({ kind: 'manual', ids: [], file: 'x' })).toThrow('source-invalid')
    expect(parseCatalogStrategy({ kind: 'script', commandRef: 'trusted' }).kind).toBe('script')
  })

  it('uses exact endpoint spelling, never provider names or generic proxy paths', () => {
    for (const url of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com:443']) {
      expect(isDeepSeekOfficialEndpoint(url)).toBe(true)
    }
    for (
      const url of [
        'http://api.deepseek.com',
        'https://api.deepseek.com.evil.test',
        'https://api.deepseek.com.',
        'https://key@api.deepseek.com',
        'https://api.deepseek.com:444',
        'https://api.deepseek.com/v1',
        'https://api.deepseek.com/?',
        'https://api.deepseek.com/#',
        'https://api.deepseek.com/a/..',
        'https://api.deepseek.com/%2f',
        'https://proxy.test/deepseek',
        'https://api.deepseek.com\\',
      ]
    ) expect(isDeepSeekOfficialEndpoint(url), url).toBe(false)
    const adapter = deepSeekDiscoveryAdapter()
    expect(() => new DiscoveryAdapterRegistry([adapter, adapter])).toThrow('Duplicate')
    expect(() => new DiscoveryAdapterRegistry([adapter]).resolve('https://proxy.test', adapter.id)).toThrow(
      'unsupported',
    )
    expect(() => new DiscoveryAdapterRegistry([adapter, { ...adapter, id: 'other' }]).resolve(connection().endpoint))
      .toThrow('ambiguous')
  })

  it('requests only the fixed list operation and preserves exact legacy IDs', async () => {
    const fetcher = vi.fn(async () => response(['deepseek-v4-flash', 'deepseek-flash', 'deepseek-flash']))
    const models = await deepSeekDiscoveryAdapter().discover(connection(fetcher), new AbortController().signal)
    expect(models.map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-flash'])
    expect(models.map(model => model.protocolCapabilities)).toEqual([{ responses: true }, { responses: false }])
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: 'Bearer fixture-key' },
      }),
    )
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })

  it('does not resolve credentials on an ineligible connection', async () => {
    const owner = { ...connection(), endpoint: 'https://proxy.test' }
    await expect(deepSeekDiscoveryAdapter().discover(owner, new AbortController().signal)).rejects.toThrow(
      'unsupported',
    )
    expect(owner.request).not.toHaveBeenCalled()
  })

  it('cancels a credential callback that ignores its signal without issuing a request', async () => {
    const abort = new AbortController()
    const fetcher = vi.fn(async () => response([]))
    const owner = connection(fetcher, vi.fn(() => new Promise<string>(() => {})))
    const request = deepSeekDiscoveryAdapter().discover(owner, abort.signal)
    abort.abort()
    await expect(request).rejects.toThrow('cancelled')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects oversized bodies and invalid UTF-8 without retaining their content', async () => {
    for (const body of [' '.repeat(1024 * 1024 + 1), new Uint8Array([0xff])]) {
      await expect(
        deepSeekDiscoveryAdapter().discover(
          connection(async () =>
            new Response(body, {
              headers: { 'content-type': 'application/json' },
            })
          ),
          new AbortController().signal,
        ),
      ).rejects.toThrow('protocol')
    }
  })

  it.each([[401, 'authentication'], [403, 'permission'], [402, 'account'], [429, 'rate-limit'], [503, 'temporary'], [
    302,
    'protocol',
  ]])(
    'classifies %s without exposing response bodies',
    async (status, code) => {
      const owner = connection(async () => new Response('private fixture diagnostic', { status: Number(status) }))
      await expect(deepSeekDiscoveryAdapter().discover(owner, new AbortController().signal)).rejects.toThrow(
        String(code),
      )
    },
  )

  it('distinguishes complete empty from malformed and paginated results', async () => {
    await expect(
      deepSeekDiscoveryAdapter().discover(connection(), new AbortController().signal),
    )
      .resolves.toEqual([])
    for (const body of [{ object: 'list', data: [{}] }, { object: 'list', data: [], nextCursor: 'next' }]) {
      await expect(
        deepSeekDiscoveryAdapter().discover(connection(async () => Response.json(body)), new AbortController().signal),
      )
        .rejects.toThrow('protocol')
    }
  })
})
