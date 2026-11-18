import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CordisXConfigPlugin } from './config.js'
import { normalizeLatestRuntimeManifest } from './latest-runtime-manifest.js'
import { PluginPackageSourceSnapshotter } from './packages/integrity.js'
import { JsonPackageManifestV2Resolver } from './packages/manifest.js'
import { stageResolvedPluginPackage, stagedPluginModulePath } from './plugin-package.js'

/** A local archive binds the executed graph to its actual distribution bytes, never a self-claimed digest. */
export async function configuredPluginArchive(
  plugin: CordisXConfigPlugin,
  homeDir: string,
): Promise<CordisXConfigPlugin> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cordisx-configured-archive-'))
  try {
    const archive = path.join(temporary, 'source.tgz')
    await copyFile(plugin.entry, archive)
    const integrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}` as const
    const snapshot = await new PluginPackageSourceSnapshotter(temporary).snapshot({
      kind: 'local-package', path: archive, distributionIntegrity: integrity,
    })
    const runtimeValidators = Object.fromEntries([12, 13, 14, 15, 16].map(version => [
      `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v${version}.schema.json`,
      (value: unknown) => {
        const manifest = normalizeLatestRuntimeManifest(value, plugin.id)
        if (!manifest) throw new Error('Unsupported configured archive runtime manifest')
        return manifest
      },
    ]))
    const resolved = await new JsonPackageManifestV2Resolver({ runtimeValidators }).resolve(snapshot.payloadDirectory)
    if (resolved.packageManifest.pluginId !== plugin.id) throw new Error('Configured archive identity mismatch')
    const staged = await stageResolvedPluginPackage(homeDir, snapshot.payloadDirectory, resolved, {
      artifactIntegrity: integrity,
    })
    return {
      ...plugin,
      entry: stagedPluginModulePath(homeDir, staged.digest),
      source: staged.identitySource,
      manifest: staged.manifest.runtimeManifest,
      manifestFiles: [plugin.entry],
      package: {
        version: staged.manifest.version,
        digest: staged.digest,
        artifactIntegrity: integrity,
        moduleGeneration: `configured-${staged.digest.slice(7)}`,
        dependencies: staged.manifest.dependencies,
        ...(staged.manifest.canonicalSource === undefined ? {} : { canonicalSource: staged.manifest.canonicalSource }),
      },
      ...(staged.readme === undefined ? {} : { readme: staged.readme }),
      ...(staged.documents === undefined ? {} : { documents: staged.documents }),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
