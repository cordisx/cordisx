import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
} from '../launcher/plugin-lifecycle-model.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import type { RendererConfigOperation, RendererConfigResult } from '../launcher/renderer-config-management.js'
import { CdpPluginLifecycleRuntime } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import { DesktopRendererLifecycle } from '../launcher/desktop-renderer-lifecycle.js'
import type {
  AttachedRendererPeer,
  RendererAttachmentIdentity,
  RendererAttachmentScope,
} from '../launcher/renderer-lifecycle-peer.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'

/** One existing Desktop owner and its existing package coordinator/fleet. */
export class DesktopOwnerRendererLifecycle implements PluginLifecycleRuntime, OwnerRendererLifecycle {
  private phase: 'uninitialized' | 'recovery' | 'ready' | 'closed' = 'uninitialized'
  private lifecycle: DesktopRendererLifecycle | undefined
  private failed = false
  private readonly listeners = new Set<(active: CordisXPluginActivationRecordV1) => void>()

  constructor(
    private readonly input: {
      readonly scope: RendererAttachmentScope
      readonly cdp: CdpPluginLifecycleRuntime
      readonly artifactServer: PluginGenerationArtifactServer
      readonly projectManagerMutation: (
        mutation: PluginRuntimeMutation,
        identity: RendererAttachmentIdentity,
      ) => unknown | Promise<unknown>
    },
  ) {}

  /** Called after durable recovery planning and before any Manager admission. */
  initialize(active: CordisXPluginActivationRecordV1, recoveryPending: boolean): void {
    if (this.phase !== 'uninitialized') throw new Error('Desktop owner lifecycle already initialized')
    if (recoveryPending) {
      this.phase = 'recovery'
      return
    }
    this.install(active, this.input.cdp.currentRegistryEpoch())
  }

  private install(active: CordisXPluginActivationRecordV1, registryEpoch: number): void {
    const lifecycle = new DesktopRendererLifecycle({
      scope: this.input.scope,
      cdp: this.input.cdp,
      active,
      registryEpoch,
      projectManagerMutation: this.input.projectManagerMutation,
    })
    lifecycle.onActivationFinalized(value => {
      for (const listener of this.listeners) listener(value)
    })
    this.lifecycle = lifecycle
    this.phase = 'ready'
  }

  private ready(): DesktopRendererLifecycle {
    if (this.phase !== 'ready' || !this.lifecycle || this.failed) {
      throw new Error('Desktop owner lifecycle is unavailable')
    }
    return this.lifecycle
  }

  snapshot() {
    return this.ready().snapshot()
  }
  async attach(peer: AttachedRendererPeer): Promise<void> {
    try {
      this.snapshot()
      await this.ready().attach(peer)
    } catch (error) {
      peer.close()
      throw error
    }
  }
  async artifactServer(): Promise<PluginGenerationArtifactServer> {
    this.ready()
    return this.input.artifactServer
  }
  onActivationFinalized(listener: (active: CordisXPluginActivationRecordV1) => void): () => void {
    if (this.phase === 'closed' || this.failed) throw new Error('Desktop owner lifecycle is unavailable')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async preflight(input: PluginRuntimePreflight): Promise<void> {
    await this.ready().preflight(input)
  }
  prepare(id: string) {
    return this.ready().prepare(id)
  }
  async prepareBrowserGraph(id: string, active: CordisXPluginActivationRecordV1) {
    return await this.ready().prepareBrowserGraph(id, active)
  }
  async stage(mutation: PluginRuntimeMutation) {
    return await this.ready().stage(mutation)
  }
  async publish(id: string) {
    return await this.ready().publish(id)
  }
  async complete(id: string) {
    return await this.ready().complete(id)
  }
  async finalize(id: string): Promise<void> {
    await this.ready().finalize(id)
  }
  async rollback(id: string) {
    return await this.ready().rollback(id)
  }
  async abort(id: string): Promise<void> {
    await this.ready().abort(id)
  }
  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    await this.ready().reload(input)
  }
  async pluginConfiguration(operation: RendererConfigOperation): Promise<RendererConfigResult> {
    if (this.phase !== 'ready' || !this.lifecycle || this.failed) {
      return { status: 'unavailable', reason: 'renderer-unavailable' }
    }
    return await this.lifecycle.pluginConfiguration(operation)
  }
  async managerConfigProof(pluginId: string) {
    if (this.phase !== 'ready' || !this.lifecycle || this.failed) return undefined
    return await this.lifecycle.managerConfigProof(pluginId)
  }
  async commit(): Promise<void> {
    throw new Error('Desktop lifecycle requires the package authority')
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (this.phase !== 'recovery' || this.failed) throw new Error('Desktop owner recovery is unavailable')
    return await this.input.cdp.recoverRollback(plan)
  }
  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, epoch: number): Promise<void> {
    if (this.phase === 'recovery' && !this.failed) {
      await this.input.cdp.adoptRecoveredActivation(active, epoch)
      this.install(active, epoch)
      return
    }
    await this.ready().adoptRecoveredActivation(active, epoch)
  }
  terminal(error: unknown): void {
    this.failed = true
    this.lifecycle?.terminal(error)
    if (!this.lifecycle) this.input.cdp.terminal(error)
  }
  close(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.lifecycle?.close()
    this.listeners.clear()
  }
}
