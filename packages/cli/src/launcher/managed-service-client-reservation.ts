import type { ManagedServiceSafeValueV1 } from '@cordisx/protocol/managed-service-runtime/v1'

/** Owner-private identity for clients affected by a managed-service mutation. */
export interface ManagedServiceClientIdentity {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
}

/** A bounded owner action may use only these operations and exact request values. */
export interface ManagedServiceClientBorrowPolicy {
  readonly operations: readonly string[]
  /** An omitted limit permits one invocation of that operation. */
  readonly limits?: Readonly<Record<string, number>>
  readonly allows: (operation: string, value: ManagedServiceSafeValueV1 | undefined) => boolean
  /** Outer owner and client reservations must remain current through every call. */
  readonly isCurrent?: () => boolean
}

export interface ManagedServiceClientReservation {
  isCurrent(): boolean
  release(): boolean
  fence(): void
  runBorrowed?<T>(policy: ManagedServiceClientBorrowPolicy, action: () => Promise<T>): Promise<T>
}

function guardedBorrowPolicy(
  policy: ManagedServiceClientBorrowPolicy,
  current: () => boolean,
): ManagedServiceClientBorrowPolicy {
  const previous = policy.isCurrent
  return {
    operations: policy.operations,
    ...(policy.limits === undefined ? {} : { limits: policy.limits }),
    allows: policy.allows,
    isCurrent: () => current() && (previous?.() ?? true),
  }
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
    ...(reservation.runBorrowed === undefined ? {} : {
      async runBorrowed<T>(policy: ManagedServiceClientBorrowPolicy, action: () => Promise<T>): Promise<T> {
        try {
          if (!current()) throw new Error('managed-service-borrow-unavailable')
          const result = await reservation.runBorrowed!(guardedBorrowPolicy(policy, current), async () => {
            if (!current()) throw new Error('managed-service-borrow-unavailable')
            const value = await action()
            if (!current()) throw new Error('managed-service-borrow-unavailable')
            return value
          })
          if (!current()) throw new Error('managed-service-borrow-unavailable')
          return result
        } catch (error) {
          reservation.fence()
          throw error
        }
      },
    }),
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
        if (reservation.release()) continue
      } catch { /* A failed release must still be fenced. */ }
      try {
        reservation.fence()
      } catch { /* Continue fencing the remaining sources. */ }
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
  const borrowers = reservations.filter(reservation => reservation.runBorrowed !== undefined)
  if (borrowers.length > 1) {
    abandon()
    return undefined
  }
  let ended = false
  const current = () => !ended && reservations.every(reservation => reservation.isCurrent())
  const fence = () => {
    if (ended) return
    ended = true
    for (const reservation of reservations) {
      try {
        reservation.fence()
      } catch { /* Continue fencing the remaining sources. */ }
    }
  }
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
      if (!released) {
        fence()
        return false
      }
      ended = true
      return true
    },
    fence,
    ...(borrowers.length === 0 ? {} : {
      async runBorrowed<T>(policy: ManagedServiceClientBorrowPolicy, action: () => Promise<T>): Promise<T> {
        try {
          if (!current()) throw new Error('managed-service-borrow-unavailable')
          const value = await borrowers[0]!.runBorrowed!(guardedBorrowPolicy(policy, current), async () => {
            if (!current()) throw new Error('managed-service-borrow-unavailable')
            const result = await action()
            if (!current()) throw new Error('managed-service-borrow-unavailable')
            return result
          })
          if (!current()) throw new Error('managed-service-borrow-unavailable')
          return value
        } catch (error) {
          fence()
          throw error
        }
      },
    }),
  }
}
