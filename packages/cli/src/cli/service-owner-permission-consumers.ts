import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { randomBytes } from 'node:crypto'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import {
  consumeReleasedManagerOriginFence,
  isCurrentManagerOriginFence,
  type ManagerOriginFence,
} from './manager-origin-fence.js'
import type { ServiceRendererPermissionConsumerFence } from './service-renderer-permission-handoff.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { OwnerAdapterSessions } from './owner-adapter-sessions.js'

/**
 * The origin fence reserves every admitted renderer. Manager UI policies
 * and exact declared runtime policies are applied to service-attached native
 * adapters with a signed handoff; other kinds need their own consumer fence.
 */
export class ServiceOwnerPermissionConsumers {
  private reservation: symbol | undefined
  private fenced = false
  private closed = false

  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly channelSource?: string
      readonly participants: ServiceRendererParticipants
      readonly lifecycle: ServiceRendererLifecycle
      readonly ownerCurrent: () => boolean
      readonly loadPolicies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
      readonly nativeAdapters?: OwnerAdapterSessions
    },
  ) {}

  reserve(
    origin: ManagerOriginFence,
    target?: {
      readonly identity: { readonly id: string; readonly source: string }
      readonly moduleGeneration?: string
      readonly kind?: 'installed' | 'configured-channel' | 'configured-plugin'
      readonly artifact?: { readonly version: string; readonly integrity: `sha256:${string}` }
      readonly isCurrent: () => boolean
    },
  ): ServiceRendererPermissionConsumerFence & { prepare(): Promise<void> } {
    const identity = target?.identity ?? { id: 'channel', source: this.input.channelSource ?? '' }
    const selected = Object.freeze({ id: identity.id, source: identity.source })
    const targetCurrent = () => {
      try {
        return target === undefined || target.isCurrent() === true
      } catch {
        return false
      }
    }
    const ownerCurrent = () => {
      try {
        return !this.closed && !this.fenced && this.input.ownerCurrent() === true
      } catch {
        return false
      }
    }
    if (
      !ownerCurrent() || this.reservation !== undefined || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(selected.id)
      || typeof selected.source !== 'string' || selected.source.length === 0 || selected.source.length > 4096
      || !targetCurrent()
      || !isCurrentManagerOriginFence(origin, this.input.participants, this.input.lifecycle)
      || (origin.additionalPeers?.length ?? 0) > 0 && (!this.input.nativeAdapters || !target?.moduleGeneration)
      || target?.kind?.startsWith('configured-') && !target.artifact
    ) throw new Error('service-permission-consumers-unavailable')
    const reservation = Symbol('service-permission-consumers')
    this.reservation = reservation
    let ended = false
    let started = false
    let adopted = false
    let preparing = false
    const nativePeers = origin.additionalPeers ?? []
    const needsProvenance = nativePeers.length > 0 && target?.kind?.startsWith('configured-') === true
    let prepared = !needsProvenance
    const generations = new Map<string, string>()
    const current = () =>
      !ended && ownerCurrent() && targetCurrent() && this.reservation === reservation
      && isCurrentManagerOriginFence(origin, this.input.participants, this.input.lifecycle)
    const fence = () => {
      if (ended) return
      ended = true
      if (this.reservation === reservation) {
        this.reservation = undefined
        this.fenced = true
      }
    }
    return {
      isCurrent: current,
      /** Resolve each native graph before any policy write is dispatched. */
      prepare: async () => {
        if (!current()) throw new Error('service-permission-consumers-unavailable')
        if (prepared) return
        if (preparing || started || !target?.artifact) {
          throw new Error('service-permission-consumers-unavailable')
        }
        preparing = true
        try {
          const snapshot = this.input.lifecycle.snapshot()
          await Promise.all(nativePeers.map(async peer => {
            const value = await peer.request('permission-provenance', { pluginId: selected.id })
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('service-permission-consumers-unavailable')
            }
            const proof = value as Record<string, unknown>
            if (
              !current() || peer.closed || Object.keys(proof).length !== 7 || proof.available !== true
              || proof.rendererId !== peer.identity.rendererId || proof.ownerGeneration !== this.input.generation
              || !attachmentEqual(proof.snapshot, snapshot)
              || !attachmentEqual(this.input.lifecycle.snapshot(), snapshot)
              || !attachmentEqual(proof.identity, selected) || !attachmentEqual(proof.artifact, target.artifact)
              || typeof proof.moduleGeneration !== 'string'
              || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(proof.moduleGeneration)
              || peer.identity.rendererId === origin.rendererId && proof.moduleGeneration !== target.moduleGeneration
            ) throw new Error('service-permission-consumers-unavailable')
            generations.set(peer.identity.rendererId, proof.moduleGeneration)
          }))
          if (!current() || generations.size !== nativePeers.length) {
            throw new Error('service-permission-consumers-unavailable')
          }
          prepared = true
        } catch (error) {
          fence()
          throw error
        } finally {
          preparing = false
        }
      },
      adopt: async (request, signal) => {
        if (started || !prepared || !current() || signal.aborted) {
          throw new Error('service-permission-consumers-unavailable')
        }
        started = true
        const expected = request.expected.map(record => normalizePersistedPermissionPolicyRecord(record))
        const updates = request.updates.map(record => normalizePersistedPermissionPolicyRecord(record))
        const candidate = request.candidate.map(record => normalizePersistedPermissionPolicyRecord(record))
        const update = updates[0]
        if (
          request.profileId !== this.input.profileId || request.ownerGeneration !== this.input.generation
          || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId) || expected.length > 4096
          || updates.length !== 1 || !update
          || !isPermissionPolicyRecordV3(update) && !isPermissionPolicyRecordV2(update)
          || update.key.profileId !== this.input.profileId || update.key.identity.pluginId !== selected.id
          || update.key.identity.source !== selected.source
          || isPermissionPolicyRecordV3(update) && (
              update.key.capability !== 'ui.extension-points.render' || update.key.scope.extensionPoints?.length !== 1
              || !['manager.settings.navigation-items', 'manager.content'].includes(
                update.key.scope.extensionPoints[0]!,
              )
            )
          || !attachmentEqual(candidate, mergePersistedPermissionPolicies(expected, updates))
        ) throw new Error('service-permission-consumers-unavailable')
        const readback = await this.input.loadPolicies()
        if (signal.aborted || !current() || !attachmentEqual(readback, candidate)) {
          throw new Error('service-permission-consumers-unavailable')
        }
        if (nativePeers.length > 0) {
          const updateKey = persistedPermissionRecordKey(update)
          const relevant = (records: readonly CordisXPersistedPermissionPolicyRecord[]) =>
            records.filter(record =>
              isPermissionPolicyRecordV2(update)
                ? isPermissionPolicyRecordV2(record) && persistedPermissionRecordKey(record) === updateKey
                : (
                  isPermissionPolicyRecordV3(record) && record.key.profileId === this.input.profileId
                  && record.key.identity.pluginId === selected.id && record.key.identity.source === selected.source
                  && record.key.capability === 'ui.extension-points.render'
                  && record.key.scope.extensionPoints?.length === 1
                  && ['manager.settings.navigation-items', 'manager.content'].includes(
                    record.key.scope.extensionPoints[0]!,
                  )
                )
            )
          const handoffId = randomBytes(32).toString('hex')
          await Promise.all(nativePeers.map(async peer => {
            if (!current() || signal.aborted || peer.closed) throw new Error('service-permission-consumers-unavailable')
            const transition = {
              profileId: this.input.profileId,
              ownerGeneration: this.input.generation,
              rendererId: peer.identity.rendererId,
              handoffId,
              requestId: request.requestId,
              origin: peer.identity.rendererId === origin.rendererId,
              identity: selected,
              moduleGeneration: needsProvenance
                ? generations.get(peer.identity.rendererId)!
                : target!.moduleGeneration!,
              expected: relevant(expected),
              updates: relevant(updates),
              candidate: relevant(candidate),
            }
            const packet = this.input.nativeAdapters!.signPolicy(peer, transition)
            const receipt = await peer.request('permission-policy', packet)
            if (
              signal.aborted || !current() || !attachmentEqual(receipt, {
                rendererId: transition.rendererId,
                ownerGeneration: transition.ownerGeneration,
                handoffId,
                requestId: transition.requestId,
                moduleGeneration: transition.moduleGeneration,
                adopted: true,
              })
            ) throw new Error('service-permission-consumers-unavailable')
          }))
        }
        if (signal.aborted || !current()) throw new Error('service-permission-consumers-unavailable')
        adopted = true
        return {
          profileId: request.profileId,
          ownerGeneration: request.ownerGeneration,
          requestId: request.requestId,
          adopted: true,
          candidate: structuredClone(candidate),
        }
      },
      release: () => {
        if (
          ended || !adopted || !ownerCurrent() || !targetCurrent() || this.reservation !== reservation
          || !consumeReleasedManagerOriginFence(origin, this.input.participants, this.input.lifecycle)
        ) {
          fence()
          return false
        }
        ended = true
        this.reservation = undefined
        return true
      },
      fence,
    }
  }

  close(): void {
    this.closed = true
    this.fenced = true
    this.reservation = undefined
  }
}
