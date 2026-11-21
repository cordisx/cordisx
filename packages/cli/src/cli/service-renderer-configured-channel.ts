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
  private closed = false

  private constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly profileId: string
      readonly plugin: CordisXConfigPlugin
      readonly service: LocalChannelService
      readonly bridge: ReadonlyChannelRendererBridge
      readonly current: () => boolean
      readonly unchanged: () => Promise<boolean>
      readonly retire: () => void
    },
    readonly lease: PluginGenerationGraphLease,
    private readonly owner: NonNullable<ReturnType<LocalChannelService['managementOwner']>>,
    private readonly serviceGeneration: string,
  ) {}

  static async prepare(input: {
    readonly homeDir: string
    readonly configPath: string
    readonly profileId: string
    readonly plugin: CordisXConfigPlugin
    readonly selectedPlugin: CordisXConfigPlugin
    readonly service: LocalChannelService
    readonly bridge: ReadonlyChannelRendererBridge
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
      if (!view || !this.isCurrent() || !this.input.plugin.manifest) {
        view?.close()
        throw new Error('renderer-configured-channel-unavailable')
      }
      this.view = view
      return {
        plugin: {
          id: this.input.plugin.id,
          entry: this.input.plugin.entry,
          source,
          enabled: true,
          config: {},
          revision: this.input.plugin.revision ?? 0,
          manifest: this.input.plugin.manifest,
          readme: '',
          readmes: {},
          documents: [],
          runtimeGraph: createStandaloneRuntimeGraph(graph, origin),
        } satisfies CordisXConfigPlugin,
        policies: identity.projectManagerPolicies(context, source, this.input.plugin.id, policies),
        projection: view.initial.projection,
        serviceOwner: { ...view.initial.owner, source },
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

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.bound) this.input.bridge.unbind(this.bound)
    else this.view?.close()
    this.identity?.close()
  }
}
