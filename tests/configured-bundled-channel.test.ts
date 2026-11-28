import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { serviceRendererPermissionInputsCurrent } from '../packages/cli/src/cli/service-renderer-permission-inputs.js'
import { ServiceRendererIdentityProjection } from '../packages/cli/src/cli/service-renderer-identity.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { bundledChannelArchive } from '../packages/cli/src/launcher/bundled-plugin.js'
import { configuredBundledChannelArchive } from '../packages/cli/src/launcher/configured-bundled-channel.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE

async function removeFixture(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await removeFixture(path.join(directory, item.name))
  }
  await rm(directory, { recursive: true, force: true })
}

it.skipIf(!archive || !managerPackage)(
  'selects only the matching bundled Channel archive and rejects changed or invalid bytes',
  async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'cordisx-bundled-channel-'))
    const host = path.join(temporary, 'host')
    const root = path.join(host, 'dist/bundled-plugins/@cordisx/channel')
    const parent = path.dirname(root)
    const home = path.join(temporary, 'home')
    try {
      await mkdir(path.join(root, 'dist'), { recursive: true })
      await mkdir(home)
      const bundled = JSON.parse(
        await readFile(
          path.join(managerPackage!, 'dist/bundled-plugins/@cordisx/channel/package.json'),
          'utf8',
        ),
      ) as { name: string; version: string; cordisxSource: string }
      const source = bundled.cordisxSource
      const archivePath = path.join(parent, 'channel.archive')
      const metadataPath = path.join(parent, 'channel-archive.json')
      const metadata = async (bytes: Buffer, selectedSource = source) =>
        await writeFile(
          metadataPath,
          JSON.stringify({
            source: selectedSource,
            integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          }),
        )
      const original = await readFile(archive!)
      await Promise.all([
        writeFile(path.join(host, 'package.json'), JSON.stringify({ cordisxSources: { '@cordisx/channel': source } })),
        writeFile(path.join(root, 'package.json'), JSON.stringify(bundled)),
        copyFile(archive!, archivePath),
        metadata(original),
      ])
      const plugin = { id: 'channel', entry: path.join(root, 'dist/channel.js'), enabled: true, config: {} }
      const selected = await configuredBundledChannelArchive(plugin, home, root)
      expect(selected).toMatchObject({
        configuredBundledChannel: true,
        configuredServiceEntry: './services/runtime.mjs',
        source: 'https://github.com/cordisx/plugin-channel',
        distributionArtifact: { version: bundled.version },
        manifestFiles: [archivePath],
      })
      expect(selected?.configuredArchiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      await writeFile(archivePath, 'changed')
      expect(await configuredBundledChannelArchive(plugin, home, root)).toBeUndefined()
      await copyFile(archive!, archivePath)
      await metadata(original, 'github:other/channel#different')
      expect(await configuredBundledChannelArchive(plugin, home, root)).toBeUndefined()
      const invalid = Buffer.from('not a package')
      await writeFile(archivePath, invalid)
      await metadata(invalid)
      expect(await configuredBundledChannelArchive(plugin, home, root)).toBeUndefined()
    } finally {
      await removeFixture(temporary)
    }
  },
  60_000,
)

it.skipIf(!existsSync(bundledChannelArchive()))(
  'keeps alias authority distinct from the direct entry and its prior permissions',
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-bundled-authority-'))
    const configPath = path.join(home, 'config.json')
    const profileId = 'default'
    const options = { profileId, projectRoot: home }
    const lifetime = new AbortController()
    let projection: ServiceRendererIdentityProjection | undefined
    try {
      await writeFile(
        configPath,
        JSON.stringify({ version: 1, plugins: [{ id: 'channel', entry: 'cordisx:channel' }] }),
      )
      const ordinary = await loadConfig(configPath, options)
      const selected = await loadConfig(configPath, { ...options, serviceOwnerBundledChannel: true })
      const direct = ordinary.plugins[0]!
      const bundled = selected.plugins[0]!
      expect(direct.configuredArchiveDigest).toBeUndefined()
      expect(bundled.configuredBundledChannel).toBe(true)
      expect(bundled.source).toBe('https://github.com/cordisx/plugin-channel')
      const context = { profileId, rendererId: 'a'.repeat(64), ownerGeneration: 'owner', signal: lifetime.signal }
      projection = new ServiceRendererIdentityProjection({ homeDir: home, context, isCurrent: () => true })
      const alias = await projection.issue(context, bundled)
      const oldPolicies = exactDomPermissionPolicies(profileId, [{
        id: 'channel',
        entry: direct.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }])
      expect(projection.projectManagerPolicies(context, alias, 'channel', oldPolicies)).toEqual([])
      const newPolicies = oldPolicies.map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: bundled.source! } },
      }))
      expect(projection.projectManagerPolicies(context, alias, 'channel', newPolicies)).toHaveLength(2)
      const current = () =>
        serviceRendererPermissionInputsCurrent({
          entry: { config: selected } as never,
          profileId,
          pluginId: 'channel',
          signal: lifetime.signal,
          isCurrent: () => true,
        })
      expect(await current()).toBe(true)
      await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ id: 'channel', entry: direct.entry }] }))
      expect(await current()).toBe(false)
    } finally {
      projection?.close()
      lifetime.abort()
      await removeFixture(home)
    }
  },
  60_000,
)
