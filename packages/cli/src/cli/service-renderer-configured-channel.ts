import { randomBytes } from 'node:crypto'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type {
  PluginGenerationArtifactServer,
  PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import { isLegacyChannelRelease } from '../launcher/legacy-channel-styles.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { ManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager-projection.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { openReadonlyHeadlessChannel } from './readonly-headless-channel.js'
import { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import { loadServiceConfiguredChannelArchive } from './service-renderer-projection.js'

type View = NonNullable<Awaited<ReturnType<typeof openReadonlyHeadlessChannel>>>

/** Artwork can be large and is already scoped to each renderer's current view. */
export function compactChannelHandoff(projection: ChannelManagerProjectionV1): ChannelManagerProjectionV1 {
  return {
    ...projection,
    accounts: projection.accounts.map(account => {
      const { accountAvatar: _avatar, ...rest } = account
      void _avatar
      return rest
    }),
  }
}

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
    const legacy = isLegacyChannelRelease({
      packageManifest: {
        pluginId: staged.manifest.id,
        version: staged.manifest.version,
        ...(staged.manifest.canonicalSource === undefined ? {} : { canonicalSource: staged.manifest.canonicalSource }),
      },
      ...(staged.artifactIntegrity === undefined ? {} : { artifactIntegrity: staged.artifactIntegrity }),
    })
    // This published version does not negotiate the configuration-only facade.
    return new ServiceRendererConfiguredChannel(
      { ...input, allowConfiguration: input.allowConfiguration && !legacy },
      lease,
      owner,
      serviceGeneration,
    )
  }

  private configurationCapability() {
    return this.input.allowConfiguration
      ? this.owner.capabilities.find(capability =>
        capability.name === 'channel.accounts.connect' && Object.keys(capability.scope).length === 0
      )
      : undefined
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
      const connect = this.configurationCapability()
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

  private permissionIdentity(context: ManagerRendererChannelContext) {
    const alias = this.sourceAlias
    const identity = this.identity
    if (
      !this.bound || !identity || !alias || !this.isCurrent() || context.signal !== this.bound.signal
      || context.rendererId !== this.bound.rendererId || context.profileId !== this.bound.profileId
      || context.ownerGeneration !== this.bound.ownerGeneration
    ) throw new Error('renderer-configured-channel-unavailable')
    const original = identity.resolve(context, alias, 'channel')
    if (original.source !== this.input.plugin.source || original.digest !== this.input.plugin.configuredArchiveDigest) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    return { alias, identity }
  }

  isPermissionContextCurrent(context: ManagerRendererChannelContext): boolean {
    try {
      if (context.admitted !== true) return false
      this.permissionIdentity(context)
      return true
    } catch {
      return false
    }
  }

  /** Project the owner ledger to this Manager's exact Channel alias and graph. */
  projectPermissionPolicies(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
    if (!this.bound) throw new Error('renderer-configured-channel-unavailable')
    const context = { ...this.bound, admitted: true }
    const { alias, identity } = this.permissionIdentity(context)
    return {
      identity: { id: 'channel', source: alias },
      moduleGeneration: this.lease.moduleGeneration,
      policies: identity.projectManagerPolicies(context, alias, 'channel', records),
    }
  }

  /** The owner verified this exact artifact before projecting it to the Manager. */
  permissionArtifact(context: ManagerRendererChannelContext) {
    this.permissionIdentity(context)
    const artifact = this.input.plugin.distributionArtifact
    if (!artifact || context.admitted !== true) throw new Error('renderer-configured-channel-unavailable')
    return { ...artifact }
  }

  /** Reverse only the admitted Manager's policies to the verified owner identity. */
  resolvePermissionPolicies(context: ManagerRendererChannelContext, records: readonly unknown[]) {
    if (context.admitted !== true) throw new Error('renderer-configured-channel-unavailable')
    const { alias, identity } = this.permissionIdentity(context)
    return identity.resolveManagerPolicies(context, alias, 'channel', records)
  }

  /** Reverse only this renderer's owner-issued alias to the verified Channel source. */
  serviceIdentity(context: ManagerRendererChannelContext, requestedAlias?: string): {
    readonly alias: string
    readonly source: string
  } {
    const alias = this.sourceAlias
    if (
      !this.configurationCapability() || !this.bound || !this.identity || !alias || !this.isCurrent()
      || context.admitted !== true
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
    const writable = this.configurationCapability() !== undefined
    return writable ? { ...projection, service: { ...projection.service, writable: true } } : projection
  }

  /** Obtain a view after the owner has independently verified this session's admission. */
  handoffProjection() {
    if (!this.bound) throw new Error('renderer-configured-channel-unavailable')
    // Binding happens before admission, so its captured context is deliberately
    // not an admission proof. The fleet reservation supplies that proof.
    return compactChannelHandoff(this.projection({ ...this.bound, admitted: true }))
  }

  /** Verify an unchanged view or replace it only after the exact committed service generation is readable. */
  async handoff(
    reservation: Pick<Awaited<ReturnType<ReadonlyChannelRendererBridge['suspend']>>, 'isCurrent' | 'replace'>,
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
