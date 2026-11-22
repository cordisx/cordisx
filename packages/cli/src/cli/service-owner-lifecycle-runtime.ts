import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
} from '../launcher/plugin-lifecycle-model.js'
import type { ServiceOwnerLifecycleFence } from './service-owner-lifecycle-fence.js'

type Transition = {
  readonly id: string
  readonly fence: ServiceOwnerLifecycleFence
  prepared: boolean
  rolledBack: boolean
  operating: boolean
}

/** Wraps the existing lifecycle; it does not create a second plugin runtime. */
export class ServiceOwnerLifecycleRuntime implements PluginLifecycleRuntime {
  private transition: Transition | undefined
  private acquiring = false

  constructor(
    private readonly input: {
      readonly runtime: PluginLifecycleRuntime
      /** Returns undefined only when there are no live Manager sessions to coordinate. */
      readonly reserve: (
        mutation: PluginRuntimePreflight,
      ) => ServiceOwnerLifecycleFence | undefined | Promise<ServiceOwnerLifecycleFence | undefined>
    },
  ) {}

  get requiresBrowserArtifacts() {
    return this.input.runtime.requiresBrowserArtifacts?.bind(this.input.runtime)
  }
  get browserArtifactServer() {
    return this.input.runtime.browserArtifactServer?.bind(this.input.runtime)
  }

  async preflight(mutation: PluginRuntimePreflight): Promise<void> {
    if (this.acquiring || this.transition) throw new Error('manager-lifecycle-fence-unavailable')
    this.acquiring = true
    let fence: ServiceOwnerLifecycleFence | undefined
    try {
      const reservation = this.input.reserve(mutation)
      fence = reservation === undefined ? undefined : await reservation
      if (fence && !this.input.runtime.preflight) throw new Error('manager-lifecycle-fence-unavailable')
      await this.input.runtime.preflight?.(mutation)
      if (fence && !fence.isCurrent()) throw new Error('manager-lifecycle-fence-unavailable')
      if (fence) {
        this.transition = { id: mutation.transactionId, fence, prepared: false, rolledBack: false, operating: false }
      }
    } catch (error) {
      if (fence && !fence.cancel()) {
        fence.fence()
        this.input.runtime.terminal?.(error)
      }
      throw error
    } finally {
      this.acquiring = false
    }
  }

  private fail(transition: Transition, error: unknown): void {
    if (this.transition === transition) this.transition = undefined
    try {
      transition.fence.fence()
    } finally {
      this.input.runtime.terminal?.(error)
    }
  }

  private current(transactionId: string): Transition | undefined {
    if (this.acquiring) throw new Error('manager-lifecycle-fence-unavailable')
    const transition = this.transition
    if (!transition) return undefined
    if (transition.id !== transactionId || transition.operating) throw new Error('manager-lifecycle-fence-unavailable')
    if (!transition.fence.isCurrent()) {
      const error = new Error('manager-lifecycle-fence-unavailable')
      this.fail(transition, error)
      throw error
    }
    return transition
  }

  private async run<T>(transactionId: string, action: (transition: Transition | undefined) => Promise<T>): Promise<T> {
    const transition = this.current(transactionId)
    if (transition) transition.operating = true
    try {
      const result = await action(transition)
      if (transition && this.transition === transition && !transition.fence.isCurrent()) {
        throw new Error('manager-lifecycle-fence-unavailable')
      }
      return result
    } catch (error) {
      if (transition && this.transition === transition && !transition.fence.isCurrent()) this.fail(transition, error)
      throw error
    } finally {
      if (transition) transition.operating = false
    }
  }

  prepare(transactionId: string) {
    const transition = this.current(transactionId)
    try {
      if (!this.input.runtime.prepare) throw new Error('plugin lifecycle prepare is unavailable')
      const result = this.input.runtime.prepare(transactionId)
      if (transition) transition.prepared = true
      return result
    } catch (error) {
      if (transition) this.fail(transition, error)
      throw error
    }
  }

  async prepareBrowserGraph(transactionId: string, active: CordisXPluginActivationRecordV1) {
    return await this.run(transactionId, async transition => {
      try {
        if (!this.input.runtime.prepareBrowserGraph) throw new Error('plugin lifecycle graph is unavailable')
        const result = await this.input.runtime.prepareBrowserGraph(transactionId, active)
        if (transition) transition.prepared = true
        return result
      } catch (error) {
        if (transition && this.transition === transition) this.fail(transition, error)
        throw error
      }
    })
  }

  async stage(mutation: PluginRuntimeMutation) {
    return await this.run(mutation.transactionId, async transition => {
      if (transition && !transition.prepared) throw new Error('manager-lifecycle-fence-unavailable')
      return await this.input.runtime.stage(mutation)
    })
  }
  async publish(transactionId: string) {
    return await this.run(transactionId, async () => {
      if (!this.input.runtime.publish) throw new Error('plugin lifecycle publication is unavailable')
      return await this.input.runtime.publish(transactionId)
    })
  }
  async complete(transactionId: string) {
    return await this.run(transactionId, async () => {
      if (!this.input.runtime.complete) throw new Error('plugin lifecycle cleanup is unavailable')
      return await this.input.runtime.complete(transactionId)
    })
  }
  async finalize(transactionId: string): Promise<void> {
    await this.run(transactionId, async transition => {
      if (!this.input.runtime.finalize) throw new Error('plugin lifecycle finalization is unavailable')
      await this.input.runtime.finalize(transactionId)
      if (transition) await this.finish(transition)
    })
  }
  async rollback(transactionId: string) {
    return await this.run(transactionId, async transition => {
      try {
        if (!this.input.runtime.rollback) throw new Error('plugin lifecycle rollback is unavailable')
        const result = await this.input.runtime.rollback(transactionId)
        if (transition) transition.rolledBack = true
        return result
      } catch (error) {
        if (transition && this.transition === transition) this.fail(transition, error)
        throw error
      }
    })
  }
  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (!this.input.runtime.recoverRollback) throw new Error('plugin lifecycle recovery is unavailable')
    return await this.input.runtime.recoverRollback(plan)
  }
  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const transition = this.transition
    if (!transition) return await this.input.runtime.adoptRecoveredActivation?.(active, registryEpoch)
    await this.run(transition.id, async current => {
      try {
        if (!current?.rolledBack || !this.input.runtime.adoptRecoveredActivation) {
          throw new Error('manager-lifecycle-fence-unavailable')
        }
        await this.input.runtime.adoptRecoveredActivation(active, registryEpoch)
        await this.finish(current)
      } catch (error) {
        if (current && this.transition === current) this.fail(current, error)
        throw error
      }
    })
  }
  private async finish(transition: Transition): Promise<void> {
    if (!await transition.fence.finish()) {
      const error = new Error('manager-lifecycle-fence-unavailable')
      this.fail(transition, error)
      throw error
    }
    if (this.transition === transition) this.transition = undefined
  }
  async commit(transactionId: string): Promise<void> {
    await this.run(transactionId, async transition => {
      await this.input.runtime.commit(transactionId)
      if (transition) await this.finish(transition)
    })
  }
  async abort(transactionId: string): Promise<void> {
    await this.run(transactionId, async transition => {
      try {
        await this.input.runtime.abort(transactionId)
        if (transition && !(transition.prepared ? transition.fence.abort() : transition.fence.cancel())) {
          throw new Error('manager-lifecycle-fence-unavailable')
        }
        if (transition && this.transition === transition) this.transition = undefined
      } catch (error) {
        if (transition && this.transition === transition) this.fail(transition, error)
        throw error
      }
    })
  }
  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    if (this.acquiring || this.transition) throw new Error('manager-lifecycle-fence-unavailable')
    await this.input.runtime.reload(input)
  }
  terminal(error: unknown): void {
    const transition = this.transition
    if (transition) this.fail(transition, error)
    else this.input.runtime.terminal?.(error)
  }
}
