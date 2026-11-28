import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import { coordinateManagerAccountToggle } from './manager-managed-service-account-coordinator.js'
import type { ManagerManagedServiceUIGate } from './manager-managed-service-ui-gate.js'
import type {
  ManagedServiceClientIdentity,
  ManagedServiceClientReservation,
} from '../launcher/managed-service-client-reservation.js'

/** Coordinate managed-service actions only when the owner can reserve their complete Manager cohort. */
export function coordinateManagerManagedServiceMutations(input: {
  readonly channel: ManagerRendererChannel
  readonly sessions: () => ManagerRendererSessions
  readonly participants?: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
  readonly reserveServiceClients?: (
    identity: ManagedServiceClientIdentity,
  ) => ManagedServiceClientReservation | undefined
  readonly reserveAccountUI?: (
    current: () => boolean,
  ) => Promise<Awaited<ReturnType<ManagerManagedServiceUIGate['reserve']>>>
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
      if (prepared.managedServiceAccountToggle) {
        const action = prepared.managedServiceAccountToggle
        const reserveUI = input.reserveAccountUI
        const reserveClients = input.reserveServiceClients
        if (action.requestId !== requestId) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
        if (!reserveUI || !reserveClients) {
          return {
            mode: 'read',
            async dispatch() {
              return { requestId, ok: false, code: 'unsupported' }
            },
          }
        }
        return {
          mode: 'write',
          async dispatch() {
            return await coordinateManagerAccountToggle({
              action,
              context,
              sessions: input.sessions(),
              participants,
              lifecycle,
              reserveUI,
              reserveClients,
            })
          },
        }
      }
      const authentication = prepared.managedServiceAuthentication
      if (
        !authentication || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(authentication.pluginId)
        || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(authentication.serviceId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(authentication.pluginGeneration)
        || !Number.isSafeInteger(authentication.expectedSequence) || authentication.expectedSequence < 0
        || !['login', 'logout'].includes(authentication.action)
      ) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const identity = {
        pluginId: authentication.pluginId,
        pluginGeneration: authentication.pluginGeneration,
        serviceId: authentication.serviceId,
        action: authentication.action,
      }
      return {
        mode: 'write',
        async dispatch() {
          const clients = authentication.action === 'logout'
            ? input.reserveServiceClients?.({
              pluginId: identity.pluginId,
              pluginGeneration: identity.pluginGeneration,
              serviceId: identity.serviceId,
            })
            : undefined
          if (authentication.action === 'logout' && !clients) {
            return { requestId, ok: false, code: 'owner-unavailable' }
          }
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
            if (clients && !clients.release()) clients.fence()
            return { requestId, ok: false, code: 'owner-unavailable' }
          }
          const current = () => origin.isCurrent() && (clients?.isCurrent() ?? true)
          const release = () => {
            if (!current() || !origin.release()) return false
            if (!clients || clients.release()) return true
            clients.fence()
            lifecycle.terminal(new Error('terminal-service-reservation-unavailable'))
            return false
          }
          try {
            if (origin.rendererId !== context.rendererId || !current() || context.signal.aborted) {
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
              return results.every(Boolean) && current()
            }
            if (!await confirm('prepare', authentication.expectedSequence)) {
              if (!release()) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
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
            if (!release()) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            return result
          } catch {
            origin.fence()
            clients?.fence()
            throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
          }
        },
      }
    },
  }
}
