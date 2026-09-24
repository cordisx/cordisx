import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-codex-provider-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

describe('Codex config model providers', () => {
  it('projects only provider identity and model metadata from a relative catalog', async () => {
    const codexHome = await home()
    await writeFile(
      path.join(codexHome, 'models.json'),
      JSON.stringify({
        models: [
          { slug: 'deepseek-chat', display_name: 'DeepSeek Chat', aliases: ['chat'], base_instructions: 'private' },
          { slug: 'deepseek-chat', display_name: 'Duplicate' },
          { slug: 'deepseek-reasoner', display_name: 'DeepSeek Reasoner' },
        ],
      }),
    )
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model = "deepseek-reasoner"',
        'model_provider = "deepseek"',
        'model_catalog_json = "models.json"',
        '[model_providers.deepseek]',
        'name = "DeepSeek"',
        'wire_api = "responses"',
        'base_url = "https://api.deepseek.example/v1"',
        'env_key = "DEEPSEEK_API_KEY"',
        'experimental_bearer_token = "never-project-this-token"',
      ].join('\n'),
    )

    const projection = await codexConfigModelProviders(codexHome, { deepseek: 'models.json' })
    expect(projection.providers).toEqual([{
      providerId: 'deepseek',
      pluginId: 'cordisx.codex-config',
      title: 'DeepSeek',
      selectorBrand: { brand: 'deepseek', source: 'inferred' },
      defaultModelId: 'deepseek-reasoner',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', aliases: ['chat'] },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', aliases: [] },
      ],
    }])
    expect([...projection.providerIds]).toEqual(['deepseek'])
    expect([...projection.providerWireApis]).toEqual([['deepseek', 'responses']])
    expect(JSON.stringify(projection)).not.toMatch(/base_url|env_key|bearer|token|instruction|api\.deepseek/u)
  })

  it('keeps explicit provider and exact model overrides separate from endpoint inference', async () => {
    const codexHome = await home()
    await writeFile(
      path.join(codexHome, 'models.json'),
      JSON.stringify({
        models: [{ slug: 'anthropic/claude-sonnet-4', display_name: 'Claude' }],
      }),
    )
    await writeFile(
      path.join(codexHome, 'config.toml'),
      '[model_providers.gateway]\nname="OpenAI"\nbase_url="https://openrouter.ai/api/v1"\n',
    )
    const { providers } = await codexConfigModelProviders(
      codexHome,
      { gateway: 'models.json' },
      { providers: { gateway: 'generic' }, models: { gateway: { 'anthropic/claude-sonnet-4': 'claude' } } },
    )
    expect(providers[0]).toMatchObject({
      selectorBrand: { brand: 'generic', source: 'override' },
      models: [{ id: 'anthropic/claude-sonnet-4', selectorBrand: 'claude' }],
    })
    expect(JSON.stringify(providers)).not.toContain('openrouter.ai')
  })

  it.each([
    { name: 'missing catalog', catalog: undefined },
    { name: 'invalid catalog', catalog: '{not-json' },
    { name: 'catalog without models', catalog: '{}' },
  ])('retains only the active provider model when the $name is unavailable', async ({ catalog }) => {
    const codexHome = await home()
    if (catalog !== undefined) await writeFile(path.join(codexHome, 'models.json'), catalog)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model = "deepseek-chat"',
        'model_provider = "deepseek"',
        'model_catalog_json = "models.json"',
        '[model_providers.deepseek]',
        'base_url = "https://api.deepseek.example/v1"',
        '[model_providers.other]',
        'base_url = "https://other.example/v1"',
      ].join('\n'),
    )

    const projection = await codexConfigModelProviders(codexHome)
    expect(projection.providers).toEqual([
      expect.objectContaining({
        providerId: 'deepseek',
        defaultModelId: 'deepseek-chat',
        models: [{ id: 'deepseek-chat', label: 'deepseek-chat', aliases: [] }],
      }),
      expect.objectContaining({ providerId: 'other', models: [] }),
    ])
  })

  it('returns an empty projection for missing or invalid config and ignores reserved provider ids', async () => {
    const codexHome = await home()
    await expect(codexConfigModelProviders(codexHome)).resolves.toMatchObject({ providers: [] })
    await writeFile(path.join(codexHome, 'config.toml'), 'invalid = [')
    await expect(codexConfigModelProviders(codexHome)).resolves.toMatchObject({ providers: [] })
    await writeFile(path.join(codexHome, 'config.toml'), '[model_providers.openai]\nname = "Shadow"\n')
    await expect(codexConfigModelProviders(codexHome)).resolves.toMatchObject({ providers: [] })
  })

  it('retains only recognized provider wire APIs in the Host-private projection', async () => {
    const codexHome = await home()
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.responses]',
        'wire_api = "responses"',
        '[model_providers.chat]',
        'wire_api = "chat-completions"',
        '[model_providers.unknown]',
        'wire_api = "future"',
      ].join('\n'),
    )
    const projection = await codexConfigModelProviders(codexHome)
    expect([...projection.providerWireApis]).toEqual([
      ['responses', 'responses'],
      ['chat', 'chat-completions'],
    ])
    expect(JSON.stringify(projection)).not.toContain('wire_api')
  })

  it('does not infer ownership from a single provider when model_provider is omitted', async () => {
    const codexHome = await home()
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model = "deepseek-chat"',
        '[model_providers.deepseek]',
        'name = "DeepSeek"',
        'base_url = "https://api.deepseek.example/v1"',
      ].join('\n'),
    )

    await expect(codexConfigModelProviders(codexHome)).resolves.toMatchObject({
      providers: [{
        providerId: 'deepseek',
        pluginId: 'cordisx.codex-config',
        title: 'DeepSeek',
        models: [],
      }],
    })
  })

  it('uses global metadata only for explicitly bound model IDs and preserves the source files', async () => {
    const codexHome = await home()
    const catalog = JSON.stringify({
      models: [
        { slug: 'shared', display_name: 'Shared' },
        { slug: 'gpt-valid-on-gateway', display_name: 'Gateway model' },
        { slug: 'unbound', display_name: 'Not owned' },
      ],
    })
    await writeFile(path.join(codexHome, 'models.json'), catalog)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "first"',
        'model = "shared"',
        'model_catalog_json = "models.json"',
        '[model_providers.first]',
        'name = "First"',
        '[model_providers.second]',
        'name = "Second"',
        '[profiles.a]',
        'model_provider = "second"',
        'model = "shared"',
        '[profiles.b]',
        'model_provider = "second"',
        'model = "gpt-valid-on-gateway"',
        '[profiles.unknown]',
        'model_provider = "unknown"',
        'model_catalog_json = "models.json"',
        '[profiles.unbound]',
        'model = "unbound"',
        'model_catalog_json = "models.json"',
      ].join('\n'),
    )
    const { providers } = await codexConfigModelProviders(codexHome)
    expect(providers.map(provider => [provider.providerId, provider.models.map(model => model.id)])).toEqual([
      ['first', ['shared']],
      ['second', []],
    ])
    expect(providers[0]?.models[0]?.label).toBe('Shared')
    expect(await readFile(path.join(codexHome, 'models.json'), 'utf8')).toBe(catalog)
  })

  it('isolates Host profile mappings and keeps shared IDs provider-local without scanning native profiles', async () => {
    const codexHome = await home()
    for (
      const [name, models] of Object.entries({
        a: [{ slug: 'shared', display_name: 'First label' }, { slug: 'a' }],
        b: [{ slug: 'shared', display_name: 'Later label' }, { slug: 'b' }],
        c: [{ slug: 'shared', display_name: 'Other provider label' }],
      })
    ) await writeFile(path.join(codexHome, `${name}.json`), JSON.stringify({ models }))
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.first]',
        '[model_providers.second]',
        '[model_providers.empty]',
        '[profiles.a]',
        'model_provider = "first"',
        'model_catalog_json = "a.json"',
        '[profiles.b]',
        'model_provider = "first"',
        'model_catalog_json = "b.json"',
        '[profiles.c]',
        'model_provider = "second"',
        'model_catalog_json = "c.json"',
        '[profiles.missing]',
        'model_provider = "second"',
        'model_catalog_json = "missing.json"',
        'model = "explicit"',
        '[profiles.empty]',
        'model_provider = "empty"',
        'model_catalog_json = "missing.json"',
      ].join('\n'),
    )
    const { providers } = await codexConfigModelProviders(codexHome, {
      first: 'b.json',
      second: 'c.json',
      empty: 'missing.json',
    })
    expect(providers.map(provider => provider.models.map(model => [model.id, model.label]))).toEqual([
      [['shared', 'Later label'], ['b', 'b']],
      [['shared', 'Other provider label']],
      [],
    ])
    const otherProfile = await codexConfigModelProviders(codexHome, { first: 'a.json' })
    expect(otherProfile.providers[0]?.models.map(model => model.id)).toEqual(['shared', 'a'])
    expect(otherProfile.providers[1]?.models).toEqual([])
  })

  it.each([
    ['missing', undefined, 'catalog-unavailable'],
    ['invalid JSON', '{bad', 'catalog-unavailable'],
    ['invalid shape', '{}', 'catalog-unavailable'],
    ['invalid entry', '{"models":[{"slug":123}]}', 'catalog-unavailable'],
    ['empty', '{"models":[]}', 'catalog-empty'],
  ])('keeps an explicit %s mapping authoritative and emits only sanitized diagnostics', async (_name, body, code) => {
    const codexHome = await home()
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'model_provider="first"\nmodel="old"\n[model_providers.first]\n',
    )
    if (body !== undefined) await writeFile(path.join(codexHome, 'catalog.json'), body)
    const result = await codexConfigModelProviders(codexHome, { first: 'catalog.json', removed: 'do-not-read.json' })
    expect(result.providers).toEqual([expect.objectContaining({ providerId: 'first', models: [] })])
    expect(result.providers[0]).not.toHaveProperty('defaultModelId')
    expect(result.diagnostics).toEqual([{ providerId: 'first', code }, {
      providerId: 'removed',
      code: 'provider-missing',
    }])
    expect(JSON.stringify(result)).not.toContain(codexHome)
  })

  it('preserves a multi-vendor gateway and rereads removals without changing global catalogs', async () => {
    const codexHome = await home()
    await writeFile(path.join(codexHome, 'config.toml'), '[model_providers.gateway]\n')
    await writeFile(
      path.join(codexHome, 'catalog.json'),
      JSON.stringify({ models: [{ slug: 'deepseek-valid' }, { slug: 'gpt-valid' }] }),
    )
    expect(
      (await codexConfigModelProviders(codexHome, { gateway: 'catalog.json' })).providers[0]?.models.map(model =>
        model.id
      ),
    )
      .toEqual(['deepseek-valid', 'gpt-valid'])
    await writeFile(path.join(codexHome, 'catalog.json'), '{"models":[]}')
    expect((await codexConfigModelProviders(codexHome, { gateway: 'catalog.json' })).providers[0]?.models).toEqual([])
  })
})
