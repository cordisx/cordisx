import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CordisXConfigPlugin } from './config.js'
import { bundledPluginRoot } from './bundled-plugin.js'
import { configuredPluginArchive } from './configured-plugin-archive.js'
import { loadStagedPluginPackage } from './plugin-package.js'

/** Select one verified bundled package for both the service and Manager graph. */
export async function configuredBundledChannelArchive(
  plugin: CordisXConfigPlugin,
  homeDir: string,
  root = bundledPluginRoot('channel'),
): Promise<CordisXConfigPlugin | undefined> {
  try {
    if (!plugin.enabled || plugin.id !== 'channel' || plugin.entry !== path.join(root, 'dist/channel.js')) {
      return undefined
    }
    const parent = path.dirname(root)
    const archive = path.join(parent, 'channel.archive')
    const [hostBytes, packageBytes, metadataBytes, archiveBytes] = await Promise.all([
      readFile(path.join(root, '../../../..', 'package.json')),
      readFile(path.join(root, 'package.json')),
      readFile(path.join(parent, 'channel-archive.json')),
      readFile(archive),
    ])
    const host = JSON.parse(hostBytes.toString('utf8')) as { cordisxSources?: Record<string, unknown> }
    const bundled = JSON.parse(packageBytes.toString('utf8')) as {
      name?: unknown
      version?: unknown
      cordisxSource?: unknown
    }
    const metadata = JSON.parse(metadataBytes.toString('utf8')) as { source?: unknown; integrity?: unknown }
    const source = host.cordisxSources?.['@cordisx/channel']
    const integrity = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`
    if (
      typeof source !== 'string' || bundled.name !== '@cordisx/channel' || bundled.cordisxSource !== source
      || metadata.source !== source || metadata.integrity !== integrity
    ) return undefined
    const selected = await configuredPluginArchive({ ...plugin, entry: archive }, homeDir)
    if (!selected.configuredArchiveDigest || selected.distributionArtifact?.integrity !== integrity) return undefined
    const staged = await loadStagedPluginPackage(homeDir, selected.configuredArchiveDigest)
    const manifest = staged.manifest.runtimeManifest
    if (
      staged.manifest.version !== bundled.version || manifest.schemaVersion !== 16
      || !('services' in manifest) || manifest.services.length !== 1
      || manifest.services[0]?.id !== 'runtime' || manifest.services[0]?.kind !== 'channel-adapter'
      || staged.serviceModules.length !== 1 || staged.serviceModules[0]?.declaration.id !== 'runtime'
      || !staged.browserArtifact?.manifest.initialStyles.length
    ) return undefined
    return { ...selected, configuredBundledChannel: true }
  } catch {
    // A missing or invalid Manager archive must not stop the existing service.
    return undefined
  }
}
