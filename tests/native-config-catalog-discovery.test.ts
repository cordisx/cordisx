import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeConfigCatalogDiscovery } from '../packages/cli/src/launcher/model-catalog/native-config-catalog-discovery.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function config(lines: readonly string[]) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cx-native-discovery-'))
  roots.push(codexHome)
  await mkdir(codexHome, { recursive: true })
  await writeFile(path.join(codexHome, 'config.toml'), lines.join('\n'))
  return codexHome
}

describe('native config catalog discovery', () => {
  it('uses the exact supported endpoint and resolves its bearer only inside the Host request', async () => {
    const codexHome = await config([
      '[model_providers.deepseek]',
      'name = "DeepSeek"',
      'base_url = "https://api.deepseek.com/"',
      'env_key = "DEEPSEEK_KEY"',
      'wire_api = "responses"',
    ])
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'future-model', object: 'model', owned_by: 'deepseek' },
        ],
      })
    )
    const discovery = new NativeConfigCatalogDiscovery({
      environment: () => ({ DEEPSEEK_KEY: 'host-secret' }),
      fetcher,
    })

    const projection = await discovery.load({ codexHome })
    await discovery.refresh('deepseek')

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: 'Bearer host-secret' },
      }),
    )
    expect(discovery.snapshot('deepseek')?.models).toEqual([
      expect.objectContaining({ id: 'deepseek-flash', protocolCapabilities: { responses: true } }),
      expect.objectContaining({ id: 'future-model' }),
    ])
    expect(JSON.stringify(projection)).not.toContain('host-secret')
    expect(JSON.stringify(discovery.snapshot('deepseek'))).not.toContain('host-secret')
    discovery.dispose()
  })

  it('does not request unsupported endpoints or fall back when the selected environment lacks the key', async () => {
    const unknownHome = await config([
      '[model_providers.modelhub]',
      'base_url = "https://modelhub.example/v1"',
      'env_key = "MODELHUB_KEY"',
      '[model_providers.normalized-lookalike]',
      'base_url = "https://api.deepseek.com/v1/../"',
      'env_key = "DEEPSEEK_KEY"',
    ])
    const missingHome = await config([
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'env_key = "DEEPSEEK_KEY"',
    ])
    const fetcher = vi.fn(async () => Response.json({ object: 'list', data: [] }))
    const discovery = new NativeConfigCatalogDiscovery({ environment: () => ({}), fetcher })

    await discovery.load({ codexHome: unknownHome })
    await discovery.refresh('modelhub')
    expect(discovery.has('modelhub')).toBe(false)
    expect(discovery.has('normalized-lookalike')).toBe(false)
    await discovery.load({ codexHome: missingHome })
    await discovery.refresh('deepseek')
    expect(fetcher).not.toHaveBeenCalled()
    expect(discovery.snapshot('deepseek')).toMatchObject({ error: 'credential-unavailable', models: [] })
    discovery.dispose()
  })

  it('keeps static projection available while profile-level discovery is disabled', async () => {
    const codexHome = await config([
      'model_provider = "deepseek"',
      'model = "deepseek-flash"',
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'env_key = "DEEPSEEK_KEY"',
    ])
    const fetcher = vi.fn(async () => Response.json({ object: 'list', data: [] }))
    const discovery = new NativeConfigCatalogDiscovery({
      environment: () => ({ DEEPSEEK_KEY: 'host-secret' }),
      fetcher,
      enabled: false,
    })

    const projection = await discovery.load({ codexHome })
    await discovery.refresh('deepseek')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(projection.providers[0]).toMatchObject({
      providerId: 'deepseek',
      models: [{ id: 'deepseek-flash' }],
    })
    expect(discovery.has('deepseek')).toBe(false)
    expect(discovery.snapshot('deepseek')).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    discovery.dispose()
  })

  it('cancels an old request and invalidates its LKG when endpoint or credential identity changes', async () => {
    const codexHome = await config([
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'env_key = "FIRST_KEY"',
    ])
    let environment: Readonly<Record<string, string | undefined>> = { FIRST_KEY: 'first', SECOND_KEY: 'second' }
    let oldSignal: AbortSignal | undefined
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      oldSignal = init.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        oldSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const discovery = new NativeConfigCatalogDiscovery({ environment: () => environment, fetcher })
    await discovery.load({ codexHome })
    const firstScope = discovery.snapshot('deepseek')?.scopeRevision
    const pending = discovery.refresh('deepseek')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())

    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.deepseek]',
        'base_url = "https://api.deepseek.com/"',
        'env_key = "SECOND_KEY"',
      ].join('\n'),
    )
    environment = { FIRST_KEY: 'first', SECOND_KEY: 'second' }
    await discovery.load({ codexHome })
    await pending

    expect(oldSignal?.aborted).toBe(true)
    expect(discovery.snapshot('deepseek')).toMatchObject({ models: [], complete: false })
    expect(discovery.snapshot('deepseek')?.scopeRevision).not.toBe(firstScope)
    discovery.dispose()
  })

  it('keeps the configured scope stable across launches without hashing secret contents', async () => {
    const codexHome = await config([
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'env_key = "DEEPSEEK_KEY"',
    ])
    const first = new NativeConfigCatalogDiscovery({ environment: () => ({ DEEPSEEK_KEY: 'first-secret' }) })
    const second = new NativeConfigCatalogDiscovery({ environment: () => ({ DEEPSEEK_KEY: 'second-secret' }) })
    await first.load({ codexHome })
    await second.load({ codexHome })
    expect(first.snapshot('deepseek')?.scopeRevision).toBe(second.snapshot('deepseek')?.scopeRevision)
    first.dispose()
    second.dispose()
  })

  it('rotates scope when an inline credential changes in the same Host lifetime', async () => {
    const codexHome = await config([
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'experimental_bearer_token = "first-secret"',
    ])
    const discovery = new NativeConfigCatalogDiscovery({ environment: () => ({}) })
    await discovery.load({ codexHome })
    const firstScope = discovery.snapshot('deepseek')?.scopeRevision
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.deepseek]',
        'base_url = "https://api.deepseek.com"',
        'experimental_bearer_token = "second-secret"',
      ].join('\n'),
    )
    await discovery.load({ codexHome })
    expect(discovery.snapshot('deepseek')?.scopeRevision).not.toBe(firstScope)
    expect(JSON.stringify(discovery.snapshot('deepseek'))).not.toMatch(/first-secret|second-secret/u)
    discovery.dispose()
  })
})
