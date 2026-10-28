import { RetryableCleanup } from '../providers/retryable-cleanup.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle-model.js'

interface ProviderTransaction {
  readonly generation: string
  rollback(): Promise<void>
  finalize(): Promise<void>
}

interface ProviderRollback {
  cleanup: RetryableCleanup
  renderer: () => Promise<RuntimeCleanupObservation>
  observation?: RuntimeCleanupObservation
}

/** Makes the Node provider Fleet a participant in the existing durable plugin transaction. */
export class PlatformProviderPluginLifecycleRuntime implements PluginLifecycleRuntime {
  private readonly mutations = new Map<string, PluginRuntimeMutation>()
  private readonly providers = new Map<string, ProviderTransaction>()
  private readonly finalizers = new Map<string, RetryableCleanup>()
  private readonly rollbacks = new Map<string, ProviderRollback>()
  private readonly directions = new Map<string, 'rollback' | 'finalize'>()
  private reconfigure: ((activation: CordisXPluginActivationRecordV1) => Promise<ProviderTransaction>) | undefined

  constructor(private readonly runtime: PluginLifecycleRuntime) {}

  connect(reconfigure: (activation: CordisXPluginActivationRecordV1) => Promise<ProviderTransaction>): void {
    this.reconfigure = reconfigure
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.runtime.prepare === undefined) throw new Error('plugin lifecycle prepare is unavailable')
    return this.runtime.prepare(transactionId)
  }

  async prepareBrowserGraph(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence> {
    if (this.runtime.prepareBrowserGraph === undefined) throw new Error('browser graph preparation is unavailable')
    return await this.runtime.prepareBrowserGraph(transactionId, active)
  }

  async stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation> {
    const result = await this.runtime.stage(mutation)
    this.mutations.set(mutation.transactionId, mutation)
    return result
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const mutation = this.mutations.get(transactionId)
    if (mutation === undefined) throw new Error('provider lifecycle mutation is unavailable')
    if (this.reconfigure !== undefined) {
      this.providers.set(transactionId, await this.reconfigure(mutation.candidate))
    }
    const provider = this.providers.get(transactionId)
    this.finalizers.set(
      transactionId,
      new RetryableCleanup([
        async () => {
          await this.runtime.finalize?.(transactionId)
        },
        async () => {
          await provider?.finalize()
        },
      ], 'Plugin lifecycle participant finalize failed'),
    )
    if (this.runtime.publish === undefined) throw new Error('plugin lifecycle publication is unavailable')
    return await this.runtime.publish(transactionId)
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.complete === undefined) throw new Error('plugin lifecycle cleanup is unavailable')
    return await this.runtime.complete(transactionId)
  }

  async finalize(transactionId: string): Promise<void> {
    if (this.directions.get(transactionId) === 'rollback') throw new Error('Provider plugin is rolling back')
    this.directions.set(transactionId, 'finalize')
    await this.finalizers.get(transactionId)?.run()
    this.clear(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.rollback === undefined) throw new Error('plugin lifecycle rollback is unavailable')
    return await this.rollbackParticipants(transactionId, async () => await this.runtime.rollback!(transactionId))
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (this.runtime.recoverRollback === undefined) throw new Error('plugin lifecycle recovery is unavailable')
    return await this.rollbackParticipants(plan.transactionId, async () => await this.runtime.recoverRollback!(plan))
  }

  private async rollbackParticipants(
    transactionId: string,
    renderer: () => Promise<RuntimeCleanupObservation>,
  ): Promise<RuntimeCleanupObservation> {
    if (this.directions.get(transactionId) === 'finalize') throw new Error('Provider plugin is finalizing')
    this.directions.set(transactionId, 'rollback')
    let rollback = this.rollbacks.get(transactionId)
    if (rollback === undefined) {
      const provider = this.providers.get(transactionId)
      const entry: ProviderRollback = {
        renderer,
        cleanup: new RetryableCleanup([
          async () => {
            await provider?.rollback()
          },
          async () => {
            entry.observation = await entry.renderer()
          },
        ], 'Plugin lifecycle participant rollback failed'),
      }
      rollback = entry
      this.rollbacks.set(transactionId, entry)
    } else rollback.renderer = renderer
    await rollback.cleanup.run()
    this.clear(transactionId)
    // Retain recent completed observations for repeated calls, never evict unfinished cleanup.
    for (const [id, entry] of this.rollbacks) {
      if (this.rollbacks.size <= 128) break
      if (id !== transactionId && entry.cleanup.completed) {
        this.rollbacks.delete(id)
        this.directions.delete(id)
      }
    }
    return rollback.observation!
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    await this.runtime.adoptRecoveredActivation?.(active, registryEpoch)
  }

  async commit(transactionId: string): Promise<void> {
    await this.runtime.commit(transactionId)
  }

  async abort(transactionId: string): Promise<void> {
    if (this.providers.has(transactionId) || this.rollbacks.has(transactionId)) await this.rollback(transactionId)
    await this.runtime.abort(transactionId)
    this.clear(transactionId)
  }

  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    await this.runtime.reload(input)
  }

  terminal(error: unknown): void {
    this.runtime.terminal?.(error)
  }

  private clear(transactionId: string): void {
    this.mutations.delete(transactionId)
    this.providers.delete(transactionId)
    this.finalizers.delete(transactionId)
    for (const id of this.directions.keys()) {
      if (this.directions.size <= 128) break
      if (
        id !== transactionId && !this.providers.has(id) && !this.finalizers.has(id)
        && (this.rollbacks.get(id)?.cleanup.completed ?? true)
      ) this.directions.delete(id)
    }
  }
}
