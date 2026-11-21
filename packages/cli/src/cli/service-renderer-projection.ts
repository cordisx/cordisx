import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import { attachmentEqual, type RendererAttachmentIdentity } from '../launcher/renderer-lifecycle-peer.js'
import { loadStagedPluginPackage, stagedPluginModulePath } from '../launcher/plugin-package.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 } from '../launcher/latest-runtime-manifest.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXPluginActivationItemV1 } from '../plugin-lifecycle-contracts.js'

/** Private owner→sidecar only. URLs carry an upstream lease secret. */
export interface ServiceRendererPrivateGraph {
  readonly leaseId: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly baseUrl: string
  readonly entryUrl: string
  readonly initialStyleUrls: readonly string[]
}

export function serviceRendererPrivateGraph(lease: PluginGenerationGraphLease): ServiceRendererPrivateGraph {
  // Owner keeps the actual object and retire function. The sidecar must
  // replace every URL with its authenticated, session-scoped graph route.
  return {
    leaseId: lease.leaseId,
    pluginId: lease.pluginId,
    moduleGeneration: lease.moduleGeneration,
    baseUrl: lease.baseUrl,
    entryUrl: lease.entryUrl,
    initialStyleUrls: [...lease.initialStyleUrls],
  }
}

/** Verify the owner-selected archive and staged graph; this does not grant admission or capabilities. */
export async function loadServiceConfiguredArchive(homeDir: string, plugin: CordisXConfigPlugin) {
  const digest = plugin.configuredArchiveDigest
  const distribution = plugin.distributionArtifact
  if (
    !plugin.enabled || !digest || !distribution || plugin.package !== undefined || plugin.development !== undefined
    || plugin.entry !== stagedPluginModulePath(homeDir, digest) || !plugin.source || !plugin.manifest
  ) throw new Error('renderer-configured-archive-unavailable')
  const staged = await loadStagedPluginPackage(homeDir, digest)
  if (
    staged.digest !== digest || staged.artifactIntegrity !== distribution.integrity
    || staged.manifest.id !== plugin.id || staged.manifest.version !== distribution.version
    || staged.identitySource !== plugin.source || !attachmentEqual(staged.manifest.runtimeManifest, plugin.manifest)
    || staged.browserArtifact === undefined
  ) throw new Error('renderer-configured-archive-unavailable')
  return staged
}

/** Channel's current standalone UI needs a graph stylesheet under the Manager CSP. */
export async function loadServiceConfiguredChannelArchive(homeDir: string, plugin: CordisXConfigPlugin) {
  const staged = await loadServiceConfiguredArchive(homeDir, plugin)
  if (plugin.id !== 'channel' || !staged.browserArtifact?.manifest.initialStyles.length) {
    throw new Error('renderer-configured-channel-style-unavailable')
  }
  return staged
}

/** Reread the owner-selected immutable package and reject capabilities not yet projected. */
export async function loadServiceRendererPackage(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
): Promise<Awaited<ReturnType<typeof loadStagedPluginPackage>>> {
  return await loadAllowedRendererPackage(homeDir, item, false)
}

/** Initial read-only owner projection; dynamic lifecycle retains the stricter v1 gate. */
export async function loadServiceRendererInitialPackage(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
): Promise<Awaited<ReturnType<typeof loadStagedPluginPackage>>> {
  return await loadAllowedRendererPackage(homeDir, item, true)
}

async function loadAllowedRendererPackage(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
  allowReadOnlyManaged: boolean,
): Promise<Awaited<ReturnType<typeof loadStagedPluginPackage>>> {
  const staged = await loadStagedPluginPackage(homeDir, item.digest)
  const manifest = staged.manifest.runtimeManifest
  const legacy = manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 && manifest.schemaVersion === 1
    && staged.serviceModules.length === 0 && staged.managedServiceResources.length === 0
  const managed = allowReadOnlyManaged
    && manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 && manifest.schemaVersion === 14
    && manifest.services.length > 0
    && manifest.services.every(service => service.kind === 'managed-backend' && service.owner === 'host')
    && staged.serviceModules.length === manifest.services.length
    && manifest.services.every(service =>
      staged.serviceModules.filter(module => attachmentEqual(module.declaration, service)).length === 1
    )
  if (
    staged.manifest.id !== item.id || staged.manifest.version !== item.version
    || !attachmentEqual(staged.manifest.dependencies, item.dependencies)
    || (!legacy && !managed) || manifest.capabilities.length !== 0 || staged.entityTemplates.length !== 0
    || (staged.documents?.length ?? 0) !== 0 || staged.browserArtifact === undefined
  ) throw new Error('renderer-projection-plugin-unsupported')
  return staged
}

/**
 * First honest production slice: v1 packages without declared capabilities,
 * managed services or durable documents. Other plugins fail preflight until
 * their owner-issued per-renderer capabilities are implemented.
 */
export function createServiceRendererProjector(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  /** This lookup is populated only by an authenticated owner-side session. */
  readonly isLive: (identity: RendererAttachmentIdentity) => boolean
}): (mutation: PluginRuntimeMutation, identity: RendererAttachmentIdentity) => Promise<unknown> {
  return async (mutation, identity) => {
    if (!input.isLive(identity)) throw new Error('renderer-projection-session-unavailable')
    const before = mutation.previous
    const after = mutation.candidate
    const preflight = mutation.transactionEpoch === `${mutation.transactionId}:preflight`
    if (
      before.profileId !== input.profileId || after.profileId !== input.profileId
      || before.runtimeGeneration !== input.generation || after.runtimeGeneration !== input.generation
      || after.recordKind !== 'candidate' || after.transactionId !== mutation.transactionId
      || after.revision !== before.revision + 1 || after.lastGoodRevision !== before.revision
      || !Array.isArray(mutation.affectedPluginIds) || mutation.affectedPluginIds.length === 0
      || new Set(mutation.affectedPluginIds).size !== mutation.affectedPluginIds.length
      || !mutation.affectedPluginIds.includes(mutation.targetId)
      || (mutation.managedServiceUICapabilities?.length ?? 0) !== 0 || mutation.developmentPackage !== undefined
    ) throw new Error('renderer-projection-scope-invalid')
    const packages = new Map<string, Awaited<ReturnType<typeof loadStagedPluginPackage>>>()
    for (const pluginId of mutation.affectedPluginIds) {
      const item = after.plugins.find(plugin => plugin.id === pluginId)
      if (!item?.enabled) continue
      const staged = await loadServiceRendererPackage(input.homeDir, item)
      packages.set(pluginId, staged)
    }
    if (!input.isLive(identity)) throw new Error('renderer-projection-session-unavailable')
    const target = packages.get(mutation.targetId)
    if (
      mutation.package !== undefined && target !== undefined
      && (mutation.package.digest !== target.digest || !attachmentEqual(mutation.package.manifest, target.manifest))
    ) throw new Error('renderer-projection-package-stale')
    if (preflight) return undefined
    const leases = [...new Map([
      ...(mutation.runtimeArtifactLease === undefined ? [] : [mutation.runtimeArtifactLease]),
      ...(mutation.runtimeArtifactLeases ?? []),
    ].map(lease => [lease.leaseId, lease])).values()]
    if (
      leases.length !== packages.size || new Set(leases.map(lease => lease.pluginId)).size !== leases.length
      || leases.some(lease => {
        const item = after.plugins.find(plugin => plugin.id === lease.pluginId)
        return !packages.has(lease.pluginId) || !item?.enabled || item.moduleGeneration !== lease.moduleGeneration
      })
    ) throw new Error('renderer-projection-graphs-unavailable')
    const packageProjection = target === undefined ? {} : {
      package: {
        manifest: target.manifest,
        digest: target.digest,
        ...(target.artifactIntegrity === undefined ? {} : { artifactIntegrity: target.artifactIntegrity }),
        identitySource: target.identitySource,
      },
    }
    const result = {
      rendererId: identity.rendererId,
      transactionId: mutation.transactionId,
      transactionEpoch: mutation.transactionEpoch,
      expectedRegistryEpoch: mutation.expectedRegistryEpoch,
      afterRegistryEpoch: mutation.afterRegistryEpoch,
      operation: mutation.operation,
      previous: before,
      candidate: after,
      targetId: mutation.targetId,
      affectedPluginIds: [...mutation.affectedPluginIds],
      ...packageProjection,
      ...(mutation.authorizationDecision === undefined
        ? {}
        : { authorizationDecision: mutation.authorizationDecision }),
      privateGraphs: leases.map(serviceRendererPrivateGraph),
    }
    if (!input.isLive(identity)) throw new Error('renderer-projection-session-unavailable')
    return result
  }
}
