import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type {
  PluginGenerationArtifactServer,
  PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { ManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import { loadServiceConfiguredArchive } from './service-renderer-projection.js'

/** Verify the service-free graph without projecting its configuration or granting admission. */
export async function inspectServiceRendererConfiguredPlugin(homeDir: string, plugin: CordisXConfigPlugin) {
  if (
    !plugin.configuredArchiveDigest || !plugin.manifest || !plugin.distributionArtifact
    || plugin.package !== undefined || plugin.development !== undefined
  ) return undefined
  const staged = await loadServiceConfiguredArchive(homeDir, plugin)
  const manifest = staged.manifest.runtimeManifest
  const startup = 'startup' in manifest ? manifest.startup : undefined
  const artifact = staged.browserArtifact
  if (
    !artifact || !('services' in manifest) || manifest.services.length !== 0 || manifest.capabilities.length !== 0
    || staged.serviceModules.length !== 0 || staged.managedServiceResources.length !== 0
    || staged.entityTemplates.length !== 0 || (staged.documents?.length ?? 0) !== 0
    || startup !== undefined && (startup.pages.length !== 0 || startup.capabilities.length !== 0)
  ) return undefined
  return { staged, artifact }
}

/** An owner-selected, service-free configured archive with no private configuration. */
export class ServiceRendererConfiguredPlugin {
  private identity?: ServiceRendererIdentityProjection
  private bound: ManagerRendererChannelContext | undefined
  private sourceAlias: string | undefined
  private closed = false

  private constructor(
    private readonly input: {
      readonly homeDir: string
      readonly plugin: CordisXConfigPlugin
      readonly current: () => boolean
    },
    readonly lease: PluginGenerationGraphLease,
  ) {}

  static async prepare(input: {
    readonly homeDir: string
    readonly plugin: CordisXConfigPlugin
    readonly server: PluginGenerationArtifactServer
    readonly current: () => boolean
  }): Promise<ServiceRendererConfiguredPlugin | undefined> {
    const value = input.plugin.config
    if (!input.current()) throw new Error('renderer-configured-plugin-unavailable')
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0
    ) return undefined
    const inspected = await inspectServiceRendererConfiguredPlugin(input.homeDir, input.plugin)
    if (!inspected) return undefined
    const { staged, artifact } = inspected
    if (!input.current()) throw new Error('renderer-configured-plugin-unavailable')
    const lease = await input.server.lease(
      {
        packageIdentity: { pluginId: input.plugin.id, version: staged.manifest.version, integrity: staged.digest },
        artifactDirectory: stagedPluginBrowserArtifactDirectory(input.homeDir, staged.digest),
        runtimeEntry: artifact.manifest.entry,
      },
      'configured_' + randomBytes(32).toString('hex'),
      artifact.manifest,
    )
    if (!input.current()) {
      lease.retire()
      throw new Error('renderer-configured-plugin-unavailable')
    }
    return new ServiceRendererConfiguredPlugin(input, lease)
  }

  isCurrent(): boolean {
    return !this.closed && this.input.current()
  }

  get pluginId(): string {
    return this.input.plugin.id
  }

  /** Owner-only evidence for this session's exact configured archive and alias. */
  permissionBinding(context: ManagerRendererChannelContext) {
    const identity = this.identity
    const bound = this.bound
    const alias = this.sourceAlias
    const plugin = this.input.plugin
    if (
      !identity || !bound || !alias || !this.isCurrent() || context.admitted !== true || context.signal.aborted
      || context.signal !== bound.signal || context.rendererId !== bound.rendererId
      || context.profileId !== bound.profileId || context.ownerGeneration !== bound.ownerGeneration
      || !plugin.source || !plugin.configuredArchiveDigest || !plugin.distributionArtifact
      || this.lease.pluginId !== plugin.id
    ) throw new Error('renderer-configured-permission-unavailable')
    const original = identity.resolve(context, alias, plugin.id)
    if (original.source !== plugin.source || original.digest !== plugin.configuredArchiveDigest) {
      throw new Error('renderer-configured-permission-unavailable')
    }
    return {
      identity,
      alias,
      original,
      digest: plugin.configuredArchiveDigest,
      artifact: { ...plugin.distributionArtifact },
      lease: this.lease,
    }
  }

  /** Reuse the owner-bound context when coordinating another Manager page. */
  permissionContext(): ManagerRendererChannelContext {
    if (!this.bound) throw new Error('renderer-configured-permission-unavailable')
    const context = { ...this.bound, admitted: true }
    this.permissionBinding(context)
    return context
  }

  async project(
    context: ManagerRendererChannelContext,
    graph: ManagerRendererGraph,
    origin: string,
    policies: readonly CordisXPersistedPermissionPolicyRecord[],
  ) {
    if (
      !this.isCurrent() || this.identity || graph.pluginId !== this.input.plugin.id
      || graph.moduleGeneration !== this.lease.moduleGeneration
    ) throw new Error('renderer-configured-plugin-unavailable')
    const identity = new ServiceRendererIdentityProjection({
      homeDir: this.input.homeDir,
      context,
      isCurrent: () => this.isCurrent(),
    })
    this.identity = identity
    try {
      const source = await identity.issue(context, this.input.plugin)
      if (!this.isCurrent() || !this.input.plugin.manifest || !this.input.plugin.distributionArtifact) {
        throw new Error('renderer-configured-plugin-unavailable')
      }
      this.bound = Object.freeze({ ...context })
      this.sourceAlias = source
      return {
        plugin: {
          id: this.input.plugin.id,
          entry: this.input.plugin.entry,
          source,
          enabled: true,
          config: {},
          revision: this.input.plugin.revision ?? 0,
          manifest: this.input.plugin.manifest,
          distributionArtifact: { ...this.input.plugin.distributionArtifact },
          readme: '',
          readmes: {},
          documents: [],
          runtimeGraph: createStandaloneRuntimeGraph(graph, origin),
        } satisfies CordisXConfigPlugin,
        policies: identity.projectManagerPolicies(context, source, this.input.plugin.id, policies),
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.identity?.close()
    this.bound = undefined
    this.sourceAlias = undefined
  }
}

/** Disabled configured entries expose only their ID and actual disabled state. */
export function disabledConfiguredPlugin(plugin: CordisXConfigPlugin): CordisXConfigPlugin {
  return {
    id: plugin.id,
    entry: path.join('/', '__cordisx_disabled__', plugin.id),
    source: `https://renderer.cordisx.invalid/unavailable/${randomBytes(32).toString('hex')}`,
    enabled: false,
    config: {},
    readme: '',
    readmes: {},
    documents: [],
  }
}

/** Do not project private data or a browser graph for an unsupported enabled plugin. */
export function unavailableConfiguredPlugin(plugin: CordisXConfigPlugin): CordisXConfigPlugin {
  return { ...disabledConfiguredPlugin(plugin), standaloneUnavailable: true }
}

/** Configured source identities stay private even when a graph is unavailable. */
export function assertConfiguredSourcesHidden(
  bundle: string,
  plugins: readonly CordisXConfigPlugin[],
  ids: ReadonlySet<string>,
): void {
  if (plugins.some(plugin => ids.has(plugin.id) && plugin.source && bundle.includes(plugin.source))) {
    throw new Error('renderer-bootstrap-unavailable')
  }
}

export async function prepareConfiguredPlugins(input: {
  readonly homeDir: string
  readonly plugins: readonly CordisXConfigPlugin[]
  readonly server: PluginGenerationArtifactServer
  readonly configured: ServiceRendererConfiguredPlugin[]
  readonly leases: PluginGenerationGraphLease[]
  readonly current: () => boolean
}): Promise<CordisXConfigPlugin[]> {
  const unavailable: CordisXConfigPlugin[] = []
  for (const plugin of input.plugins) {
    const configured = await ServiceRendererConfiguredPlugin.prepare({ ...input, plugin })
    if (configured === undefined) unavailable.push(plugin)
    else {
      input.configured.push(configured)
      input.leases.push(configured.lease)
    }
    if (!input.current()) throw new Error('renderer-bootstrap-stale')
  }
  return unavailable
}

export async function projectConfiguredPlugins(input: {
  readonly plugins: readonly ServiceRendererConfiguredPlugin[]
  readonly graphs: ReadonlyMap<string, ManagerRendererGraph>
  readonly context: ManagerRendererChannelContext
  readonly origin: string
  readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
}) {
  return await Promise.all(input.plugins.map(async plugin => {
    const graph = input.graphs.get(plugin.lease.pluginId)
    if (!graph) throw new Error('renderer-bootstrap-graphs-invalid')
    return await plugin.project(input.context, graph, input.origin, input.policies)
  }))
}
