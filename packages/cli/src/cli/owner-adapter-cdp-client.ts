import { randomUUID } from 'node:crypto'
import type { CdpPluginLifecycleRuntime, CdpSharedAdmission } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import { sameUniquePluginIds } from '../launcher/cdp-shared-admission.js'
import type { PluginRuntimeMutation, RuntimeGenerationFence } from '../launcher/plugin-lifecycle-model.js'
import { attachmentEqual, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererCommand } from './manager-renderer-peer.js'
import { parseOwnerPolicyPacket, parseOwnerPolicyTransition } from '../owner-policy-handoff.js'

type Transaction = {
  readonly id: string
  readonly fence: RuntimeGenerationFence
  readonly admission: CdpSharedAdmission
  phase: 'prepared' | 'staged' | 'published' | 'completed' | 'rolled-back'
}

/**
 * A native adapter applies owner-issued lifecycle commands to its already
 * injected CDP renderer fleet. It creates no package or service authority.
 */
export class OwnerAdapterCdpClient {
  private transaction: Transaction | undefined
  private closed = false

  constructor(
    private readonly input: {
      readonly cdp: Pick<
        CdpPluginLifecycleRuntime,
        'beginSharedAdmission' | 'refreshBrowserGraphBootstrap' | 'terminal'
      >
      readonly policyScope?: { readonly profileId: string; readonly generation: string; readonly rendererId: string }
      /** Bookkeeping only; called after every native renderer adopted the owner transition. */
      readonly onPolicyAdopted?: (
        transition: import('../owner-policy-handoff.js').OwnerPolicyTransition,
      ) => Promise<void>
      /** Resolve only owner-issued package and graph data in the private client process. */
      readonly loadMutation: (value: unknown) => Promise<PluginRuntimeMutation>
    },
  ) {}

  async handle(command: ManagerRendererCommand): Promise<
    { readonly ok: true; readonly value: unknown } | {
      readonly ok: false
    }
  > {
    if (this.closed) return { ok: false }
    try {
      const value = await this.execute(command)
      if (this.closed) return { ok: false }
      return { ok: true, value }
    } catch (error) {
      this.close(error)
      return { ok: false }
    }
  }

  private async execute(command: ManagerRendererCommand): Promise<unknown> {
    const frame = attachmentRecord(command.payload)
    if (command.method === 'permission-provenance') {
      if (
        !this.input.policyScope || this.transaction || Object.keys(frame).length !== 1
        || typeof frame.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(frame.pluginId)
      ) throw new Error('adapter-policy-provenance-unavailable')
      const admission = this.input.cdp.beginSharedAdmission(`adapter-provenance-${randomUUID()}`)
      try {
        const before = await admission.readSnapshot()
        const proof = await admission.configurationProof(frame.pluginId)
        const configured = proof?.plugin.configured
        if (
          !proof || !configured || proof.plugin.id !== frame.pluginId
          || proof.plugin.package !== undefined || typeof proof.plugin.source !== 'string'
          || !attachmentEqual(proof.snapshot, before) || !attachmentEqual(await admission.readSnapshot(), before)
        ) return { available: false }
        return {
          available: true,
          rendererId: this.input.policyScope.rendererId,
          ownerGeneration: this.input.policyScope.generation,
          snapshot: before,
          identity: { id: proof.plugin.id, source: proof.plugin.source },
          artifact: { version: configured.version, integrity: configured.integrity },
          moduleGeneration: configured.moduleGeneration,
        }
      } catch {
        // A read-only proof can be unavailable without retiring a healthy client.
        return { available: false }
      } finally {
        admission.release()
      }
    }
    if (command.method === 'permission-policy') {
      if (!this.input.policyScope || this.transaction) throw new Error('adapter-policy-handoff-unavailable')
      const packet = parseOwnerPolicyPacket(frame)
      const transition = parseOwnerPolicyTransition(JSON.parse(packet.payload), this.input.policyScope)
      const admission = this.input.cdp.beginSharedAdmission(`adapter-policy-${randomUUID()}`)
      try {
        const before = await admission.readSnapshot()
        await admission.adoptOwnerManagerPolicy(packet)
        await this.input.cdp.refreshBrowserGraphBootstrap(before.active)
        if (!attachmentEqual(await admission.readSnapshot(), before)) throw new Error('adapter-policy-handoff-stale')
        try {
          await this.input.onPolicyAdopted?.(transition)
        } catch { /* Launch bookkeeping cannot undo an adopted policy. */ }
        return {
          rendererId: transition.rendererId,
          ownerGeneration: transition.ownerGeneration,
          handoffId: transition.handoffId,
          requestId: transition.requestId,
          moduleGeneration: transition.moduleGeneration,
          adopted: true,
        }
      } catch (error) {
        this.input.cdp.terminal(error)
        throw error
      } finally {
        admission.release()
      }
    }
    if (command.method === 'synchronize') {
      const pending = this.transaction
      if (pending) {
        if (pending.phase !== 'rolled-back') throw new Error('adapter-lifecycle-unavailable')
        await pending.admission.adoptRecoveredActivation(
          frame.active as PluginRuntimeMutation['previous'],
          frame.registryEpoch as number,
        )
        const result = await pending.admission.readSnapshot()
        if (!attachmentEqual(result, frame)) throw new Error('adapter-lifecycle-stale')
        pending.admission.release()
        this.transaction = undefined
        return result
      }
      const admission = this.input.cdp.beginSharedAdmission(`adapter-sync-${randomUUID()}`)
      try {
        const result = await admission.readSnapshot()
        if (!attachmentEqual(result, frame)) throw new Error('adapter-lifecycle-stale')
        return result
      } finally {
        admission.release()
      }
    }
    if (command.method === 'prepare') {
      if (
        this.transaction || typeof frame.transactionId !== 'string'
        || typeof frame.transactionEpoch !== 'string' || !Number.isSafeInteger(frame.expectedRegistryEpoch)
      ) throw new Error('adapter-lifecycle-unavailable')
      const admission = this.input.cdp.beginSharedAdmission(frame.transactionId)
      try {
        const snapshot = await admission.readSnapshot()
        if (snapshot.registryEpoch !== frame.expectedRegistryEpoch) throw new Error('adapter-lifecycle-stale')
        const fence = {
          transactionEpoch: frame.transactionEpoch,
          expectedRegistryEpoch: frame.expectedRegistryEpoch as number,
        }
        await admission.prepareBrowserGraph(snapshot.active, fence)
        this.transaction = { id: frame.transactionId, fence, admission, phase: 'prepared' }
        return { transactionId: frame.transactionId, ...fence }
      } catch (error) {
        try {
          admission.release()
        } catch { /* The CDP runtime must remain fenced after an uncertain preparation. */ }
        throw error
      }
    }
    const transaction = this.transaction
    if (!transaction || frame.transactionId !== transaction.id) throw new Error('adapter-lifecycle-unavailable')
    if (command.method === 'stage') {
      if (transaction.phase !== 'prepared') throw new Error('adapter-lifecycle-unavailable')
      const mutation = await this.input.loadMutation(command.payload)
      if (
        mutation.transactionId !== transaction.id || mutation.transactionEpoch !== transaction.fence.transactionEpoch
        || mutation.expectedRegistryEpoch !== transaction.fence.expectedRegistryEpoch
      ) throw new Error('adapter-lifecycle-stale')
      const observation = await transaction.admission.stage(mutation)
      const affected = (observation as typeof observation & { affectedPluginIds?: unknown })?.affectedPluginIds
      if (!observation || !sameUniquePluginIds(affected, mutation.affectedPluginIds)) {
        throw new Error('adapter-lifecycle-stale')
      }
      transaction.phase = 'staged'
      return { ...observation, affectedPluginIds: [...mutation.affectedPluginIds] }
    }
    if (command.method === 'publish' && transaction.phase === 'staged') {
      const result = await transaction.admission.publish(transaction.id)
      transaction.phase = 'published'
      return result
    }
    if (command.method === 'complete' && transaction.phase === 'published') {
      const result = await transaction.admission.complete(transaction.id)
      transaction.phase = 'completed'
      return result
    }
    if (command.method === 'finalize' && transaction.phase === 'completed') {
      await transaction.admission.finalize(transaction.id)
      transaction.admission.release()
      this.transaction = undefined
      return { transactionId: transaction.id }
    }
    if (command.method === 'rollback' && transaction.phase !== 'rolled-back') {
      const result = await transaction.admission.rollback(transaction.id)
      transaction.phase = 'rolled-back'
      return result
    }
    throw new Error('adapter-lifecycle-unavailable')
  }

  close(error: unknown = new Error('adapter-owner-disconnected')): void {
    if (this.closed) return
    this.closed = true
    if (this.transaction) this.input.cdp.terminal(error)
  }
}
