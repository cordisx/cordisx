import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DISCOVERY_RESPONSE_BYTES,
  parseCatalogStrategy,
} from '../packages/cli/src/launcher/model-catalog/contracts.js'
import {
  deepSeekDiscoveryAdapter,
  isDeepSeekOfficialEndpoint,
} from '../packages/cli/src/launcher/model-catalog/deepseek.js'
import {
  isOpenCodeGoEndpoint,
  openCodeGoDiscoveryAdapter,
} from '../packages/cli/src/launcher/model-catalog/opencode-go.js'
import {
  isOpenRouterEndpoint,
  openRouterDiscoveryAdapter,
} from '../packages/cli/src/launcher/model-catalog/openrouter.js'
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
const connection = ({
  endpoint = 'https://api.deepseek.com',
  providerName = 'DeepSeek',
  fetcher = async () => response([]),
  bearer = vi.fn(async () => 'fixture-key'),
}: {
  endpoint?: string
  providerName?: string
  fetcher?: DiscoveryFetch
  bearer?: (signal: AbortSignal) => Promise<string>
} = {}) => ({
  endpoint,
  providerName,
  scopeRevision: 'account-1',
  request: vi.fn(createDiscoveryRequestCapability({
    operation: { origin: endpoint.replace(/\/$/u, ''), method: 'GET', path: '/models' },
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

  it('uses exact official endpoints and never redirects credentials from provider names', () => {
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
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/v1')).toBe(false)
    expect(isOpenRouterEndpoint('https://openrouter.ai/api/v1/')).toBe(true)
    expect(isOpenRouterEndpoint('https://openrouter.ai/v1')).toBe(false)
    const adapter = deepSeekDiscoveryAdapter()
    expect(() => new DiscoveryAdapterRegistry([adapter, adapter])).toThrow('Duplicate')
    expect(() =>
      new DiscoveryAdapterRegistry([adapter]).resolve(
        { endpoint: 'https://proxy.test', providerName: 'DeepSeek' },
        adapter.id,
      )
    ).toThrow(
      'unsupported',
    )
    expect(() => new DiscoveryAdapterRegistry([adapter, { ...adapter, id: 'other' }]).resolve(connection()))
      .toThrow('ambiguous')
    expect(() =>
      new DiscoveryAdapterRegistry([openRouterDiscoveryAdapter()]).resolve({
        endpoint: 'https://proxy.test/api/v1',
        providerName: 'OpenRouter',
      })
    ).toThrow('unsupported')
  })

  it('requests only the fixed list operation and preserves exact current and legacy IDs', async () => {
    const ids = [
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-flash',
      'deepseek-v4-pro',
      'unrelated',
      'deepseek-flash',
    ]
    const fetcher = vi.fn(async () => response(ids))
    const models = await deepSeekDiscoveryAdapter().discover(connection({ fetcher }), new AbortController().signal)
    expect(models.map(model => [model.id, model.protocolCapabilities?.responses])).toEqual([
      ['deepseek-flash', true],
      ['deepseek-v4-flash', true],
      ['deepseek-v4-flash-vision-exp', true],
      ['deepseek-v4-pro', true],
      ['unrelated', undefined],
    ])
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
    const owner = connection({ endpoint: 'https://proxy.test' })
    await expect(deepSeekDiscoveryAdapter().discover(owner, new AbortController().signal)).rejects.toThrow(
      'unsupported',
    )
    expect(owner.request).not.toHaveBeenCalled()
  })

  it('cancels a credential callback that ignores its signal without issuing a request', async () => {
    const abort = new AbortController()
    const fetcher = vi.fn(async () => response([]))
    const owner = connection({ fetcher, bearer: vi.fn(() => new Promise<string>(() => {})) })
    const request = deepSeekDiscoveryAdapter().discover(owner, abort.signal)
    abort.abort()
    await expect(request).rejects.toThrow('cancelled')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects oversized bodies and invalid UTF-8 without retaining their content', async () => {
    for (const body of [' '.repeat(MAX_DISCOVERY_RESPONSE_BYTES + 1), new Uint8Array([0xff])]) {
      await expect(
        deepSeekDiscoveryAdapter().discover(
          connection({
            fetcher: async () =>
              new Response(body, {
                headers: { 'content-type': 'application/json' },
              }),
          }),
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
      const owner = connection({
        fetcher: async () => new Response('private fixture diagnostic', { status: Number(status) }),
      })
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
        deepSeekDiscoveryAdapter().discover(
          connection({ fetcher: async () => Response.json(body) }),
          new AbortController().signal,
        ),
      )
        .rejects.toThrow('protocol')
    }
  })

  it('discovers the OpenCode Go snapshot without turning observed IDs into capability claims or limits', async () => {
    const ids = [
      'deepseek-flash',
      'deepseek-v4-pro',
      'gpt-5.6-luna',
      ...Array.from({ length: 31 }, (_, index) => `fixture-${index}`),
    ]
    const fetcher = vi.fn(async () => response(ids))
    const models = await openCodeGoDiscoveryAdapter().discover(
      connection({
        endpoint: 'https://opencode.ai/zen/go/v1',
        providerName: 'OpenCode Go',
        fetcher,
      }),
      new AbortController().signal,
    )
    expect(models).toHaveLength(34)
    expect(models.map(model => model.id)).toContain('gpt-5.6-luna')
    expect(models.every(model => model.protocolCapabilities === undefined)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-key' }) }),
    )
  })

  it('retains the complete OpenRouter catalog while marking bounded interactive Responses candidates', async () => {
    const compatible = Array.from({ length: 293 }, (_, index) => ({
      id: index === 0 ? 'openai/o4-mini' : `fixture/compatible-${index}`,
      name: `Compatible ${index}`,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'tool_choice'],
    }))
    const incompatible = [
      ...Array.from({ length: 161 }, (_, index) => ({
        id: `fixture/unconfirmed-${index}`,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      })),
      {
        id: '~fixture/dynamic-latest',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'tool_choice'],
      },
      {
        id: 'fixture/batch:batch',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'tool_choice'],
      },
      {
        id: 'fixture/image-output',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        supported_parameters: ['tools', 'tool_choice'],
      },
      {
        id: 'fixture/no-tools',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tool_choice'],
      },
    ]
    const data = [...compatible, ...incompatible]
    const fetcher = vi.fn(async () => Response.json({ data, total_count: 458, links: { next: null } }))
    const models = await openRouterDiscoveryAdapter().discover(
      connection({
        endpoint: 'https://openrouter.ai/api/v1',
        providerName: 'OpenRouter',
        fetcher,
      }),
      new AbortController().signal,
    )
    expect(models).toHaveLength(458)
    expect(models.filter(model => model.protocolCapabilities?.responses === true)).toHaveLength(293)
    expect(models.find(model => model.id === 'openai/o4-mini')).toMatchObject({
      protocolCapabilities: { responses: true },
    })
    expect(models.slice(-4).every(model => model.protocolCapabilities?.responses === false)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-key' }) }),
    )
  })

  it('rejects incomplete OpenRouter pages and malformed candidate metadata atomically', async () => {
    const owner = (body: unknown) =>
      connection({
        endpoint: 'https://openrouter.ai/api/v1',
        providerName: 'OpenRouter',
        fetcher: async () => Response.json(body),
      })
    await expect(
      openRouterDiscoveryAdapter().discover(
        owner({ data: [], total_count: 1, links: { next: '/models?offset=1' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('protocol')
    await expect(
      openRouterDiscoveryAdapter().discover(
        owner({ data: [{ id: 'openai/o4-mini', architecture: {}, supported_parameters: ['tools'] }] }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('protocol')
  })
})
