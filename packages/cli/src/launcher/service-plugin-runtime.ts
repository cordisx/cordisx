import { randomUUID } from 'node:crypto'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../plugin-lifecycle-contracts.js'
import type { PackageActivationTuple } from './packages/types.js'
import type { PluginLifecycleRuntime, PluginRuntimeMutation } from './plugin-lifecycle-model.js'

export interface ServicePluginRuntime extends PluginLifecycleRuntime {
  /** Advance the dormant headless runtime after an acknowledged renderer transaction. */
  adoptRegistryEpoch(epoch: number): void
}

/** Channel remains owned by the service even when renderers are attached. */
export function assertServiceMutationAllowed(mutation: Pick<PluginRuntimeMutation, 'previous' | 'candidate'>): void {
  const channel = (plugins: typeof mutation.previous.plugins) => plugins.find(plugin => plugin.id === 'channel')
  if (JSON.stringify(channel(mutation.previous.plugins)) !== JSON.stringify(channel(mutation.candidate.plugins))) {
    throw new Error('Stop service mode before changing Channel activation')
  }
}

/** Observes package publication for a Node-only owner. Backend adoption and
 * cleanup are performed by the surrounding ManagedServicePluginLifecycleRuntime. */
export function createServicePluginRuntime(runtimeGeneration: string): ServicePluginRuntime {
  const record = (tuple: PackageActivationTuple) => ({
    ...tuple,
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    runtimeGeneration,
  })
  let registryEpoch = 0
  let transaction: { id: string; epoch: string; staged?: PluginRuntimeMutation } | undefined
  const stage = (id: string) => {
    if (transaction?.id !== id || !transaction.staged) throw new Error('Service transaction is not staged')
    return transaction.staged
  }
  const observation = (id: string, rollback = false) => {
    const mutation = stage(id)
    return {
      transactionId: id,
      transactionEpoch: mutation.transactionEpoch!,
      registryEpoch,
      active: rollback ? mutation.previous : mutation.candidate,
      disposedAfter: rollback ? mutation.candidate : mutation.previous,
    }
  }
  return {
    prepare(id) {
      if (transaction !== undefined) throw new Error('A service transaction is already in progress')
      transaction = { id, epoch: randomUUID() }
      return { transactionEpoch: transaction.epoch, expectedRegistryEpoch: registryEpoch }
    },
    async stage(mutation) {
      // Channel is a profile-owned ingress/consumer, not a managed-backend transaction.
      // Until it can be replaced transactionally, change it only with the service stopped.
      assertServiceMutationAllowed(mutation)
      if (
        transaction?.id !== mutation.transactionId || mutation.transactionEpoch !== transaction.epoch
        || mutation.expectedRegistryEpoch !== registryEpoch || mutation.afterRegistryEpoch !== registryEpoch + 1
      ) {
        throw new Error('Service transaction generation changed')
      }
      transaction.staged = mutation
      return {
        transactionId: mutation.transactionId,
        transactionEpoch: transaction.epoch,
        expectedRegistryEpoch: registryEpoch,
        afterRegistryEpoch: registryEpoch + 1,
        observation: mutation.candidate,
      }
    },
    async publish(id) {
      registryEpoch = stage(id).afterRegistryEpoch!
      return observation(id)
    },
    async complete(id) {
      return observation(id)
    },
    async finalize(id) {
      stage(id)
      transaction = undefined
    },
    async rollback(id) {
      registryEpoch = stage(id).afterRegistryEpoch! + 1
      const restored = observation(id, true)
      transaction = undefined
      return restored
    },
    async recoverRollback(plan) {
      registryEpoch = plan.rollbackRegistryEpoch
      return {
        transactionId: plan.transactionId,
        transactionEpoch: plan.transactionEpoch,
        registryEpoch,
        active: record(plan.rollbackTarget),
        disposedAfter: record(plan.expectedPublished),
      }
    },
    async commit() {
      throw new Error('Service runtime requires a package authority transaction')
    },
    async abort(id) {
      if (transaction?.id === id) transaction = undefined
    },
    async reload() {
      throw new Error('Renderer reload is unavailable in service mode; use cordisx restart --mode service')
    },
    adoptRegistryEpoch(epoch) {
      if (transaction !== undefined || !Number.isSafeInteger(epoch) || epoch < registryEpoch) {
        throw new Error('Service registry epoch cannot be adopted')
      }
      registryEpoch = epoch
    },
  }
}
