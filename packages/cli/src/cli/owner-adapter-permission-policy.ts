import { parsePermissionBindingRequest, persistPermissionPoliciesIfUnchanged } from '../launcher/permission-rpc.js'
import { attachmentEqual, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  normalizePersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../standalone-permission-contract.js'
import type { ManagerOriginFence } from './manager-origin-fence.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import type { OwnerAdapterPermissionProof } from './owner-adapter-permission-proof.js'
import { ownerAdapterInstalledPermissionTarget } from './owner-adapter-permission-target.js'
import { ownerAdapterConfiguredPermissionTarget } from './owner-adapter-configured-permission.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { ServiceOwnerPermissionConsumers } from './service-owner-permission-consumers.js'
import type { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import type { CordisXConfig } from '../launcher/config.js'

/** Owner-only native permission writes use the same profile and renderer barrier as Web. */
export function createOwnerAdapterPermissionPolicy(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly profileId: string
  readonly generation: string
  readonly lifecycle: OwnerRendererLifecycle
  readonly loadPolicies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  readonly journal: PermissionDecisionJournal
  readonly proof: OwnerAdapterPermissionProof
  readonly loadPackage?: typeof loadStagedPluginPackage
  readonly configured?: () => { readonly config: CordisXConfig; readonly signal: AbortSignal } | undefined
  readonly runtime: () => {
    readonly bootstrap: ServiceRendererBootstrap
    readonly consumers: ServiceOwnerPermissionConsumers
    readonly fence: (rendererId: string) => Promise<ManagerOriginFence>
  } | undefined
}) {
  return async (raw: unknown, context: OwnerAdapterManagementContext): Promise<unknown> => {
    const operation = attachmentRecord(raw)
    if (operation.kind === 'permission-key-register') {
      if (
        Object.keys(operation).length !== 3 || !Object.hasOwn(operation, 'keyId') || !Object.hasOwn(operation, 'key')
      ) {
        throw new Error('adapter-permission-unavailable')
      }
      input.proof.register(context, operation.keyId, operation.key)
      return true
    }
    const once = operation.kind === 'permission-once'
    if (
      !context.live() || !Object.hasOwn(operation, 'requestId') || !Object.hasOwn(operation, 'proof')
      || (once
        ? Object.keys(operation).length !== 5 || !Object.hasOwn(operation, 'record')
          || operation.decision !== 'allow-once' && operation.decision !== 'deny-once'
        : operation.kind !== 'permission-policy-write' || Object.keys(operation).length !== 4
          || !Array.isArray(operation.records) || operation.records.length !== 1)
    ) {
      throw new Error('adapter-permission-unavailable')
    }
    const rawRecords = once ? [operation.record] : operation.records as unknown[]
    const first = normalizePersistedPermissionPolicyRecord(rawRecords[0])
    if (once && first.policy !== 'ask') throw new Error('adapter-permission-unavailable')
    let target = await ownerAdapterInstalledPermissionTarget({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.generation,
      pluginId: first.key.identity.pluginId,
      context,
      lifecycle: input.lifecycle,
      ...(input.loadPackage === undefined ? {} : { loadPackage: input.loadPackage }),
    }).catch(() => undefined)
    if (!target) {
      const configured = input.configured?.()
      if (!configured) throw new Error('adapter-permission-unavailable')
      const wrapped = attachmentRecord(operation.proof)
      const signed = attachmentRecord(wrapped.proof)
      const payload = attachmentRecord(signed.payload)
      if (typeof payload.moduleGeneration !== 'string') throw new Error('adapter-permission-unavailable')
      target = await ownerAdapterConfiguredPermissionTarget({
        homeDir: input.homeDir,
        profileId: input.profileId,
        generation: input.generation,
        pluginId: first.key.identity.pluginId,
        moduleGeneration: payload.moduleGeneration,
        context,
        lifecycle: input.lifecycle,
        ...configured,
      })
    }
    const targetCurrent = async () =>
      target!.isCurrent() && (target!.verifyCurrent === undefined || await target!.verifyCurrent())
    if (!await targetCurrent()) throw new Error('adapter-permission-unavailable')
    const request = parsePermissionBindingRequest({
      token: STANDALONE_PERMISSION_BINDING_MARKER,
      requestId: operation.requestId,
      records: rawRecords,
    }, {
      token: STANDALONE_PERMISSION_BINDING_MARKER,
      profileId: input.profileId,
      identities: [target.identity],
    })
    const updates = target.resolve(request.records)
    if (!attachmentEqual(target.project(updates).policies, request.records)) {
      throw new Error('adapter-permission-unavailable')
    }
    const expected = await input.loadPolicies()
    const runtime = input.runtime()
    if (!runtime || !context.live() || !await targetCurrent()) throw new Error('adapter-permission-unavailable')
    const common = {
      context,
      requestId: request.requestId,
      expected,
      moduleGeneration: target.moduleGeneration,
      artifact: target.artifact,
      proof: operation.proof,
    }
    const authorized = once
      ? input.proof.authorizeOnce({
        ...common,
        record: updates[0]!,
        decision: operation.decision as 'allow-once' | 'deny-once',
      })
      : input.proof.authorize({ ...common, records: updates })
    if (!authorized) throw new Error('adapter-permission-unavailable')
    const trace = await input.journal.begin({
      client: 'codex',
      requestId: request.requestId,
      records: updates,
      ...(once ? { onceDecision: operation.decision as 'allow-once' | 'deny-once' } : {}),
    })
    if (!context.live() || !await targetCurrent()) throw new Error('adapter-permission-unavailable')
    if (once) {
      if (!attachmentEqual(expected, await input.loadPolicies()) || !context.current(false)) {
        throw new Error('adapter-permission-unavailable')
      }
      await trace.commit()
      if (!context.current(false) || !await targetCurrent() || !attachmentEqual(expected, await input.loadPolicies())) {
        throw new Error('adapter-permission-unavailable')
      }
      return true
    }
    const origin = await runtime.fence(context.rendererId)
    let consumers: ReturnType<ServiceOwnerPermissionConsumers['reserve']> | undefined
    try {
      consumers = runtime.consumers.reserve(origin, {
        identity: target.ownerIdentity,
        moduleGeneration: target.moduleGeneration,
        kind: target.kind,
        artifact: target.artifact,
        isCurrent: target.isCurrent,
      })
      if (target.kind !== 'installed') await consumers.prepare()
      if (!await targetCurrent()) throw new Error('adapter-permission-unavailable')
      const renderer = {
        profileId: input.profileId,
        ownerGeneration: input.generation,
        rendererId: context.rendererId,
        signal: context.signal,
        admitted: true,
      }
      const barrier = await runtime.bootstrap.permissionAccess.reserve(
        origin,
        renderer,
        request.requestId,
        expected,
        updates,
        consumers,
        target,
      )
      try {
        if (!await barrier.isCurrent()) throw new Error('adapter-permission-unavailable')
        const result = await barrier.run(async () =>
          await persistPermissionPoliciesIfUnchanged({
            configPath: input.configPath,
            profileId: input.profileId,
            expected,
            assertCurrent: async () => {
              if (!await targetCurrent() || !await barrier.isCurrent()) {
                throw new Error('adapter-permission-unavailable')
              }
            },
          }, updates)
        )
        if (!await barrier.complete(result.policies) || !context.live()) {
          throw new Error('adapter-permission-unavailable')
        }
        await trace.commit()
        return result.records
      } catch (error) {
        await Promise.resolve(barrier.fence()).catch(() => undefined)
        throw error
      }
    } catch (error) {
      consumers?.fence()
      origin.fence()
      throw error
    }
  }
}
