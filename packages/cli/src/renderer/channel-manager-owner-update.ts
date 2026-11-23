import { normalizeProjection } from './channel-manager-projection.js'
import { projectionFor, stateFor } from './channel-manager-state.js'
import type { CordisXChannelManagerService } from './channel-manager.js'

/** Adopt the owner's redacted view without exposing a configuration writer to plugins. */
export function adoptStandaloneChannelProjection(
  service: CordisXChannelManagerService,
  value: unknown,
  revision: number,
): boolean {
  try {
    const state = stateFor(service)
    const projection = normalizeProjection(value)
    if (
      state.disposed || !state.isCurrent() || !state.configurationOnly || !state.serviceConfig
      || !Number.isSafeInteger(revision) || revision < state.projection.service.revision
      || projection.service.revision !== revision || projection.service.lastGoodRevision !== revision
      || projection.service.writable !== state.projection.service.writable
      || projection.service.connectionControl !== state.projection.service.connectionControl
      || projection.service.connectionReconnect !== state.projection.service.connectionReconnect
    ) return false
    // An older in-flight snapshot must not overwrite the newly confirmed view.
    state.refreshSequence += 1
    const key = (ref: { adapterId: string; accountId: string; tenantId: string }) =>
      JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
    const previous = new Map(projectionFor(service).accounts.map(account => [key(account.ref), account]))
    state.projection = {
      ...projection,
      accounts: projection.accounts.map(account => {
        const prior = previous.get(key(account.ref))
        return account.accountAvatar === undefined && prior?.accountAvatar && account.accountName !== undefined
            && account.accountName === prior.accountName
          ? { ...account, accountAvatar: prior.accountAvatar }
          : account
      }),
    }
    delete state.runtimeProjection
    state.cachedProjection = undefined
    state.publicController!.invalidate()
    for (const listener of state.listeners) {
      try {
        listener()
      } catch { /* one consumer must not prevent the other views updating */ }
    }
    return true
  } catch {
    return false
  }
}

/** The originating page accepts success only after the owner readback matches its exact action. */
export function adoptStandaloneChannelControl(
  service: CordisXChannelManagerService,
  value: unknown,
  expectedRevision: number,
  ref: unknown,
  action: 'enable' | 'disable' | 'reconnect',
): boolean {
  try {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return false
    const target = ref as { adapterId?: unknown; accountId?: unknown; tenantId?: unknown }
    const projection = normalizeProjection(value)
    const matches = projection.connections.filter(connection =>
      connection.ref.adapterId === target.adapterId && connection.ref.accountId === target.accountId
      && connection.ref.tenantId === target.tenantId
    )
    if (
      !Number.isSafeInteger(expectedRevision)
      || projection.service.revision !== expectedRevision + (action === 'reconnect' ? 0 : 1)
      || projection.service.connectionControl !== 'enable-disable' || matches.length !== 1
      || action === 'reconnect' && projection.service.connectionReconnect !== true
      || matches[0]!.pendingTenant || matches[0]!.enabled !== (action !== 'disable')
    ) return false
    return adoptStandaloneChannelProjection(service, projection, projection.service.revision)
  } catch {
    return false
  }
}
