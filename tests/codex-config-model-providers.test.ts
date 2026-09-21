import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
        'base_url = "https://api.deepseek.example/v1"',
        'env_key = "DEEPSEEK_API_KEY"',
        'experimental_bearer_token = "never-project-this-token"',
      ].join('\n'),
    )

    const projection = await codexConfigModelProviders(codexHome)
    expect(projection.providers).toEqual([{
      providerId: 'deepseek',
      pluginId: 'cordisx.codex-config',
      title: 'DeepSeek',
      defaultModelId: 'deepseek-reasoner',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', aliases: ['chat'] },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', aliases: [] },
      ],
    }])
    expect([...projection.providerIds]).toEqual(['deepseek'])
    expect(JSON.stringify(projection)).not.toMatch(/base_url|env_key|bearer|token|instruction|api\.deepseek/u)
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

  it('keeps the current model selectable when config omits model_provider and a catalog', async () => {
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
        models: [{ id: 'deepseek-chat', label: 'deepseek-chat', aliases: [] }],
      }],
    })
  })
})
