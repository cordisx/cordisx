import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV3,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import {
  consumeReleasedManagerOriginFence,
  isCurrentManagerOriginFence,
  type ManagerOriginFence,
} from './manager-origin-fence.js'
import type { ServiceRendererPermissionConsumerFence } from './service-renderer-permission-handoff.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/**
 * The service owner has no non-renderer consumer of these Manager UI policies.
 * The origin fence proves that every attached renderer is in the Manager
 * cohort and prevents new attachments. Other policy kinds and owners must
 * provide their own consumer fence.
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
    },
  ) {}

  reserve(
    origin: ManagerOriginFence,
    target?: { readonly identity: { readonly id: string; readonly source: string }; readonly isCurrent: () => boolean },
  ): ServiceRendererPermissionConsumerFence {
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
    ) throw new Error('service-permission-consumers-unavailable')
    const reservation = Symbol('service-permission-consumers')
    this.reservation = reservation
    let ended = false
    let started = false
    let adopted = false
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
      adopt: async (request, signal) => {
        if (started || !current() || signal.aborted) throw new Error('service-permission-consumers-unavailable')
        started = true
        const expected = request.expected.map(record => normalizePersistedPermissionPolicyRecord(record))
        const updates = request.updates.map(record => normalizePersistedPermissionPolicyRecord(record))
        const candidate = request.candidate.map(record => normalizePersistedPermissionPolicyRecord(record))
        const update = updates[0]
        if (
          request.profileId !== this.input.profileId || request.ownerGeneration !== this.input.generation
          || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId) || expected.length > 4096
          || updates.length !== 1 || !update || !isPermissionPolicyRecordV3(update)
          || update.key.profileId !== this.input.profileId || update.key.identity.pluginId !== selected.id
          || update.key.identity.source !== selected.source
          || update.key.capability !== 'ui.extension-points.render'
          || update.key.scope.extensionPoints?.length !== 1
          || !['manager.settings.navigation-items', 'manager.content'].includes(update.key.scope.extensionPoints[0]!)
          || !attachmentEqual(candidate, mergePersistedPermissionPolicies(expected, updates))
        ) throw new Error('service-permission-consumers-unavailable')
        const readback = await this.input.loadPolicies()
        if (signal.aborted || !current() || !attachmentEqual(readback, candidate)) {
          throw new Error('service-permission-consumers-unavailable')
        }
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
