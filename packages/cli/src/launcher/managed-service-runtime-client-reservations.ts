import {
  ManagedServiceClientBorrowAuthority,
  ManagedServiceClientBorrowScope,
} from './managed-service-client-borrow.js'
import type {
  ManagedServiceClientIdentity,
  ManagedServiceClientReservation,
} from './managed-service-client-reservation.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedBindingCurrent, managedIdentityKey } from './managed-service-runtime-support.js'

/** Keep client admission closed around one owner-scoped service mutation. */
export class ManagedServiceRuntimeClientReservations {
  private readonly reservations = new Map<string, symbol>()
  private readonly fenced = new Set<string>()
  readonly borrowAuthority = new ManagedServiceClientBorrowAuthority()

  constructor(
    private readonly records: ReadonlyMap<string, ManagedServiceRecord>,
    private readonly hasNativeConnection: (record: ManagedServiceRecord) => boolean,
  ) {}

  private key(record: ManagedServiceRecord): string {
    return record.access.owner.pluginId + '\u0000' + record.definition.serviceId
  }

  blocked(record: ManagedServiceRecord): boolean {
    const key = this.key(record)
    return this.reservations.has(key) || this.fenced.has(key)
  }

  reserve(identity: ManagedServiceClientIdentity): ManagedServiceClientReservation | undefined {
    const matches = [...this.records.values()].filter(record =>
      !record.disposed && record.access.owner.pluginId === identity.pluginId
      && record.access.owner.pluginGeneration === identity.pluginGeneration
      && record.definition.serviceId === identity.serviceId
    )
    if (matches.length !== 1) return undefined
    const record = matches[0]!
    const key = this.key(record)
    const hasDependentMaterialization = [...this.records.values()].some(candidate =>
      candidate !== record && !candidate.disposed
      && [...candidate.materializations.values()].some(materialization =>
        materialization.sources.some(source => managedBindingCurrent(source.binding, record.binding, record.disposed))
      )
    )
    if (
      this.blocked(record) || record.leases.size > 0 || hasDependentMaterialization
      || this.hasNativeConnection(record)
    ) return undefined
    const token = Symbol('managed-service-client-reservation')
    this.reservations.set(key, token)
    let ended = false
    let running: ManagedServiceClientBorrowScope | undefined
    const current = () =>
      !ended && !record.disposed && this.records.get(managedIdentityKey(record.binding.identity)) === record
      && this.reservations.get(key) === token && !this.fenced.has(key)
    const fence = () => {
      if (ended) return
      ended = true
      running?.close()
      if (this.reservations.get(key) === token) {
        this.reservations.delete(key)
        this.fenced.add(key)
      }
    }
    return {
      isCurrent: current,
      release: () => {
        if (running) {
          fence()
          return false
        }
        if (!current()) return false
        ended = true
        this.reservations.delete(key)
        return true
      },
      fence,
      runBorrowed: async (policy, action) => {
        if (!current() || running || this.borrowAuthority.current() !== undefined) {
          throw new Error('managed-service-borrow-unavailable')
        }
        const scope = new ManagedServiceClientBorrowScope(record, current, policy)
        running = scope
        let value: Awaited<ReturnType<typeof action>>
        try {
          value = await this.borrowAuthority.run(scope, action)
        } catch {
          scope.close()
          running = undefined
          fence()
          throw new Error('managed-service-borrow-uncertain')
        }
        const clean = scope.close()
        running = undefined
        if (!clean || !current()) {
          fence()
          throw new Error('managed-service-borrow-uncertain')
        }
        return value
      },
    }
  }
}
