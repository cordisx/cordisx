import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { c as createTar, x as extractTar } from 'tar'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import { loadStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { restoreLegacyChannelStyle } from '../packages/cli/src/launcher/legacy-channel-styles.js'
import {
  loadServiceConfiguredArchive,
  loadServiceConfiguredChannelArchive,
} from '../packages/cli/src/cli/service-renderer-projection.js'
import { ServiceRendererIdentityProjection } from '../packages/cli/src/cli/service-renderer-identity.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const temporary: string[] = []
const legacyChannelArchive = process.env.CORDISX_LEGACY_CHANNEL_ARCHIVE_FIXTURE
const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v16.schema.json'
async function fixture(id = 'demo') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configured-plugin-manifest-'))
  temporary.push(root)
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(root, 'dist', 'index.js'), 'export const name = "demo"')
  await writeFile(path.join(root, 'dist', 'service.mjs'), 'export default {}')
  const runtime = {
    $schema: schema,
    schemaVersion: 16,
    id,
    capabilities: [],
    services: [{
      id: 'runtime',
      kind: 'channel-adapter',
      entry: './dist/service.mjs',
      configuration: { kind: 'none' },
    }],
  }
  const bytes = JSON.stringify(runtime)
  await writeFile(path.join(root, 'runtime-manifest.json'), bytes)
  const descriptor = {
    $schema: schema.replace('plugin-manifest', 'plugin-package'),
    schemaVersion: 16,
    id,
    version: '1.0.0',
    entry: './dist/index.js',
    dependencies: [],
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [schema] },
    runtimeManifest: {
      path: './runtime-manifest.json',
      schema,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    },
  }
  await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify(descriptor))
  const config = path.join(root, 'cordisx.config.json')
  await writeFile(config, JSON.stringify({ version: 1, plugins: [{ id, entry: './dist/index.js' }] }))
  return { root, runtime, config, descriptor }
}
afterEach(async () => {
  async function writable(root: string): Promise<void> {
    await chmod(root, 0o700)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(path.join(root, entry.name))
    }
  }
  for (const root of temporary) await writable(root)
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('direct configured package provenance', () => {
  it.skipIf(!legacyChannelArchive)('restores only the exact published legacy Channel stylesheet', async () => {
    if (!path.isAbsolute(legacyChannelArchive!)) throw new Error('legacy archive fixture must be absolute')
    const f = await fixture('channel')
    const archive = path.join(f.root, 'legacy.tgz')
    await copyFile(legacyChannelArchive!, archive)
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'channel', entry: './legacy.tgz' }] }))
    const plugin = (await loadConfig(f.config)).plugins[0]!
    const staged = await loadServiceConfiguredChannelArchive(f.root, plugin)
    const stylePath = './assets/channel-legacy-v017.css'
    expect(staged.browserArtifact?.manifest.initialStyles).toEqual([stylePath])
    const style = staged.browserArtifact?.files.get(stylePath)
    expect(style).toBeDefined()
    expect(createHash('sha256').update(style!).digest('hex')).toBe(
      '0227cf822adc38b51358bf641c38dfd78a8bf70d3f54d6d92215a4a483bf42a3',
    )
    expect(staged.artifactIntegrity).toBe(
      'sha256:0cc75afbf84d117835863b00a57e0412c621b8ec4e2c387327a6dd2e4f123856',
    )

    const unpacked = path.join(f.root, 'repacked')
    await mkdir(unpacked)
    await extractTar({ cwd: unpacked, file: archive })
    await writeFile(path.join(unpacked, 'package', 'fixture-marker.txt'), 'changed archive')
    await createTar({ cwd: unpacked, file: path.join(f.root, 'changed.tgz'), gzip: true }, ['package'])
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'channel', entry: './changed.tgz' }] }))
    const changed = (await loadConfig(f.config)).plugins[0]!
    const changedStaged = await loadServiceConfiguredArchive(f.root, changed)
    expect(changedStaged.browserArtifact?.manifest.initialStyles).toEqual([])
    await expect(loadServiceConfiguredChannelArchive(f.root, changed)).rejects.toThrow(
      'renderer-configured-channel-style-unavailable',
    )
    const alteredEntry = path.join(f.root, 'altered.js')
    await writeFile(alteredEntry, 'const channel_default = "changed"')
    await expect(restoreLegacyChannelStyle({
      packageManifest: {
        pluginId: 'channel',
        version: '0.1.7',
        canonicalSource: 'https://github.com/cordisx/plugin-channel',
      },
      artifactIntegrity: staged.artifactIntegrity,
      entry: alteredEntry,
      artifact: changedStaged.browserArtifact!,
    })).rejects.toThrow('legacy-channel-entry-integrity-failed')
  }, 60_000)

  it('rejects a configured Channel graph that cannot supply a standalone stylesheet', async () => {
    const f = await fixture('channel')
    const archive = path.join(f.root, 'channel.tgz')
    await createTar({ cwd: f.root, file: archive, gzip: true }, [
      'package.json',
      'cordisx-package.json',
      'runtime-manifest.json',
      'dist',
    ])
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'channel', entry: './channel.tgz' }] }))
    const plugin = (await loadConfig(f.config)).plugins[0]!
    expect((await loadServiceConfiguredArchive(f.root, plugin)).browserArtifact?.manifest.initialStyles).toEqual([])
    await expect(loadServiceConfiguredChannelArchive(f.root, plugin)).rejects.toThrow(
      'renderer-configured-channel-style-unavailable',
    )
  })

  it('carries verified archive identity through the production renderer composition', async () => {
    const f = await fixture()
    const source = 'https://github.com/cordisx/demo'
    await writeFile(
      path.join(f.root, 'cordisx-package.json'),
      JSON.stringify({ ...f.descriptor, canonicalSource: source }),
    )
    const archive = path.join(f.root, 'demo.tgz')
    await createTar({ cwd: f.root, file: archive, gzip: true }, [
      'package.json',
      'cordisx-package.json',
      'runtime-manifest.json',
      'dist',
    ])
    const integrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'demo', entry: './demo.tgz' }] }))
    const config = await loadConfig(f.config), plugin = config.plugins[0]!
    expect(plugin).toMatchObject({
      source,
      manifest: f.runtime,
      distributionArtifact: { version: '1.0.0', integrity },
    })
    expect(plugin.entry).toContain('/packages/sha256/')
    expect(plugin.configuredArchiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    const staged = await loadStagedPluginPackage(f.root, plugin.configuredArchiveDigest!)
    expect(staged).toMatchObject({ digest: plugin.configuredArchiveDigest, artifactIntegrity: integrity })
    expect((await loadServiceConfiguredArchive(f.root, plugin)).digest).toBe(staged.digest)
    for (
      const changed of [
        { ...plugin, source: 'https://example.test/other' },
        { ...plugin, entry: path.join(f.root, 'other.js') },
        { ...plugin, distributionArtifact: { version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` as const } },
      ]
    ) {
      await expect(loadServiceConfiguredArchive(f.root, changed)).rejects.toThrow(
        'renderer-configured-archive-unavailable',
      )
    }
    const firstLifetime = new AbortController()
    const secondLifetime = new AbortController()
    const firstContext = {
      profileId: 'default',
      rendererId: 'a'.repeat(64),
      ownerGeneration: 'generation',
      signal: firstLifetime.signal,
    }
    const secondContext = { ...firstContext, rendererId: 'b'.repeat(64), signal: secondLifetime.signal }
    const firstProjection = new ServiceRendererIdentityProjection({
      homeDir: f.root,
      context: firstContext,
      isCurrent: () => true,
    })
    const secondProjection = new ServiceRendererIdentityProjection({
      homeDir: f.root,
      context: secondContext,
      isCurrent: () => true,
    })
    try {
      const alias = await firstProjection.issue(firstContext, plugin)
      const other = await secondProjection.issue(secondContext, plugin)
      expect(alias).not.toBe(other)
      expect(alias).not.toContain(source)
      expect(firstProjection.resolve(firstContext, alias, 'demo')).toMatchObject({ source, digest: staged.digest })
      const policies = exactDomPermissionPolicies('default', [{
        id: 'demo',
        entry: plugin.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content', 'other.point'],
      }]).map(record => ({ ...record, key: { ...record.key, identity: { ...record.key.identity, source } } }))
      const projected = firstProjection.projectManagerPolicies(firstContext, alias, 'demo', policies)
      expect(projected).toHaveLength(2)
      expect(projected.every(record => record.key.identity.source === alias)).toBe(true)
      expect(JSON.stringify(projected)).not.toContain(source)
      const unrelated = policies.map(record => ({ ...record, key: { ...record.key, profileId: 'other' } }))
      expect(firstProjection.projectManagerPolicies(firstContext, alias, 'demo', unrelated)).toEqual([])
      const wrongSource = policies.map(record => ({
        ...record,
        key: { ...record.key, identity: { ...record.key.identity, source: 'https://example.test/other' } },
      }))
      expect(firstProjection.projectManagerPolicies(firstContext, alias, 'demo', wrongSource)).toEqual([])
      expect(() => firstProjection.projectManagerPolicies(firstContext, alias, 'demo', [policies[0]!, policies[0]!]))
        .toThrow('renderer-identity-unavailable')
      expect(() => secondProjection.resolve(secondContext, alias, 'demo')).toThrow('renderer-identity-unavailable')
      expect(() => firstProjection.resolve(secondContext, alias, 'demo')).toThrow('renderer-identity-unavailable')
      expect(() => firstProjection.resolve(firstContext, alias, 'other')).toThrow('renderer-identity-unavailable')
      firstLifetime.abort()
      expect(() => firstProjection.resolve(firstContext, alias, 'demo')).toThrow('renderer-identity-unavailable')
      expect(secondProjection.resolve(secondContext, other, 'demo').digest).toBe(staged.digest)
      let live = true
      const pendingProjection = new ServiceRendererIdentityProjection({
        homeDir: f.root,
        context: secondContext,
        isCurrent: () => live,
      })
      try {
        const pending = pendingProjection.issue(secondContext, plugin)
        live = false
        await expect(pending).rejects.toThrow('renderer-identity-unavailable')
      } finally {
        pendingProjection.close()
      }
    } finally {
      firstProjection.close()
      secondProjection.close()
    }
    expect(plugin.manifestFiles).toEqual([archive])
    const composition = await buildRendererCompositionSource(config, {}, { omitPluginModules: true })
    expect(composition.source).toContain(`source: ${JSON.stringify(source)}`)
    expect(plugin.package).toBeUndefined()
    expect(composition.source).toContain(`distributionArtifact: ${JSON.stringify(plugin.distributionArtifact)}`)
    expect(composition.source).not.toContain(plugin.configuredArchiveDigest)
    // Rebuilt archives must not inherit the previously certified distribution identity.
    await writeFile(path.join(f.root, 'dist', 'index.js'), 'export const name = "changed"')
    await createTar({ cwd: f.root, file: archive, gzip: true }, [
      'package.json',
      'cordisx-package.json',
      'runtime-manifest.json',
      'dist',
    ])
    const rebuilt = (await loadConfig(f.config)).plugins[0]!
    expect(rebuilt.distributionArtifact!.integrity).not.toEqual(integrity)
    expect(rebuilt.configuredArchiveDigest).not.toEqual(plugin.configuredArchiveDigest)
  })
  it('loads service metadata only from the digest-validated descriptor for the exact entry', async () => {
    const f = await fixture(), plugin = (await loadConfig(f.config)).plugins[0]!
    expect(plugin.manifest).toMatchObject(f.runtime)
    expect(plugin.manifestFiles).toEqual([
      path.join(f.root, 'cordisx-package.json'),
      path.join(f.root, 'runtime-manifest.json'),
    ])
  })
  it('rejects tampered runtime metadata instead of manufacturing an owner', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'runtime-manifest.json'), JSON.stringify({ ...f.runtime, name: 'tampered' }))
    await expect(loadConfig(f.config)).rejects.toThrow('digest mismatch')
  })
  it('does not give another renderer entry the service metadata of a neighboring built entry', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'dist', 'other.js'), 'export const name = "other"')
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'demo', entry: './dist/other.js' }] }))
    expect((await loadConfig(f.config)).plugins[0]!.manifest).toBeUndefined()
  })
  it('rejects package/plugin id mismatches', async () => {
    const f = await fixture()
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'different', entry: './dist/index.js' }] }))
    await expect(loadConfig(f.config)).rejects.toThrow()
  })
})
