import path from 'node:path'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 } from '../channel-exact-request-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
} from '../launcher/latest-runtime-manifest.js'
import type {
  PluginGenerationArtifactServer,
  PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import type { CordisXPluginActivationItemV1 } from '../plugin-lifecycle-contracts.js'
import { inspectServiceRendererInitialPackage } from './service-renderer-projection.js'

/** Classify and lease only owner-verified installed graphs for one Manager session. */
export async function prepareServiceRendererInstalledGraphs(input: {
  readonly homeDir: string
  readonly plugins: readonly CordisXPluginActivationItemV1[]
  readonly unprojectedConfigIds: ReadonlySet<string>
  readonly managedServiceUIAvailable: boolean
  readonly leases: PluginGenerationGraphLease[]
  readonly server: () => Promise<PluginGenerationArtifactServer>
  readonly current: () => boolean
}): Promise<{
  readonly unavailable: ReadonlySet<string>
  readonly managedOwners: ReadonlyMap<string, string>
  readonly needsIdentityProjection: boolean
}> {
  const inspected = new Map<string, Awaited<ReturnType<typeof inspectServiceRendererInitialPackage>>>()
  const unavailable = new Set<string>()
  for (const item of input.plugins) {
    const value = await inspectServiceRendererInitialPackage(input.homeDir, item)
    if (!input.current()) throw new Error('renderer-bootstrap-stale')
    inspected.set(item.id, value)
    if (!value.supported || input.unprojectedConfigIds.has(item.id)) {
      if (!value.safeToOmit) throw new Error('renderer-bootstrap-plugin-unsupported')
      unavailable.add(item.id)
    }
  }

  // A dependent cannot run without its owner-selected dependency, even if its
  // own graph is otherwise supported. Never omit a service-bearing dependent.
  let changed = true
  while (changed) {
    changed = false
    for (const item of input.plugins) {
      if (unavailable.has(item.id) || !item.dependencies.some(dependency => unavailable.has(dependency.id))) continue
      if (!inspected.get(item.id)?.safeToOmit) throw new Error('renderer-bootstrap-plugin-unsupported')
      unavailable.add(item.id)
      changed = true
    }
  }

  const managedOwners = new Map<string, string>()
  let needsIdentityProjection = unavailable.size > 0
  for (const item of input.plugins) {
    if (unavailable.has(item.id)) continue
    const manifest = inspected.get(item.id)!.staged.manifest.runtimeManifest
    if (
      manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V15
      || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 || manifest.capabilities.length > 0
    ) {
      needsIdentityProjection = true
    }
    if (
      manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14
      || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V15
      || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V16
    ) {
      if (!input.managedServiceUIAvailable) throw new Error('renderer-bootstrap-plugin-unsupported')
      if (item.enabled) managedOwners.set(item.id, item.moduleGeneration)
    }
  }

  const active = input.plugins.filter(item => item.enabled && !unavailable.has(item.id))
  if (active.length > 0) {
    const server = await input.server()
    for (const item of active) {
      const staged = inspected.get(item.id)!.staged
      if (!staged.browserArtifact) throw new Error('renderer-bootstrap-plugin-unsupported')
      const lease = await server.lease(
        {
          packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
          artifactDirectory: stagedPluginBrowserArtifactDirectory(input.homeDir, item.digest),
          runtimeEntry: staged.browserArtifact.manifest.entry,
        },
        item.moduleGeneration,
        staged.browserArtifact.manifest,
      )
      input.leases.push(lease)
      if (!input.current()) throw new Error('renderer-bootstrap-stale')
    }
  }
  return { unavailable, managedOwners, needsIdentityProjection }
}

/** Keep the verified activation metadata without exposing code, config or capabilities. */
export function unavailableInstalledPlugin(plugin: CordisXConfigPlugin, alias: string): CordisXConfigPlugin {
  if (!plugin.package) throw new Error('renderer-bootstrap-plugin-unsupported')
  return {
    id: plugin.id,
    entry: path.join('/', '__cordisx_unavailable__', plugin.id),
    source: alias,
    enabled: plugin.enabled,
    config: {},
    ...(plugin.revision === undefined ? {} : { revision: plugin.revision }),
    package: {
      ...plugin.package,
      ...(plugin.package.canonicalSource === undefined ? {} : { canonicalSource: alias }),
    },
    readme: '',
    readmes: {},
    documents: [],
    standaloneUnavailable: true,
  }
}
