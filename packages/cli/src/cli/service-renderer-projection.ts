import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 } from '../channel-exact-request-permissions.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import { attachmentEqual, type RendererAttachmentIdentity } from '../launcher/renderer-lifecycle-peer.js'
import { loadStagedPluginPackage, stagedPluginModulePath } from '../launcher/plugin-package.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
} from '../launcher/latest-runtime-manifest.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXPluginActivationItemV1, CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { type ManagerRendererGraph, parseManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'
import { readSettledPackageInputs } from './service-renderer-profile-inputs.js'
import { isServiceRendererVisualManifest } from './service-renderer-visual-manifest.js'

// The standalone Manager has no Platform provider bridge. Optional Platform
// declarations may be present, but no corresponding owner policy is projected.
const unavailablePlatformCapabilities = new Set([
  'models.read',
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
])

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

/** Verify the authenticated sidecar's session-local aliases against the owner leases. */
export function validateServiceRendererGraphs(
  rawGraphs: unknown,
  managerOrigin: string,
  leases: readonly PluginGenerationGraphLease[],
): { graphs: ManagerRendererGraph[]; byPlugin: Map<string, ManagerRendererGraph> } {
  if (!Array.isArray(rawGraphs) || rawGraphs.length !== leases.length) {
    throw new Error('renderer-bootstrap-graphs-invalid')
  }
  const graphs = rawGraphs.map(value => parseManagerRendererGraph(value, managerOrigin))
  const byLease = new Map(graphs.map(graph => [graph.leaseId, graph]))
  const byPlugin = new Map<string, ManagerRendererGraph>(graphs.map(graph => [graph.pluginId, graph]))
  const bases = new Set(graphs.map(graph => graph.baseUrl))
  if (byLease.size !== graphs.length || byPlugin.size !== graphs.length || bases.size !== graphs.length) {
    throw new Error('renderer-bootstrap-graphs-invalid')
  }
  for (const lease of leases) {
    // The authenticated sidecar assigns a distinct session-local alias;
    // the private owner lease identifier must never reach the browser.
    const graph = byPlugin.get(lease.pluginId)
    if (
      !graph || graph.pluginId !== lease.pluginId || graph.moduleGeneration !== lease.moduleGeneration
      || graph.entryUrl.slice(graph.baseUrl.length) !== lease.entryUrl.slice(lease.baseUrl.length)
      || !attachmentEqual(
        graph.initialStyleUrls.map(url => url.slice(graph.baseUrl.length)),
        lease.initialStyleUrls.map(url => url.slice(lease.baseUrl.length)),
      )
    ) throw new Error('renderer-bootstrap-graphs-invalid')
  }
  return { graphs, byPlugin }
}

/** Retire only installed-package leases affected by a finalized activation. */
export function retireFinalizedServiceRendererGraphs(
  entries: Iterable<ServiceRendererBootstrapEntry>,
  active: CordisXPluginActivationRecordV1,
): void {
  for (const entry of entries) {
    for (let index = entry.leases.length - 1; index >= 0; index--) {
      const lease = entry.leases[index]!
      if (lease === entry.configuredChannel?.lease || entry.configuredPlugins?.some(plugin => plugin.lease === lease)) {
        continue
      }
      const plugin = active.plugins.find(item => item.id === lease.pluginId)
      if (plugin?.enabled !== true || plugin.moduleGeneration !== lease.moduleGeneration) {
        lease.retire()
        entry.leases.splice(index, 1)
      }
    }
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

/** Classify an exact owner package without granting its renderer capabilities. */
export async function inspectServiceRendererInitialPackage(homeDir: string, item: CordisXPluginActivationItemV1) {
  return await inspectRendererPackage(homeDir, item, true)
}

async function loadAllowedRendererPackage(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
  allowReadOnlyManaged: boolean,
): Promise<Awaited<ReturnType<typeof loadStagedPluginPackage>>> {
  const inspected = await inspectRendererPackage(homeDir, item, allowReadOnlyManaged)
  if (!inspected.supported) throw new Error('renderer-projection-plugin-unsupported')
  return inspected.staged
}

async function inspectRendererPackage(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
  allowReadOnlyManaged: boolean,
) {
  const staged = await loadStagedPluginPackage(homeDir, item.digest)
  const manifest = staged.manifest.runtimeManifest
  if (
    staged.manifest.id !== item.id || staged.manifest.version !== item.version
    || !attachmentEqual(staged.manifest.dependencies, item.dependencies)
    || staged.manifest.canonicalSource !== item.canonicalSource
  ) throw new Error('renderer-projection-plugin-unsupported')
  const legacy = manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 && manifest.schemaVersion === 1
    && staged.serviceModules.length === 0 && staged.managedServiceResources.length === 0
  // These plugins can register native visual seats, but the standalone
  // Manager does not provide those seats or a usage provider. Their optional
  // capabilities remain ungranted; Manager UI policies still use the owner
  // identity projection and the normal permission bridge.
  const visual = isServiceRendererVisualManifest(manifest, item.id) && staged.serviceModules.length === 0
    && staged.managedServiceResources.length === 0
  const managedVersion = manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 && manifest.schemaVersion === 14
    || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V15 && manifest.schemaVersion === 15
    || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 && manifest.schemaVersion === 16
  const managed = allowReadOnlyManaged && managedVersion
    && manifest.services.some(service => service.kind === 'managed-backend')
    && manifest.services.every(service =>
      (service.kind === 'managed-backend' || service.kind === 'platform-provider') && service.owner === 'host'
    )
    && staged.serviceModules.length === manifest.services.length
    && manifest.services.every(service =>
      staged.serviceModules.filter(module => attachmentEqual(module.declaration, service)).length === 1
    )
  const supported = (legacy || managed || visual)
    && !(legacy
      ? manifest.capabilities.length !== 0
      : managed && manifest.capabilities.some(capability =>
        capability.name !== 'ui.extension-points.render'
        && (capability.required !== false || !unavailablePlatformCapabilities.has(capability.name))
      ))
    && staged.entityTemplates.length === 0 && (staged.documents?.length ?? 0) === 0
    && staged.browserArtifact !== undefined
  const safeToOmit = (!('services' in manifest) || manifest.services.length === 0)
    && staged.serviceModules.length === 0 && staged.managedServiceResources.length === 0
    && staged.entityTemplates.length === 0 && (staged.documents?.length ?? 0) === 0
  return { staged, supported, safeToOmit }
}

/**
 * Project only packages whose Manager capabilities have an owner-backed
 * path. Other plugins fail preflight until that path is implemented.
 */
export function createServiceRendererProjector(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  /** This lookup is populated only by an authenticated owner-side session. */
  readonly isLive: (identity: RendererAttachmentIdentity) => boolean
  /** A read-only identity snapshot cannot participate in package mutations. */
  readonly canMutate: (identity: RendererAttachmentIdentity) => boolean
  /** Only a reserved owner handoff may project a session-specific identity. */
  readonly canProjectIdentity?: (identity: RendererAttachmentIdentity) => boolean
  readonly projectIdentity?: (
    mutation: PluginRuntimeMutation,
    identity: RendererAttachmentIdentity,
    stage?: Record<string, unknown>,
  ) => Promise<unknown>
}): (mutation: PluginRuntimeMutation, identity: RendererAttachmentIdentity) => Promise<unknown> {
  return async (mutation, identity) => {
    const identityProjection = !input.canMutate(identity)
    if (
      !input.isLive(identity) || identityProjection && (!input.canProjectIdentity?.(identity) || !input.projectIdentity)
    ) {
      throw new Error('renderer-projection-session-unavailable')
    }
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
    await readSettledPackageInputs({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.generation,
      pluginIds: mutation.affectedPluginIds.filter(id => after.plugins.some(plugin => plugin.id === id)),
      // A projected Desktop configuration is admitted only by the reserved
      // owner handoff below; it never enters the lifecycle payload.
      allowNonEmptyPluginConfig: identityProjection && input.canProjectIdentity?.(identity) === true,
    })
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
    if (preflight) {
      if (identityProjection) await input.projectIdentity!(mutation, identity)
      return undefined
    }
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
    return identityProjection ? await input.projectIdentity!(mutation, identity, result) : result
  }
}
