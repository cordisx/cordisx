import { randomBytes } from 'node:crypto'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type {
  PluginGenerationArtifactServer,
  PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { ManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { openReadonlyHeadlessChannel } from './readonly-headless-channel.js'
import { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import { loadServiceConfiguredChannelArchive } from './service-renderer-projection.js'

type View = NonNullable<Awaited<ReturnType<typeof openReadonlyHeadlessChannel>>>

/** Owner-selected Channel only; construction is never available to a browser. */
export class ServiceRendererConfiguredChannel {
  private identity?: ServiceRendererIdentityProjection
  private view?: View
  private bound?: ManagerRendererChannelContext
  private sourceAlias?: string
  private closed = false

  private constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly profileId: string
      readonly plugin: CordisXConfigPlugin
      readonly service: LocalChannelService
      readonly bridge: ReadonlyChannelRendererBridge
      readonly allowConfiguration: boolean
      readonly current: () => boolean
      readonly unchanged: () => Promise<boolean>
      readonly retire: () => void
    },
    readonly lease: PluginGenerationGraphLease,
    private readonly owner: NonNullable<ReturnType<LocalChannelService['managementOwner']>>,
    private serviceGeneration: string,
  ) {}

  static async prepare(input: {
    readonly homeDir: string
    readonly configPath: string
    readonly profileId: string
    readonly plugin: CordisXConfigPlugin
    readonly selectedPlugin: CordisXConfigPlugin
    readonly service: LocalChannelService
    readonly bridge: ReadonlyChannelRendererBridge
    readonly allowConfiguration: boolean
    readonly server: PluginGenerationArtifactServer
    readonly current: () => boolean
    readonly unchanged: () => Promise<boolean>
    readonly retire: () => void
  }): Promise<ServiceRendererConfiguredChannel> {
    const owner = input.service.managementOwner()
    const serviceGeneration = input.service.generation()
    if (
      !input.current() || input.plugin.id !== 'channel' || !attachmentEqual(input.plugin, input.selectedPlugin)
      || !input.plugin.source || !owner || owner.source !== input.plugin.source || owner.pluginId !== 'channel'
      || owner.serviceId !== 'runtime' || owner.serviceKind !== 'channel-adapter' || !serviceGeneration
    ) throw new Error('renderer-configured-channel-unavailable')
    const staged = await loadServiceConfiguredChannelArchive(input.homeDir, input.plugin)
    const artifact = staged.browserArtifact
    if (
      !artifact || !input.current() || input.service.managementOwner() !== owner
      || input.service.generation() !== serviceGeneration
    ) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    const lease = await input.server.lease(
      {
        packageIdentity: { pluginId: input.plugin.id, version: staged.manifest.version, integrity: staged.digest },
        artifactDirectory: stagedPluginBrowserArtifactDirectory(input.homeDir, staged.digest),
        runtimeEntry: artifact.manifest.entry,
      },
      'configured_' + randomBytes(32).toString('hex'),
      artifact.manifest,
    )
    if (
      !input.current() || input.service.managementOwner() !== owner
      || input.service.generation() !== serviceGeneration
    ) {
      lease.retire()
      throw new Error('renderer-configured-channel-unavailable')
    }
    return new ServiceRendererConfiguredChannel(input, lease, owner, serviceGeneration)
  }

  isCurrent(): boolean {
    try {
      return !this.closed && this.input.current() && this.input.service.managementOwner() === this.owner
        && this.input.service.generation() === this.serviceGeneration
    } catch {
      return false
    }
  }

  async project(
    context: ManagerRendererChannelContext,
    graph: ManagerRendererGraph,
    origin: string,
    policies: readonly CordisXPersistedPermissionPolicyRecord[],
  ) {
    if (
      this.closed || this.identity || graph.pluginId !== this.input.plugin.id
      || graph.moduleGeneration !== this.lease.moduleGeneration || !this.isCurrent()
    ) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    const identity = new ServiceRendererIdentityProjection({
      homeDir: this.input.homeDir,
      context,
      isCurrent: () => this.isCurrent(),
    })
    this.identity = identity
    try {
      const source = await identity.issue(context, this.input.plugin)
      const view = await openReadonlyHeadlessChannel({
        profileId: this.input.profileId,
        configPath: this.input.configPath,
        plugin: this.input.plugin,
        service: this.input.service,
        fence: {
          signal: context.signal,
          current: async () => this.isCurrent() && await this.input.unchanged() && this.isCurrent(),
          retire: this.input.retire,
        },
      })
      if (!view || !this.isCurrent() || !this.input.plugin.manifest || !this.input.plugin.distributionArtifact) {
        view?.close()
        throw new Error('renderer-configured-channel-unavailable')
      }
      this.view = view
      this.sourceAlias = source
      const connect = this.input.allowConfiguration
        ? this.owner.capabilities.find(capability =>
          capability.name === 'channel.accounts.connect' && Object.keys(capability.scope).length === 0
        )
        : undefined
      const configurationAvailable = connect !== undefined
      return {
        plugin: {
          id: this.input.plugin.id,
          entry: this.input.plugin.entry,
          source,
          enabled: true,
          config: {},
          revision: this.input.plugin.revision ?? 0,
          manifest: this.input.plugin.manifest,
          // The owner verified this exact archive against its staged browser graph.
          distributionArtifact: { ...this.input.plugin.distributionArtifact },
          readme: '',
          readmes: {},
          documents: [],
          runtimeGraph: createStandaloneRuntimeGraph(graph, origin),
        } satisfies CordisXConfigPlugin,
        policies: identity.projectManagerPolicies(context, source, this.input.plugin.id, policies),
        projection: configurationAvailable
          ? { ...view.initial.projection, service: { ...view.initial.projection.service, writable: true } }
          : view.initial.projection,
        serviceOwner: {
          ...view.initial.owner,
          source,
          capabilities: connect === undefined
            ? view.initial.owner.capabilities
            : [...view.initial.owner.capabilities, connect],
        },
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  bind(context: ManagerRendererChannelContext): void {
    if (!this.isCurrent() || !this.view || this.bound) throw new Error('renderer-configured-channel-unavailable')
    this.input.bridge.bind(context, this.view)
    this.bound = context
  }

  /** Reverse only this renderer's owner-issued alias to the verified Channel source. */
  serviceIdentity(context: ManagerRendererChannelContext, requestedAlias?: string): {
    readonly alias: string
    readonly source: string
  } {
    const alias = this.sourceAlias
    if (
      !this.bound || !this.identity || !alias || !this.isCurrent() || context.admitted !== true
      || context.signal !== this.bound.signal || requestedAlias !== undefined && requestedAlias !== alias
    ) throw new Error('renderer-configured-channel-unavailable')
    const identity = this.identity.resolve(context, alias, 'channel')
    if (identity.source !== this.input.plugin.source || identity.digest !== this.input.plugin.configuredArchiveDigest) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    return { alias, source: identity.source }
  }

  /** Return only the renderer-safe view after the owner has verified its exact session. */
  projection(context: ManagerRendererChannelContext) {
    this.serviceIdentity(context)
    if (!this.view) throw new Error('renderer-configured-channel-unavailable')
    const projection = this.view.initial.projection
    const writable = this.input.allowConfiguration
      && this.owner.capabilities.some(capability =>
        capability.name === 'channel.accounts.connect' && Object.keys(capability.scope).length === 0
      )
    return writable ? { ...projection, service: { ...projection.service, writable: true } } : projection
  }

  /** Verify an unchanged view or replace it only after the exact committed service generation is readable. */
  async handoff(
    reservation: Awaited<ReturnType<ReadonlyChannelRendererBridge['suspend']>>,
    expected?: { readonly generation: string; readonly revision: number },
  ): Promise<void> {
    const context = this.bound
    if (!context || !this.view || !reservation.isCurrent() || !this.input.current()) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    if (!expected) {
      const result = await this.view.snapshot()
      if (result.status !== 'applied' || !this.isCurrent() || !reservation.isCurrent()) {
        throw new Error('renderer-configured-channel-unavailable')
      }
      return
    }
    if (
      !Number.isSafeInteger(expected.revision) || expected.revision < 0
      || expected.generation === this.serviceGeneration || this.input.service.generation() !== expected.generation
      || this.input.service.managementOwner() !== this.owner
    ) throw new Error('renderer-configured-channel-unavailable')
    this.serviceGeneration = expected.generation
    const view = await openReadonlyHeadlessChannel({
      profileId: this.input.profileId,
      configPath: this.input.configPath,
      plugin: this.input.plugin,
      service: this.input.service,
      fence: {
        signal: context.signal,
        current: async () => this.isCurrent() && await this.input.unchanged() && this.isCurrent(),
        retire: this.input.retire,
      },
    })
    if (
      !view || !this.isCurrent() || !reservation.isCurrent() || view.initial.generation !== expected.generation
      || view.initial.projection.service.revision !== expected.revision
      || view.initial.projection.service.lastGoodRevision !== expected.revision
    ) {
      view?.close()
      throw new Error('renderer-configured-channel-unavailable')
    }
    if (!reservation.replace(view)) throw new Error('renderer-configured-channel-unavailable')
    this.view = view
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.bound) this.input.bridge.unbind(this.bound)
    else this.view?.close()
    this.identity?.close()
  }
}
