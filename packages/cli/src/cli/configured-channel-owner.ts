import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type HomeConfigPlugin, loadHomeConfig } from '../config/home-config.js'
import { guardedHomeServiceConfigPersistence } from '../config/service-config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { bundledChannelArchive } from '../launcher/bundled-plugin.js'
import { loadStagedPluginPackage, stagedPluginModulePath } from '../launcher/plugin-package.js'

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))
  } catch {
    return false
  }
}

/** A configured archive and its live service must still be the owner's exact startup selection. */
export function createConfiguredChannelOwner(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly profileId: string
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly ownerCurrent: () => boolean
}): {
  readonly persistence: ReturnType<typeof guardedHomeServiceConfigPersistence>
  withOwner<T>(action: () => Promise<T>): Promise<T | undefined>
} | undefined {
  const { plugin } = input
  const digest = plugin.configuredArchiveDigest
  const distribution = plugin.distributionArtifact
  const archive = plugin.manifestFiles?.[0]
  const bundled = plugin.configuredBundledChannel === true
  const serviceOwner = input.service.managementOwner()
  if (
    plugin.id !== 'channel' || !plugin.enabled || plugin.package !== undefined || plugin.development !== undefined
    || !digest || !distribution || !archive || plugin.manifestFiles?.length !== 1 || !path.isAbsolute(archive)
    || bundled && archive !== bundledChannelArchive()
    || plugin.entry !== stagedPluginModulePath(input.homeDir, digest) || !plugin.source || !plugin.manifest
    || plugin.configuredServiceEntry !== './services/runtime.mjs' || !serviceOwner
  ) return undefined
  const expected = {
    entry: archive,
    config: structuredClone(plugin.config),
    revision: plugin.revision ?? 0,
    source: plugin.source,
    manifest: structuredClone(plugin.manifest),
    digest,
    distribution: structuredClone(distribution),
  }
  let closed = false
  let tail: Promise<void> = Promise.resolve()
  const assertOwner = async (configured: HomeConfigPlugin) => {
    const scoped = configured.profiles?.[input.profileId]
    const current = scoped?.config ?? configured.config ?? {}
    const owner = input.service.managementOwner()
    if (
      closed || !input.ownerCurrent() || configured.id !== 'channel' || configured.enabled === false
      || (bundled
        ? configured.entry !== 'cordisx:channel'
        : path.resolve(path.dirname(input.configPath), configured.entry) !== expected.entry)
      || scoped?.candidate !== undefined || (scoped?.revision ?? 0) !== expected.revision
      || !sameJson(current, expected.config) || !input.service.generation()
      || !owner || owner !== serviceOwner || owner.source !== expected.source || owner.pluginId !== 'channel'
      || owner.serviceId !== 'runtime' || owner.serviceKind !== 'channel-adapter'
    ) throw new Error('configured-channel-owner-stale')
    const [bytes, staged] = await Promise.all([
      readFile(expected.entry),
      loadStagedPluginPackage(input.homeDir, expected.digest),
    ])
    const integrity = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    const manifest = staged.manifest.runtimeManifest
    if (
      closed || !input.ownerCurrent() || !input.service.generation() || integrity !== expected.distribution.integrity
      || staged.digest !== expected.digest || staged.artifactIntegrity !== expected.distribution.integrity
      || staged.identitySource !== expected.source || staged.manifest.id !== 'channel'
      || staged.manifest.version !== expected.distribution.version || !sameJson(manifest, expected.manifest)
      || manifest.schemaVersion !== 16 || manifest.services?.length !== 1
      || manifest.services[0]?.id !== 'runtime' || manifest.services[0]?.kind !== 'channel-adapter'
      || input.service.managementOwner() !== owner
    ) throw new Error('configured-channel-owner-stale')
  }
  const verify = async () => {
    const config = await loadHomeConfig(input.configPath)
    const configured = config.plugins.find(item => item.id === 'channel')
    if (!configured) throw new Error('configured-channel-owner-stale')
    await assertOwner(configured)
  }
  return {
    persistence: guardedHomeServiceConfigPersistence(assertOwner),
    async withOwner<T>(action: () => Promise<T>): Promise<T | undefined> {
      const work = tail.then(async () => {
        try {
          await verify()
        } catch {
          // No action was dispatched, so a later exact owner readback may recover.
          return undefined
        }
        try {
          const result = await action()
          await verify()
          return result
        } catch (error) {
          closed = true
          throw error
        }
      })
      tail = work.then(() => undefined, () => undefined)
      return await work
    },
  }
}
