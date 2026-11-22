import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagedServiceSafeValueV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceClientBorrowPolicy } from './managed-service-client-reservation.js'
import type { ManagedServiceClientState, ManagedServiceRecord } from './managed-service-runtime-record.js'

const operationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_OPERATIONS = 32
const MAX_LEASES = 8

/** A single owner action; neither its context nor its leases survive the action. */
export class ManagedServiceClientBorrowScope {
  readonly operations: readonly string[]
  readonly signal: AbortSignal
  private readonly allows: ManagedServiceClientBorrowPolicy['allows']
  private readonly policyCurrent: () => boolean
  private readonly controller = new AbortController()
  private readonly leases = new Map<string, () => void>()
  private readonly limits = new Map<string, number>()
  private readonly counts = new Map<string, number>()
  private active = true
  private failed = false
  private inFlight = 0
  private issued = 0
  private invoked = 0

  constructor(
    private readonly record: ManagedServiceRecord,
    private readonly currentReservation: () => boolean,
    policy: ManagedServiceClientBorrowPolicy,
  ) {
    if (!policy) throw new Error('managed-service-borrow-unavailable')
    const operations = policy.operations
    const allows = policy.allows
    const limits = policy.limits
    const policyCurrent = policy.isCurrent
    if (
      !Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS
      || typeof allows !== 'function'
      || operations.some(value => typeof value !== 'string' || !operationId.test(value))
      || new Set(operations).size !== operations.length
      || limits !== undefined && (limits === null || typeof limits !== 'object' || Array.isArray(limits))
      || policyCurrent !== undefined && typeof policyCurrent !== 'function'
    ) throw new Error('managed-service-borrow-unavailable')
    const suppliedLimits = Object.entries(limits ?? {})
    if (
      suppliedLimits.some(([key, value]) =>
        !operations.includes(key) || !Number.isSafeInteger(value) || value < 1 || value > MAX_OPERATIONS
      )
    ) throw new Error('managed-service-borrow-unavailable')
    this.operations = Object.freeze([...operations])
    this.allows = allows
    this.policyCurrent = policyCurrent ?? (() => true)
    for (const [operation, limit] of suppliedLimits) this.limits.set(operation, limit)
    for (const operation of this.operations) {
      if (!this.limits.has(operation)) this.limits.set(operation, 1)
    }
    this.signal = this.controller.signal
  }

  current(): boolean {
    try {
      return this.active && !this.failed && !this.signal.aborted && !this.record.disposed
        && this.currentReservation() && this.policyCurrent()
    } catch {
      return false
    }
  }

  permits(record: ManagedServiceRecord, client: ManagedServiceClientState): boolean {
    return this.current() && record === this.record && client.active
      && client.pluginId === record.access.owner.pluginId
      && client.pluginGeneration === record.access.owner.pluginGeneration
  }

  reject(): void {
    this.failed = true
    this.controller.abort()
  }

  addLease(handle: string, release: () => void): boolean {
    if (!this.current() || this.issued >= MAX_LEASES || this.leases.has(handle)) {
      this.reject()
      return false
    }
    this.issued++
    this.leases.set(handle, release)
    return true
  }

  removeLease(handle: string): void {
    this.leases.delete(handle)
  }

  beginInvocation(operation: string, value: ManagedServiceSafeValueV1 | undefined): (() => void) | undefined {
    let allowed = false
    try {
      allowed = this.current() && this.invoked < MAX_OPERATIONS && this.operations.includes(operation)
        && (this.counts.get(operation) ?? 0) < (this.limits.get(operation) ?? 0)
        && this.allows(operation, structuredClone(value)) === true
    } catch { /* A policy failure is not an authorization. */ }
    if (!allowed) {
      this.reject()
      return undefined
    }
    this.counts.set(operation, (this.counts.get(operation) ?? 0) + 1)
    this.invoked++
    this.inFlight++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.inFlight--
    }
  }

  /** A leaked lease or unfinished invocation makes the action's outcome uncertain. */
  close(): boolean {
    if (!this.active) return false
    const clean = this.current() && this.inFlight === 0 && this.leases.size === 0
    this.active = false
    this.controller.abort()
    for (const release of [...this.leases.values()]) {
      try {
        release()
      } catch { /* The reservation is fenced by the caller. */ }
    }
    this.leases.clear()
    return clean
  }
}

/** Context is owner-local and cannot be supplied through the plugin protocol. */
export class ManagedServiceClientBorrowAuthority {
  private readonly context = new AsyncLocalStorage<ManagedServiceClientBorrowScope>()

  current(): ManagedServiceClientBorrowScope | undefined {
    return this.context.getStore()
  }

  async run<T>(scope: ManagedServiceClientBorrowScope, action: () => Promise<T>): Promise<T> {
    return await this.context.run(scope, action)
  }
}
