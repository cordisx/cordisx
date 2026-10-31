import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { parseHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  buildClaudeConfigLibrary,
  mergeDeclaredIntoCodexProjection,
  modelServicesOf,
  projectModelServicesToCodex,
  projectModelServicesToClaude,
  readClaudeProviderCatalog,
  servicesForApp,
} from '../packages/cli/src/launcher/model-service-projection.js'

async function codexHome(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cordisx-model-service-'))
}

function configWith(providers: unknown[]): ReturnType<typeof parseHomeConfig> {
  return parseHomeConfig({
    version: 1,
    defaultApp: 'codex',
    providers,
    plugins: [],
    apps: { codex: { defaultProfile: 'default', profiles: { default: { displayName: 'D', dataMode: 'shared' } } } },
  })
}

const dualProtocol = {
  id: 'sub2tok',
  kind: 'model-service',
  displayName: 'sub2tok',
  baseUrl: 'https://api.sub2tok.com',
  apiKeyEnv: 'SUB2TOK_API_KEY',
  protocols: ['anthropic-messages', 'openai-responses'],
  models: { codex: ['gpt-6.1-sol'], claude: ['claude-opus-5-5'] },
}

describe('model-service provider declarations', () => {
  it('parses a declaration beside a gateway entry and keeps the two kinds apart', () => {
    const config = configWith([
      dualProtocol,
      {
        id: 'gw-a',
        kind: 'cli-proxy-api',
        displayName: 'Gateway',
        baseUrl: 'http://127.0.0.1:8317/v1',
        apiKeyEnv: 'CLIPROXY_A_API_KEY',
      },
    ])
    expect(config.providers.map(provider => provider.kind)).toEqual(['model-service', 'cli-proxy-api'])
    expect(modelServicesOf(config.providers).map(provider => provider.id)).toEqual(['sub2tok'])
  })

  it('rejects a declaration without a protocol, a non-https endpoint, and a bad environment name', () => {
    const base = { ...dualProtocol, models: undefined }
    expect(() => configWith([{ ...base, protocols: [] }])).toThrow(/protocols/)
    expect(() => configWith([{ ...base, baseUrl: 'http://api.sub2tok.com' }])).toThrow(/HTTPS or loopback/)
    expect(() => configWith([{ ...base, apiKeyEnv: 'lower-case' }])).toThrow(/environment name/)
  })

  it('selects declarations per app by protocol and appliesTo', () => {
    const config = configWith([
      dualProtocol,
      { ...dualProtocol, id: 'claude-only', protocols: ['anthropic-messages'], appliesTo: ['claude'] },
      { ...dualProtocol, id: 'disabled', enabled: false },
    ])
    expect(servicesForApp(config.providers, 'codex').map(provider => provider.id)).toEqual(['sub2tok'])
    expect(servicesForApp(config.providers, 'claude').map(provider => provider.id)).toEqual(['sub2tok', 'claude-only'])
  })

  it('writes a Codex provider table that keeps an existing table intact', async () => {
    const root = await codexHome()
    await writeFile(
      path.join(root, 'config.toml'),
      'model = "gpt-6.1-sol"\n\n[model_providers.sub2tok]\nname = "old"\nrequest_max_retries = 3\n',
    )
    const config = configWith([dualProtocol])
    const result = await projectModelServicesToCodex(config.providers, root)
    expect(result.providerIds).toEqual(['sub2tok'])

    const written = parse(await readFile(path.join(root, 'config.toml'), 'utf8')) as {
      model: string
      model_providers: Record<string, Record<string, unknown>>
    }
    expect(written.model).toBe('gpt-6.1-sol')
    const provider = written.model_providers.sub2tok!
    expect(provider.base_url).toBe('https://api.sub2tok.com')
    expect(provider.env_key).toBe('SUB2TOK_API_KEY')
    expect(provider.wire_api).toBe('responses')
    // A key this declaration does not own survives the projection.
    expect(provider.request_max_retries).toBe(3)
  })

  it('skips a declaration that speaks only a protocol Codex does not read', async () => {
    const root = await codexHome()
    const config = configWith([{ ...dualProtocol, protocols: ['anthropic-messages'] }])
    const result = await projectModelServicesToCodex(config.providers, root)
    expect(result.providerIds).toEqual([])
    expect(result.diagnostics).toEqual([{ appId: 'codex', providerId: 'sub2tok', code: 'protocol-unsupported' }])
  })

  it('points the launch default at the declared provider that was named', async () => {
    const root = await codexHome()
    await writeFile(path.join(root, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n')
    const config = configWith([dualProtocol, { ...dualProtocol, id: 'second', models: { codex: ['other-model'] } }])

    const result = await projectModelServicesToCodex(config.providers, root, { selectedId: 'second' })
    expect(result.selectedProviderId).toBe('second')

    const written = parse(await readFile(path.join(root, 'config.toml'), 'utf8')) as {
      model: string
      model_provider: string
    }
    expect(written.model_provider).toBe('second')
    expect(written.model).toBe('other-model')
  })

  it('leaves the configured default alone when no provider is named', async () => {
    const root = await codexHome()
    await writeFile(path.join(root, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n')
    const config = configWith([dualProtocol])

    await projectModelServicesToCodex(config.providers, root)
    const written = parse(await readFile(path.join(root, 'config.toml'), 'utf8')) as {
      model: string
      model_provider: string
    }
    expect(written.model_provider).toBe('openai')
    expect(written.model).toBe('gpt-6.1-sol')
  })

  it('reports the declared provider as unavailable when the name does not match', async () => {
    const root = await codexHome()
    const config = configWith([dualProtocol])
    const result = await projectModelServicesToCodex(config.providers, root, { selectedId: 'missing' })
    expect(result.selectedProviderId).toBeUndefined()
    expect(result.providerIds).toEqual(['sub2tok'])
  })

  it('builds and writes the Claude configuration library with one applied entry', async () => {
    const config = configWith([dualProtocol, { ...dualProtocol, id: 'second' }])
    expect(buildClaudeConfigLibrary(config.providers).meta.appliedId).toBe('sub2tok')

    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-claude-library-'))
    const result = await projectModelServicesToClaude(config.providers, root)
    expect(result.providerIds).toEqual(['sub2tok', 'second'])

    const meta = JSON.parse(await readFile(path.join(root, 'configLibrary', '_meta.json'), 'utf8')) as {
      appliedId: string
      entries: Array<{ id: string; name: string }>
    }
    expect(meta.appliedId).toBe('sub2tok')
    expect(meta.entries.map(entry => entry.id)).toEqual(['sub2tok', 'second'])

    const entry = JSON.parse(await readFile(path.join(root, 'configLibrary', 'sub2tok.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(entry.inferenceGatewayBaseUrl).toBe('https://api.sub2tok.com')
    expect(entry.inferenceGatewayApiKeyEnv).toBe('SUB2TOK_API_KEY')
    expect(entry.inferenceProvider).toBe('gateway')
  })

  it('merges declarations into the catalog read from config.toml, declaration first', () => {
    const config = configWith([dualProtocol])
    // A native table left behind by an earlier projection, plus one the user wrote by hand.
    const native = {
      providers: [
        { providerId: 'sub2tok', pluginId: 'cordisx.codex-config', title: 'stale', models: [] },
        { providerId: 'handwritten', pluginId: 'cordisx.codex-config', title: 'Hand', models: [] },
      ],
      providerIds: new Set(['sub2tok', 'handwritten']),
      providerWireApis: new Map<'sub2tok' | 'handwritten', 'responses' | 'chat-completions'>([
        ['sub2tok', 'chat-completions'],
        ['handwritten', 'responses'],
      ]),
      diagnostics: [],
    }

    const merged = mergeDeclaredIntoCodexProjection(native, config.providers)
    expect(merged.providers.map(provider => provider.providerId)).toEqual(['handwritten', 'sub2tok'])
    // The declaration wins: its title and models replace the copy on disk.
    expect(merged.providers[1]!.title).toBe('sub2tok')
    expect(merged.providers[1]!.models.map(model => model.id)).toEqual(['gpt-6.1-sol'])
    expect(merged.providerWireApis.get('sub2tok')).toBe('responses')
    expect([...merged.providerIds].sort()).toEqual(['handwritten', 'sub2tok'])
  })

  it('leaves a Codex projection untouched when nothing is declared', () => {
    const native = {
      providers: [{ providerId: 'handwritten', pluginId: 'cordisx.codex-config', title: 'Hand', models: [] }],
      providerIds: new Set(['handwritten']),
      providerWireApis: new Map<string, 'responses' | 'chat-completions'>(),
      diagnostics: [],
    }
    const merged = mergeDeclaredIntoCodexProjection(native, [])
    expect(merged).toBe(native)
  })

  it('reads Claude providers from both the declarations and the library on disk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-claude-catalog-'))
    await mkdir(path.join(root, 'configLibrary'), { recursive: true })
    await writeFile(
      path.join(root, 'configLibrary', '_meta.json'),
      JSON.stringify({ appliedId: 'sub2tok', entries: [{ id: 'sub2tok', name: 'old' }, { id: 'by-hand', name: 'By hand' }] }),
    )
    await writeFile(
      path.join(root, 'configLibrary', 'by-hand.json'),
      JSON.stringify({ inferenceGatewayBaseUrl: 'https://hand.example.com', inferenceGatewayApiKey: 'secret' }),
    )

    const config = configWith([dualProtocol])
    const catalog = await readClaudeProviderCatalog(config.providers, root)
    expect(catalog.map(entry => [entry.providerId, entry.source])).toEqual([
      ['sub2tok', 'declared'],
      ['by-hand', 'library'],
    ])
    expect(catalog[0]!.models).toEqual(['claude-opus-5-5'])
    expect(catalog[1]!.baseUrl).toBe('https://hand.example.com')
    expect(catalog[0]!.applied).toBe(true)
    // The library document's inline key never reaches the catalog.
    expect(JSON.stringify(catalog)).not.toContain('secret')
  })
})
