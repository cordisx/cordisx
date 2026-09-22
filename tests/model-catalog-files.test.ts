import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCatalogFile, watchCatalogFiles } from '../packages/cli/src/launcher/model-catalog/file-source.js'
import { dynamicConfiguredCatalog } from '../packages/cli/src/launcher/model-catalog/configured-source.js'
import { AtomicCatalogStore } from '../packages/cli/src/launcher/model-catalog/atomic-store.js'
import { catalogModels, type CatalogSnapshot } from '../packages/cli/src/launcher/model-catalog/contracts.js'

describe('dynamic catalog file boundary', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
  const fixture = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    return directory
  }

  it('parses legacy and simple catalogs, including authoritative empty', async () => {
    const file = path.join(await fixture(), 'models.json')
    await writeFile(file, JSON.stringify({ models: [{ slug: 'exact', display_name: 'Label' }] }))
    expect(await readCatalogFile(file)).toEqual([{ id: 'exact', label: 'Label', aliases: [] }])
    await writeFile(file, JSON.stringify({ models: [] }))
    expect(await readCatalogFile(file)).toEqual([])
    await writeFile(file, '{')
    await expect(readCatalogFile(file)).rejects.toThrow('source-invalid')
  })

  it('observes atomic replacement and stops on disposal', async () => {
    const directory = await fixture()
    const file = path.join(directory, 'models.json')
    await writeFile(file, '{}')
    const changed = vi.fn()
    const watcher = watchCatalogFiles([file], changed, { debounceMs: 10, reconcileMs: 50 })
    cleanups.push(() => watcher.dispose())
    await writeFile(path.join(directory, 'temporary'), '{"models":[]}')
    await rename(path.join(directory, 'temporary'), file)
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    watcher.dispose()
    changed.mockClear()
    await writeFile(file, '{}')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(changed).not.toHaveBeenCalled()
  })

  it('retains same-config catalog LKG on invalid file but honors complete-empty and provider deletion', async () => {
    const directory = await fixture()
    const config = path.join(directory, 'config.toml')
    const file = path.join(directory, 'models.json')
    await writeFile(config, '[model_providers.test]\nname="Test"\n')
    await writeFile(file, '{"models":[{"slug":"known"}]}')
    const source = dynamicConfiguredCatalog({ codexHome: directory, catalogs: { test: 'models.json' } })
    cleanups.push(() => source.dispose())
    await source.refresh()
    expect(source.snapshot().providers[0]?.models[0]?.id).toBe('known')
    await writeFile(file, '{')
    await source.refresh()
    expect(source.snapshot().providers[0]?.models[0]?.id).toBe('known')
    expect(source.snapshot().diagnostics).toContainEqual({ providerId: 'test', code: 'catalog-unavailable' })
    await writeFile(file, '{"models":[]}')
    await source.refresh()
    expect(source.snapshot().providers[0]?.models).toEqual([])
    await writeFile(config, '')
    await source.refresh()
    expect(source.snapshot().providers).toEqual([])
  })

  it('does not reuse catalog LKG after connection configuration changes', async () => {
    const directory = await fixture()
    const config = path.join(directory, 'config.toml')
    const file = path.join(directory, 'models.json')
    await writeFile(config, '[model_providers.test]\nbase_url="https://old.invalid"\n')
    await writeFile(file, '{"models":[{"slug":"known"}]}')
    const source = dynamicConfiguredCatalog({ codexHome: directory, catalogs: { test: 'models.json' } })
    cleanups.push(() => source.dispose())
    await source.refresh()
    await writeFile(config, '[model_providers.test]\nbase_url="https://new.invalid"\n')
    await writeFile(file, '{')
    await source.refresh()
    expect(source.snapshot().providers[0]?.models).toEqual([])
  })

  it('atomically saves an owner snapshot and preserves external edits', async () => {
    const file = path.join(await fixture(), 'manifest.json')
    const store = new AtomicCatalogStore(file)
    const snapshot: CatalogSnapshot = {
      bindingRef: 'one',
      scopeRevision: 'account',
      authorityRevision: 'manual',
      revision: 1,
      models: catalogModels(['model']),
      complete: true,
      freshness: 'fresh',
      loading: false,
    }
    expect(await store.commit(snapshot, () => false)).toBe('stale')
    expect(await store.commit(snapshot, () => true)).toBe('applied')
    await writeFile(file, '{"user":"edit"}')
    expect(await store.commit({ ...snapshot, revision: 2 }, () => true)).toBe('conflict')
  })
})
