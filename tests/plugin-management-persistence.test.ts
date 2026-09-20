import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE } from '../packages/cli/src/management/contracts.js'
import {
  loadPluginManagementConfig,
  migrateLegacyPluginManagementSources,
  updatePluginManagementConfig,
} from '../packages/cli/src/management/persistence.js'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-'))
  roots.push(root)
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  return { root, configPath, profileId: 'default' }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('plugin management persistence', () => {
  it('projects defaults without rewriting an old home document', async () => {
    const target = await fixture()
    const before = await loadHomeConfig(target.configPath)
    expect(before.apps.codex?.profiles.default?.management).toBeUndefined()
    expect(await loadPluginManagementConfig(target)).toEqual({
      revision: 0,
      sources: [{ url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE, enabled: true, trusted: true }],
      hiddenCatalogEntries: [],
    })
    expect((await loadHomeConfig(target.configPath)).apps.codex?.profiles.default?.management).toBeUndefined()
  })

  it('atomically edits source identity and moves its hidden entries', async () => {
    const target = await fixture()
    const first = 'http://127.0.0.1:4173/marketplace.json'
    const second = 'http://127.0.0.1:5173/marketplace.json'
    await updatePluginManagementConfig(target, {
      kind: 'source-add',
      source: { url: first, enabled: true, trusted: false, local: { name: 'Local' } },
    })
    await updatePluginManagementConfig(target, {
      kind: 'catalog-hide',
      identity: { sourceUrl: first, pluginId: 'example-plugin' },
    })
    const result = await updatePluginManagementConfig(target, {
      kind: 'source-edit',
      url: first,
      source: { url: second, enabled: false, trusted: false, local: { name: 'Replacement' } },
    })
    expect(result.sources.at(-1)).toMatchObject({
      url: second,
      enabled: false,
      local: { name: 'Replacement' },
    })
    expect(result.hiddenCatalogEntries).toEqual([{ sourceUrl: second, pluginId: 'example-plugin' }])
  })

  it('merges legacy sources once without replacing CLI-owned records or resurrecting deletions', async () => {
    const target = await fixture()
    const shared = 'https://example.test/shared.json?channel=beta'
    const legacyOnly = 'http://localhost:4173/legacy.json'
    await updatePluginManagementConfig(target, {
      kind: 'source-add',
      source: { url: shared, enabled: false, trusted: false, local: { name: 'CLI value' } },
    })
    const first = await migrateLegacyPluginManagementSources(target, {
      sources: [
        { url: shared, enabled: true, local: { name: 'Legacy value', note: 'legacy note' } },
        { url: legacyOnly, enabled: true, local: { note: 'keep me' } },
      ],
    })
    expect(first.migrated).toBe(true)
    expect(first.management.sources.find(source => source.url === shared)).toMatchObject({
      enabled: false,
      trusted: false,
      local: { name: 'CLI value', note: 'legacy note' },
    })
    expect(first.management.sources.find(source => source.url === legacyOnly)?.trusted).toBe(false)
    await updatePluginManagementConfig(target, { kind: 'source-remove', url: legacyOnly })
    const second = await migrateLegacyPluginManagementSources(target, {
      sources: [{ url: legacyOnly, enabled: true }],
    })
    expect(second.migrated).toBe(false)
    expect(second.management.sources.some(source => source.url === legacyOnly)).toBe(false)
  })

  it('stores one trusted definition while keeping profile selection and removal isolated', async () => {
    const target = await fixture()
    await updateHomeConfigAtomic(config => ({
      ...config,
      apps: {
        ...config.apps,
        codex: {
          ...config.apps.codex!,
          profiles: {
            ...config.apps.codex!.profiles,
            work: { displayName: 'Work', dataMode: 'host-isolated' },
          },
        },
      },
    }), target.configPath)
    const sourceUrl = 'https://team.example/marketplace.json'
    await updatePluginManagementConfig(target, {
      kind: 'source-add',
      source: { url: sourceUrl, enabled: true, trusted: true, local: { name: 'Team' } },
    })
    const persisted = await loadHomeConfig(target.configPath)
    expect(persisted.marketplaceSources.find(source => source.url === sourceUrl)).toEqual({
      url: sourceUrl,
      enabled: true,
      trusted: true,
      local: { name: 'Team' },
    })
    expect(persisted.apps.codex?.profiles.default?.management?.sources).toContainEqual({
      url: sourceUrl,
      enabled: true,
    })
    expect(persisted.apps.codex?.profiles.work?.management?.sources.some(source => source.url === sourceUrl)).toBe(
      false,
    )
    expect((await loadPluginManagementConfig({ ...target, profileId: 'work' })).sources.some(
      source => source.url === sourceUrl,
    )).toBe(false)

    await updateHomeConfigAtomic(config => {
      const app = config.apps.codex!
      const work = app.profiles.work!
      return {
        ...config,
        apps: {
          ...config.apps,
          codex: {
            ...app,
            profiles: {
              ...app.profiles,
              work: {
                ...work,
                management: {
                  ...work.management!,
                  sources: [...work.management!.sources, { url: sourceUrl, enabled: false }],
                  hiddenCatalogEntries: [{ sourceUrl, pluginId: 'team-plugin' }],
                },
              },
            },
          },
        },
      }
    }, target.configPath)
    await updatePluginManagementConfig(target, { kind: 'source-remove', url: sourceUrl })
    const removed = await loadHomeConfig(target.configPath)
    expect(removed.marketplaceSources.some(source => source.url === sourceUrl)).toBe(false)
    for (const profile of Object.values(removed.apps.codex!.profiles)) {
      expect(profile.management?.sources.some(source => source.url === sourceUrl)).toBe(false)
      expect(profile.management?.hiddenCatalogEntries.some(entry => entry.sourceUrl === sourceUrl)).toBe(false)
    }
  })

  it('preserves the legacy enabled state when the official source was only an implicit default', async () => {
    const target = await fixture()
    const result = await migrateLegacyPluginManagementSources(target, {
      sources: [{
        url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE,
        enabled: false,
        local: { note: 'disabled in legacy storage' },
      }],
    })
    expect(result.management.sources[0]).toMatchObject({
      url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE,
      enabled: false,
      local: { note: 'disabled in legacy storage' },
    })
  })

  it('keeps an explicitly saved official source enabled state during legacy migration', async () => {
    const target = await fixture()
    await updatePluginManagementConfig(target, {
      kind: 'source-set-enabled',
      url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE,
      enabled: true,
    })
    const result = await migrateLegacyPluginManagementSources(target, {
      sources: [{ url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE, enabled: false }],
    })
    expect(result.management.sources[0]?.enabled).toBe(true)
  })

  it('rejects duplicate canonical URLs through the home parser', async () => {
    const target = await fixture()
    await expect(updateHomeConfigAtomic(config => {
      const app = config.apps.codex!
      const profile = app.profiles.default!
      return {
        ...config,
        apps: {
          ...config.apps,
          codex: {
            ...app,
            profiles: {
              ...app.profiles,
              default: {
                ...profile,
                management: {
                  revision: 1,
                  sources: [
                    { url: 'https://example.test/feed.json', enabled: true },
                    { url: 'https://example.test/feed.json', enabled: false },
                  ],
                  hiddenCatalogEntries: [],
                },
              },
            },
          },
        },
      }
    }, target.configPath)).rejects.toThrow('duplicate URL')
  })
})
