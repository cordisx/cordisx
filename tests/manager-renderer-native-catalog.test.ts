import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createManagerRendererNativeCatalogChannel } from '../packages/cli/src/cli/manager-renderer-native-catalog.js'

const envelope = (requestId: string) => JSON.stringify({ version: 1, requestId, operation: 'read' })
const context = (signal: AbortSignal, admitted = true) => ({
  profileId: 'default',
  rendererId: 'a'.repeat(64),
  ownerGeneration: 'owner-1',
  signal,
  admitted,
})

it('projects the selected Codex configuration without credentials or private paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-native-catalog-'))
  const codexHome = path.join(root, 'codex')
  const configPath = path.join(root, 'config.json')
  const controller = new AbortController()
  try {
    await mkdir(codexHome)
    const config = JSON.parse(JSON.stringify(createDefaultHomeConfig()))
    config.apps.codex.profiles.default.configModelCatalogs = { fixture: 'models.json' }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "fixture"',
        'model = "example-model"',
        '[model_providers.fixture]',
        'name = "Fixture"',
        'base_url = "https://private.example.test/v1"',
        'env_key = "FIXTURE_SECRET_ENV"',
        'experimental_bearer_token = "fixture-private-token"',
      ].join('\n'),
    )
    await writeFile(
      path.join(codexHome, 'models.json'),
      JSON.stringify({
        models: [{ slug: 'example-model', display_name: 'Example', base_instructions: 'fixture-private-instructions' }],
      }),
    )
    const channel = createManagerRendererNativeCatalogChannel({
      configPath,
      codexHome,
      profileId: 'default',
      generation: 'owner-1',
      isCurrent: () => true,
    })
    const operation = channel.prepare(envelope('read-1'), context(controller.signal))
    expect(operation.mode).toBe('read')
    const result = await operation.dispatch() as any
    expect(result).toMatchObject({
      requestId: 'read-1',
      ok: true,
      value: {
        status: 'ok',
        providers: [{ providerId: 'fixture', models: [{ id: 'example-model', label: 'Example' }] }],
      },
    })
    const serialized = JSON.stringify(result)
    for (
      const secret of [
        'fixture-private-token',
        'FIXTURE_SECRET_ENV',
        'private.example.test',
        root,
        'fixture-private-instructions',
      ]
    ) {
      expect(serialized).not.toContain(secret)
    }
    await writeFile(path.join(codexHome, 'models.json'), JSON.stringify({ models: [{ slug: 'updated-model' }] }))
    const updated = await channel.prepare(envelope('read-2'), context(controller.signal)).dispatch() as any
    expect(updated.value.providers[0].models.map((item: { id: string }) => item.id)).toEqual(['updated-model'])
    const repeated = await channel.prepare(envelope('read-2'), context(controller.signal)).dispatch() as any
    expect(repeated.value.providers[0].models[0].id).toBe('updated-model')
    expect(() => channel.prepare(envelope('read-3'), context(controller.signal, false))).toThrow()
    expect(() =>
      channel.prepare(JSON.stringify({ version: 1, requestId: 'x', operation: 'write' }), context(controller.signal))
    )
      .toThrow()
    controller.abort()
    expect(() => channel.prepare(envelope('read-4'), context(controller.signal))).toThrow()
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not return a catalog after its owner session becomes stale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-native-catalog-stale-'))
  const controller = new AbortController()
  let current = true
  try {
    const channel = createManagerRendererNativeCatalogChannel({
      configPath: path.join(root, 'missing.json'),
      codexHome: root,
      profileId: 'default',
      generation: 'owner-1',
      isCurrent: () => current,
    })
    expect(() => channel.prepare(envelope('other-profile'), { ...context(controller.signal), profileId: 'other' }))
      .toThrow()
    expect(() =>
      channel.prepare(envelope('other-owner'), { ...context(controller.signal), ownerGeneration: 'owner-2' })
    )
      .toThrow()
    const pending = channel.prepare(envelope('pending'), context(controller.signal))
    current = false
    await expect(pending.dispatch()).rejects.toThrow('NATIVE_CATALOG_UNAVAILABLE')
    expect(() => channel.prepare(envelope('read'), context(controller.signal))).toThrow()
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
})
