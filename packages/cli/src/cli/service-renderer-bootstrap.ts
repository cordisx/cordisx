import path from 'node:path'
import { loadHomeConfig } from '../config/home-config.js'
import { buildRendererBundle } from '../launcher/bundle.js'
import { type CordisXConfig, type CordisXConfigPlugin, loadConfig } from '../launcher/config.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 } from '../launcher/latest-runtime-manifest.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { type ManagerRendererGraph, parseManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import { encodeManagerRendererBundle, MANAGER_BUNDLE_RPC_LIMIT } from './manager-renderer-bundle-codec.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { loadServiceRendererInitialPackage, serviceRendererPrivateGraph } from './service-renderer-projection.js'

type Snapshot = ReturnType<ServiceRendererLifecycle['snapshot']>
type Entry = {
  readonly peer: ManagerRendererCommandPeer
  readonly leases: PluginGenerationGraphLease[]
  readonly unsubscribe: () => void
  snapshot?: Snapshot
  config?: CordisXConfig
  plugins?: readonly CordisXConfigPlugin[]
  policies?: readonly CordisXPersistedPermissionPolicyRecord[]
  managedOwners?: ReadonlyMap<string, string>
  managedContext?: ManagerRendererChannelContext
  preparing?: Promise<unknown>
  completing?: Promise<unknown>
}
const MAX_INITIAL_GRAPHS = 256
function emptyConfig(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/**
 * Owner-only, two-phase bootstrap. Phase one creates and retains immutable
 * leases; phase two accepts only the authenticated sidecar's same-origin
 * mappings and builds from the same owner snapshot. No credentials or source
 * addresses are ever intended for the browser.
 */
export class ServiceRendererBootstrap {
  private readonly entries = new Map<string, Entry>()
  private readonly unsubscribeFinalization: () => void
  private closed = false

  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly appId: string
      readonly profileId: string
      readonly generation: string
      readonly lifecycle: ServiceRendererLifecycle
      readonly participants: ServiceRendererParticipants
      readonly store: PluginActivationStore
      readonly managedServiceUI?: ReturnType<typeof createManagerManagedServiceUIBridge>
    },
  ) {
    this.unsubscribeFinalization = input.lifecycle.onActivationFinalized(active => {
      for (const entry of this.entries.values()) {
        for (let index = entry.leases.length - 1; index >= 0; index--) {
          const lease = entry.leases[index]!
          const plugin = active.plugins.find(item => item.id === lease.pluginId)
          if (plugin?.enabled !== true || plugin.moduleGeneration !== lease.moduleGeneration) {
            lease.retire()
            entry.leases.splice(index, 1)
          }
        }
      }
    })
  }

  private current(rendererId: string, entry: Entry): boolean {
    return !this.closed && this.entries.get(rendererId) === entry && !entry.peer.closed
      && this.input.participants.peer(rendererId) === entry.peer
  }

  private async policies(): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
    return (await loadHomeConfig(this.input.configPath)).permissions.filter(
      policy => policy.key.profileId === this.input.profileId,
    )
  }

  private async unchanged(rendererId: string, entry: Entry): Promise<boolean> {
    try {
      if (!this.current(rendererId, entry) || !entry.snapshot || !entry.config || !entry.plugins || !entry.policies) {
        return false
      }
      if (entry.managedContext) this.input.managedServiceUI?.projectInitial(entry.managedContext)
      if (!attachmentEqual(this.input.lifecycle.snapshot(), entry.snapshot)) return false
      const [config, plugins, policies] = await Promise.all([
        loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
        loadPluginComposition(this.input.store, entry.snapshot.active),
        this.policies(),
      ])
      if (entry.managedContext) this.input.managedServiceUI?.projectInitial(entry.managedContext)
      return this.current(rendererId, entry) && attachmentEqual(this.input.lifecycle.snapshot(), entry.snapshot)
        && attachmentEqual(config, entry.config) && attachmentEqual(plugins, entry.plugins)
        && attachmentEqual(policies, entry.policies)
    } catch {
      return false
    }
  }

  private retire(rendererId: string, entry: Entry): void {
    // A session can disconnect while an asynchronous lease is being created.
    // Drain this entry even if it has already been removed from the map.
    if (this.entries.get(rendererId) === entry) this.entries.delete(rendererId)
    entry.unsubscribe()
    if (entry.managedContext) this.input.managedServiceUI?.retire(entry.managedContext)
    for (const lease of entry.leases) lease.retire()
    entry.leases.length = 0
  }

  async prepare(rendererId: string): Promise<unknown> {
    if (this.closed) throw new Error('renderer-bootstrap-unavailable')
    const existing = this.entries.get(rendererId)
    if (existing?.preparing) {
      const result = await existing.preparing
      if (!await this.unchanged(rendererId, existing)) throw new Error('renderer-bootstrap-stale')
      return result
    }
    if (existing) throw new Error('renderer-bootstrap-unavailable')
    const peer = this.input.participants.peer(rendererId)
    if (!peer) throw new Error('renderer-bootstrap-unavailable')
    const leases: PluginGenerationGraphLease[] = []
    let entry!: Entry
    const unsubscribe = peer.onDisconnect(() => {
      if (entry !== undefined) this.retire(rendererId, entry)
    })
    entry = { peer, leases, unsubscribe }
    this.entries.set(rendererId, entry)
    if (peer.closed) {
      this.retire(rendererId, entry)
      throw new Error('renderer-bootstrap-unavailable')
    }
    entry.preparing = (async () => {
      try {
        const snapshot = this.input.lifecycle.snapshot()
        const [config, plugins, policies] = await Promise.all([
          loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
          loadPluginComposition(this.input.store, snapshot.active),
          this.policies(),
        ])
        // Configured plugins and persistent plugin config need scoped
        // capability/config projection before they can be admitted.
        if (config.plugins.length !== 0 || plugins.some(plugin => !emptyConfig(plugin.config))) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        // Disabled packages are also serialized as Manager metadata.
        const packages = new Map<string, Awaited<ReturnType<typeof loadServiceRendererInitialPackage>>>()
        const managedOwners = new Map<string, string>()
        for (const item of snapshot.active.plugins) {
          const staged = await loadServiceRendererInitialPackage(this.input.homeDir, item)
          packages.set(item.id, staged)
          if (staged.manifest.runtimeManifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14) {
            if (!this.input.managedServiceUI) throw new Error('renderer-bootstrap-plugin-unsupported')
            if (item.enabled) managedOwners.set(item.id, item.moduleGeneration)
          }
        }
        const active = snapshot.active.plugins.filter(plugin => plugin.enabled)
        if (active.length > MAX_INITIAL_GRAPHS) throw new Error('renderer-bootstrap-limit')
        if (active.length > 0) {
          const server = await this.input.lifecycle.artifactServer()
          for (const item of active) {
            const staged = packages.get(item.id)!
            if (!staged.browserArtifact) throw new Error('renderer-bootstrap-plugin-unsupported')
            const lease = await server.lease(
              {
                packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
                artifactDirectory: stagedPluginBrowserArtifactDirectory(this.input.homeDir, item.digest),
                runtimeEntry: staged.browserArtifact.manifest.entry,
              },
              item.moduleGeneration,
              staged.browserArtifact.manifest,
            )
            leases.push(lease)
            if (!this.current(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
          }
        }
        entry.snapshot = snapshot
        entry.config = config
        entry.plugins = plugins
        entry.policies = policies
        entry.managedOwners = managedOwners
        if (!await this.unchanged(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
        return {
          status: 'ok',
          snapshot,
          // Never send this object to the browser; the sidecar rewrites it.
          privateGraphs: leases.map(serviceRendererPrivateGraph),
        }
      } catch (error) {
        this.retire(rendererId, entry)
        throw error
      }
    })()
    return await entry.preparing
  }

  async complete(
    context: ManagerRendererChannelContext,
    managerOrigin: string,
    rawGraphs: unknown,
  ): Promise<unknown> {
    const rendererId = context.rendererId
    const entry = this.entries.get(rendererId)
    if (!entry || !entry.preparing) throw new Error('renderer-bootstrap-unavailable')
    await entry.preparing
    if (entry.completing) {
      const result = await entry.completing
      if (!await this.unchanged(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
      return result
    }
    entry.completing = (async () => {
      try {
        if (
          !await this.unchanged(rendererId, entry) || !entry.snapshot || !entry.config || !entry.plugins
          || !entry.policies || !entry.managedOwners
        ) {
          throw new Error('renderer-bootstrap-stale')
        }
        if (!Array.isArray(rawGraphs) || rawGraphs.length !== entry.leases.length) {
          throw new Error('renderer-bootstrap-graphs-invalid')
        }
        const graphs = rawGraphs.map(value => parseManagerRendererGraph(value, managerOrigin))
        const byLease = new Map(graphs.map(graph => [graph.leaseId, graph]))
        const byPlugin = new Map<string, ManagerRendererGraph>(graphs.map(graph => [graph.pluginId, graph]))
        const bases = new Set(graphs.map(graph => graph.baseUrl))
        if (byLease.size !== graphs.length || byPlugin.size !== graphs.length || bases.size !== graphs.length) {
          throw new Error('renderer-bootstrap-graphs-invalid')
        }
        for (const lease of entry.leases) {
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
        const config: CordisXConfig = {
          ...entry.config,
          plugins: entry.plugins.map(plugin => {
            if (!plugin.enabled) return plugin
            const graph = byPlugin.get(plugin.id)
            if (!graph) throw new Error('renderer-bootstrap-graphs-invalid')
            return { ...plugin, runtimeGraph: createStandaloneRuntimeGraph(graph, managerOrigin) }
          }),
        }
        const snapshot = entry.snapshot
        const managedServiceUICapabilities = entry.managedOwners.size === 0
          ? undefined
          : this.input.managedServiceUI?.projectInitial(context)
        if (entry.managedOwners.size > 0 && managedServiceUICapabilities === undefined) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        if (managedServiceUICapabilities !== undefined) entry.managedContext = context
        if (
          managedServiceUICapabilities?.some(capability =>
            entry.managedOwners!.get(capability.pluginId) !== capability.pluginGeneration
          )
        ) throw new Error('renderer-bootstrap-plugin-unsupported')
        const bundle = await buildRendererBundle(config, {
          managerPresentationMode: 'standalone',
          standaloneOwner: {
            rendererId,
            profileId: this.input.profileId,
            generation: this.input.generation,
            managerOrigin,
            isCurrent: async () => await this.unchanged(rendererId, entry),
          },
          profileId: this.input.profileId,
          appId: this.input.appId,
          generation: this.input.generation,
          permission: { profileId: this.input.profileId, policies: entry.policies },
          pluginActivation: snapshot.active,
          initialRegistryEpoch: snapshot.registryEpoch,
          pluginManagement: { profileId: this.input.profileId, token: 'renderer-binding-placeholder' },
          ...(managedServiceUICapabilities === undefined ? {} : { managedServiceUICapabilities }),
        })
        if (entry.managedContext) this.input.managedServiceUI?.assertBundleSafe(context, bundle)
        if (entry.leases.some(lease => bundle.includes(lease.baseUrl)) || !await this.unchanged(rendererId, entry)) {
          throw new Error('renderer-bootstrap-unavailable')
        }
        const bytes = Buffer.from(bundle)
        let encoded: Awaited<ReturnType<typeof encodeManagerRendererBundle>>
        try {
          encoded = await encodeManagerRendererBundle(bytes)
        } finally {
          bytes.fill(0)
        }
        if (entry.managedContext) this.input.managedServiceUI?.assertBundleSafe(context, bundle)
        // Include the largest allowed request ID, the session envelope and the
        // terminating newline. The actual management RPC caps the whole frame.
        const result = { status: 'ok', bundle: encoded, initialGraphs: graphs }
        const response = { requestId: 'x'.repeat(128), ok: true, value: { status: 'ok', value: result } }
        if (
          Buffer.byteLength(`${JSON.stringify(response)}\n`) > MANAGER_BUNDLE_RPC_LIMIT
          || !await this.unchanged(rendererId, entry)
        ) throw new Error('renderer-bootstrap-unavailable')
        this.input.participants.confirmBootstrap(rendererId, snapshot)
        return result
      } catch (error) {
        this.retire(rendererId, entry)
        throw error
      }
    })()
    return await entry.completing
  }

  /** Not exposed as a generic browser binding. The sidecar supplies graph mappings. */
  channel(): ManagerRendererChannel {
    return {
      prepare: (payload, context) => {
        if (
          payload === null || typeof payload !== 'object' || Array.isArray(payload)
          || context.profileId !== this.input.profileId || context.ownerGeneration !== this.input.generation
        ) throw new Error('renderer-bootstrap-unavailable')
        const item = payload as Record<string, unknown>
        if (item.action === 'prepare' && Object.keys(item).length === 1) {
          return { mode: 'read', dispatch: async () => await this.prepare(context.rendererId) }
        }
        if (item.action === 'status' && Object.keys(item).length === 1) {
          return {
            mode: 'read',
            dispatch: async () => {
              const peer = this.input.participants.peer(context.rendererId)
              if (!peer) throw new Error('renderer-bootstrap-unavailable')
              const entry = this.entries.get(context.rendererId)
              if (entry?.managedContext) {
                try {
                  this.input.managedServiceUI?.projectInitial(context)
                } catch {
                  return { status: 'ok', current: false }
                }
              }
              return { status: 'ok', current: true }
            },
          }
        }
        if (
          item.action === 'complete' && Object.keys(item).length === 3
          && typeof item.managerOrigin === 'string' && Array.isArray(item.graphs)
          && Object.keys(item).every(key => ['action', 'managerOrigin', 'graphs'].includes(key))
        ) {
          return {
            mode: 'read',
            dispatch: async () => await this.complete(context, item.managerOrigin as string, item.graphs),
          }
        }
        throw new Error('renderer-bootstrap-unavailable')
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeFinalization()
    for (const [rendererId, entry] of this.entries) this.retire(rendererId, entry)
  }
}
