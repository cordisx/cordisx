/** Owner-private identity for clients affected by a managed-service logout. */
export interface ManagedServiceClientIdentity {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
}

export interface ManagedServiceClientReservation {
  isCurrent(): boolean
  release(): boolean
  fence(): void
}

/** Bind a reservation to the active plugin generation, not a staged fleet. */
export function reserveActiveManagedServiceClients(
  active: {
    readonly record?: {
      readonly plugins: readonly { readonly id: string; readonly enabled: boolean; readonly moduleGeneration: string }[]
    }
    readonly activation: {
      reserveServiceClients?(identity: ManagedServiceClientIdentity): ManagedServiceClientReservation | undefined
    } | undefined
  } | undefined,
  identity: ManagedServiceClientIdentity,
  isActive: () => boolean,
): ManagedServiceClientReservation | undefined {
  const plugin = active?.record?.plugins.find(item => item.id === identity.pluginId)
  if (!isActive() || !plugin?.enabled || plugin.moduleGeneration !== identity.pluginGeneration) return undefined
  const reservation = active?.activation?.reserveServiceClients?.(identity)
  if (!reservation) return undefined
  const current = () => isActive() && reservation.isCurrent()
  return {
    isCurrent: current,
    release: () => current() && reservation.release(),
    fence: () => reservation.fence(),
  }
}

/** Acquire synchronous reservations as one unit; never leave a partial reservation live. */
export function reserveManagedServiceClients(
  identity: ManagedServiceClientIdentity,
  sources: readonly ((identity: ManagedServiceClientIdentity) => ManagedServiceClientReservation | undefined)[],
): ManagedServiceClientReservation | undefined {
  if (sources.length === 0) return undefined
  const reservations: ManagedServiceClientReservation[] = []
  const abandon = () => {
    for (const reservation of reservations.reverse()) {
      try {
        if (!reservation.release()) reservation.fence()
      } catch {
        reservation.fence()
      }
    }
  }
  try {
    for (const source of sources) {
      const reservation = source(identity)
      if (!reservation) {
        abandon()
        return undefined
      }
      reservations.push(reservation)
    }
  } catch {
    abandon()
    return undefined
  }
  let ended = false
  const current = () => !ended && reservations.every(reservation => reservation.isCurrent())
  return {
    isCurrent: current,
    release() {
      if (!current()) return false
      let released = true
      for (const reservation of reservations) {
        try {
          if (!reservation.release()) released = false
        } catch {
          released = false
        }
      }
      if (!released) { for (const reservation of reservations) reservation.fence() }
      ended = true
      return released
    },
    fence() {
      if (ended) return
      ended = true
      for (const reservation of reservations) reservation.fence()
    },
  }
}
