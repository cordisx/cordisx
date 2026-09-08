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

/** Makes the Node provider Fleet a participant in the existing durable plugin transaction. */
export class PlatformProviderPluginLifecycleRuntime implements PluginLifecycleRuntime {
  private readonly mutations = new Map<string, PluginRuntimeMutation>()
  private readonly providers = new Map<string, ProviderTransaction>()
  private readonly finalizeProgress = new Map<string, { renderer: boolean; provider: boolean }>()
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
    this.finalizeProgress.set(transactionId, { renderer: false, provider: this.reconfigure === undefined })
    if (this.runtime.publish === undefined) throw new Error('plugin lifecycle publication is unavailable')
    return await this.runtime.publish(transactionId)
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    if (this.runtime.complete === undefined) throw new Error('plugin lifecycle cleanup is unavailable')
    return await this.runtime.complete(transactionId)
  }

  async finalize(transactionId: string): Promise<void> {
    const progress = this.finalizeProgress.get(transactionId) ?? { renderer: false, provider: false }
    const failures: unknown[] = []
    if (!progress.renderer) {
      try {
        await this.runtime.finalize?.(transactionId)
        progress.renderer = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (!progress.provider) {
      try {
        await this.providers.get(transactionId)?.finalize()
        progress.provider = true
      } catch (error) {
        failures.push(error)
      }
    }
    this.finalizeProgress.set(transactionId, progress)
    if (failures.length > 0) throw new AggregateError(failures, 'Plugin lifecycle participant finalize failed')
    this.clear(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    let providerFailure: unknown
    try {
      await this.providers.get(transactionId)?.rollback()
    } catch (error) {
      providerFailure = error
    }
    if (this.runtime.rollback === undefined) throw new Error('plugin lifecycle rollback is unavailable')
    const observation = await this.runtime.rollback(transactionId)
    this.clear(transactionId)
    if (providerFailure !== undefined) throw providerFailure
    return observation
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (this.runtime.recoverRollback === undefined) throw new Error('plugin lifecycle recovery is unavailable')
    return await this.runtime.recoverRollback(plan)
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    await this.runtime.adoptRecoveredActivation?.(active, registryEpoch)
  }

  async commit(transactionId: string): Promise<void> {
    await this.runtime.commit(transactionId)
  }

  async abort(transactionId: string): Promise<void> {
    this.clear(transactionId)
    await this.runtime.abort(transactionId)
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
    this.finalizeProgress.delete(transactionId)
  }
}
