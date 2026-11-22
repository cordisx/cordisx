import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'

/** Coordinate managed-service actions only when the owner can reserve their complete Manager cohort. */
export function coordinateManagerManagedServiceMutations(input: {
  readonly channel: ManagerRendererChannel
  readonly sessions: () => ManagerRendererSessions
  readonly participants?: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      const prepared = input.channel.prepare(payload, context)
      if (prepared.mode !== 'write') return prepared
      if (typeof payload !== 'string') throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const value = JSON.parse(payload) as { requestId?: unknown }
      if (!value || typeof value.requestId !== 'string') throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const requestId = value.requestId
      if (!input.participants || !input.lifecycle) {
        return {
          mode: 'read',
          async dispatch() {
            return { requestId, ok: false, code: 'unsupported' }
          },
        }
      }
      const participants = input.participants
      const lifecycle = input.lifecycle
      const authentication = prepared.managedServiceAuthentication
      if (
        !authentication || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(authentication.pluginId)
        || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(authentication.serviceId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(authentication.pluginGeneration)
        || !Number.isSafeInteger(authentication.expectedSequence) || authentication.expectedSequence < 0
      ) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const identity = {
        pluginId: authentication.pluginId,
        pluginGeneration: authentication.pluginGeneration,
        serviceId: authentication.serviceId,
      }
      return {
        mode: 'write',
        async dispatch() {
          let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
          try {
            origin = await fenceManagerOrigin({
              sessions: input.sessions(),
              participants,
              lifecycle,
              allowAdditionalManagers: true,
            })
          } catch {
            // No action was dispatched when the cohort could not be reserved.
            return { requestId, ok: false, code: 'owner-unavailable' }
          }
          try {
            if (origin.rendererId !== context.rendererId || !origin.isCurrent() || context.signal.aborted) {
              throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            }
            const peers = participants.ownerPeers().filter(peer => peer.identity.rendererId !== origin.rendererId)
            const confirm = async (phase: 'prepare' | 'confirm', sequence: number): Promise<boolean> => {
              const results = await Promise.all(peers.map(async peer => {
                const request = {
                  rendererId: peer.identity.rendererId,
                  ownerGeneration: context.ownerGeneration,
                  ...identity,
                  sequence,
                  phase,
                }
                const receipt = await peer.request('managed-service-state', request)
                return attachmentEqual(receipt, { ...request, confirmed: true })
              }))
              return results.every(Boolean) && origin.isCurrent()
            }
            if (!await confirm('prepare', authentication.expectedSequence)) {
              if (!origin.release()) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
              return { requestId, ok: false, code: 'owner-unavailable' }
            }
            const result = await prepared.dispatch()
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            }
            const response = result as { requestId?: unknown; ok?: unknown; value?: unknown }
            if (
              response.requestId !== requestId || response.ok !== true || !response.value
              || typeof response.value !== 'object' || Array.isArray(response.value)
            ) {
              throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            }
            const outcome = response.value as { status?: unknown; sequence?: unknown }
            if (outcome.status === 'accepted') {
              if (
                !Number.isSafeInteger(outcome.sequence) || (outcome.sequence as number) < 0
                || !await confirm('confirm', outcome.sequence as number)
              ) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            } else if (outcome.status !== 'denied') {
              throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            }
            if (!origin.isCurrent() || !origin.release()) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            return result
          } catch {
            origin.fence()
            throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
          }
        },
      }
    },
  }
}
