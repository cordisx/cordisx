import type { ManagedServiceCliProxyAccountsV1 } from '@cordisx/protocol/managed-service/v1'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type {
  ManagedServiceClientIdentity,
  ManagedServiceClientReservation,
} from '../launcher/managed-service-client-reservation.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import type { ManagerManagedServiceAccountToggle } from './manager-managed-service-account-toggle.js'
import type { ManagerManagedServiceUIGate } from './manager-managed-service-ui-gate.js'
import type { ManagerRendererChannelContext, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

type UIReservation = Awaited<ReturnType<ManagerManagedServiceUIGate['reserve']>>

/** Coordinate the exact account action with all admitted Managers and affected service clients. */
export async function coordinateManagerAccountToggle(input: {
  readonly action: ManagerManagedServiceAccountToggle
  readonly context: ManagerRendererChannelContext
  readonly sessions: ManagerRendererSessions
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ServiceRendererLifecycle
  readonly reserveUI: (current: () => boolean) => Promise<UIReservation>
  readonly reserveClients: (identity: ManagedServiceClientIdentity) => ManagedServiceClientReservation | undefined
}): Promise<unknown> {
  const { action, context } = input
  const unavailable = { requestId: action.requestId, ok: false, code: 'owner-unavailable' }
  let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
  try {
    origin = await fenceManagerOrigin({
      sessions: input.sessions,
      participants: input.participants,
      lifecycle: input.lifecycle,
      allowAdditionalManagers: true,
    })
  } catch {
    return unavailable
  }
  if (origin.rendererId !== context.rendererId || context.signal.aborted || !origin.isCurrent()) {
    if (!origin.release()) origin.fence()
    return unavailable
  }
  let ui: UIReservation
  try {
    ui = await input.reserveUI(() => origin.isCurrent() && !context.signal.aborted)
  } catch {
    if (!origin.release()) origin.fence()
    return unavailable
  }
  let clients: ManagedServiceClientReservation | undefined
  try {
    clients = input.reserveClients(action.identity)
  } catch { /* No action has been dispatched. */ }
  if (!clients?.runBorrowed) {
    if (clients && !clients.release()) clients.fence()
    if (!ui.release() || !origin.release()) origin.fence()
    return unavailable
  }
  const current = () => origin.isCurrent() && ui.isCurrent() && clients!.isCurrent() && !context.signal.aborted
  const fail = () => {
    ui.fence()
    origin.fence()
    clients!.fence()
  }
  const release = () => {
    if (!current() || !ui.release()) {
      fail()
      return false
    }
    if (!origin.release()) {
      clients!.fence()
      return false
    }
    if (!clients!.release()) {
      clients!.fence()
      try {
        input.lifecycle.terminal(new Error('managed-account-reservation-unavailable'))
      } catch { /* Remain fenced. */ }
      return false
    }
    return true
  }
  let prepared = false
  const adopt = async (phase: 'prepare' | 'confirm' | 'cancel', accounts?: ManagedServiceCliProxyAccountsV1) => {
    if (!current() || phase !== 'cancel' && (!accounts || Buffer.byteLength(JSON.stringify(accounts)) > 230 * 1024)) {
      return false
    }
    const peers = input.participants.ownerPeers()
    if (!peers.some(peer => peer.identity.rendererId === origin.rendererId)) return false
    const receipts = await Promise.all(peers.map(async peer => {
      const payload = {
        rendererId: peer.identity.rendererId,
        ownerGeneration: context.ownerGeneration,
        requestId: action.requestId,
        ...action.identity,
        phase,
        binding: action.binding,
        ...(accounts === undefined ? {} : { accounts }),
      }
      const receipt = await peer.request('managed-service-accounts', payload)
      return attachmentEqual(receipt, {
        rendererId: payload.rendererId,
        ownerGeneration: payload.ownerGeneration,
        requestId: payload.requestId,
        ...action.identity,
        phase,
        revision: accounts?.revision ?? null,
        confirmed: true,
      })
    }))
    return receipts.every(Boolean) && current()
  }
  try {
    const outcome = await action.run({
      clients,
      ui,
      isCurrent: current,
      preparePeers: async accounts => {
        prepared = true
        return await adopt('prepare', accounts)
      },
    })
    if (outcome.status !== 'applied') {
      if (prepared && !await adopt('cancel')) throw new Error('managed-account-handoff-unavailable')
      if (!release()) throw new Error('managed-account-handoff-unavailable')
      return outcome.status === 'denied'
        ? { requestId: action.requestId, ok: true, value: outcome.result }
        : unavailable
    }
    if (!prepared || !await adopt('confirm', outcome.accounts) || !release()) {
      throw new Error('managed-account-handoff-unavailable')
    }
    return { requestId: action.requestId, ok: true, value: outcome.result }
  } catch {
    fail()
    throw new Error('managed-account-handoff-unavailable')
  }
}
