import { rm } from 'node:fs/promises'
import path from 'node:path'
import { PluginPackageSourceSnapshotter } from './integrity.js'
import { JsonPackageManifestV2Resolver, type JsonPackageManifestV2ResolverOptions } from './manifest.js'
import { resolvePluginPackageSourceV1, type PluginPackageSourceV1 } from './source.js'
import { stageResolvedPluginPackage, type StagedPluginPackage } from '../plugin-package.js'

export interface StagePluginPackageSourceOptions extends JsonPackageManifestV2ResolverOptions {
  readonly homeDir: string
  readonly stagingRoot?: string
}

/**
 * Snapshot any formal explicit-local source before parsing or building it, then
 * project package-v2 into the single #73 StagedPluginPackage object store.
 */
export async function stagePluginPackageSourceV1(
  source: PluginPackageSourceV1,
  options: StagePluginPackageSourceOptions,
): Promise<StagedPluginPackage> {
  const stagingRoot = options.stagingRoot ?? path.join(options.homeDir, 'packages', '.source-staging')
  const snapshots = new PluginPackageSourceSnapshotter(stagingRoot)
  const snapshot = await snapshots.snapshot(resolvePluginPackageSourceV1(source))
  try {
    const resolver = new JsonPackageManifestV2Resolver(options)
    const resolved = await resolver.resolve(snapshot.payloadDirectory)
    return await stageResolvedPluginPackage(options.homeDir, snapshot.payloadDirectory, resolved)
  } finally {
    await rm(snapshot.stagingDirectory, { recursive: true, force: true })
  }
}
