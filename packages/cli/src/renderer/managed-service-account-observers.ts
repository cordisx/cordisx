import type { ManagedServiceBindingV1, ManagedServiceCliProxyAccountsV1 } from '@cordisx/protocol/managed-service/v1'
import { managedServiceUIBindingEqual } from '../launcher/managed-service-ui-binding.js'
import type { ManagedServiceAccountAdoption } from '../managed-service-account-adoption.js'

type Observer = (accounts: ManagedServiceCliProxyAccountsV1) => void | Promise<void>
type Registration = { readonly observer: Observer; settled: Promise<void> }
type Entry = {
  readonly owner: string
  readonly binding: ManagedServiceBindingV1
  readonly observers: Set<Registration>
  pending?: { readonly requestId: string; readonly serviceGeneration: string }
  last?: ManagedServiceCliProxyAccountsV1
}

function deliver(
  registration: Registration,
  accounts: ManagedServiceCliProxyAccountsV1,
  isActive: () => boolean,
): Promise<void> {
  const snapshot = structuredClone(accounts)
  const pending = registration.settled.then(async () => {
    if (isActive()) await registration.observer(snapshot)
  })
  registration.settled = pending.then(() => undefined, () => undefined)
  return pending
}

/** Per-renderer account views; an owner handoff waits for each live observer. */
export class ManagedServiceAccountObservers {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  private key(owner: string, serviceId: string): string {
    return JSON.stringify([owner, serviceId])
  }

  observe(owner: string, serviceId: string, binding: ManagedServiceBindingV1, observer: Observer): () => void {
    if (this.closed || typeof observer !== 'function') throw new Error('managed-account-observer-unavailable')
    const key = this.key(owner, serviceId)
    let entry = this.entries.get(key)
    if (entry && !managedServiceUIBindingEqual(entry.binding, binding)) {
      if (entry.pending || entry.observers.size) throw new Error('managed-account-observer-unavailable')
      this.entries.delete(key)
      entry = undefined
    }
    entry ??= { owner, binding: structuredClone(binding), observers: new Set() }
    this.entries.set(key, entry)
    const registration: Registration = { observer, settled: Promise.resolve() }
    entry.observers.add(registration)
    if (entry.last) {
      void deliver(
        registration,
        entry.last,
        () => !this.closed && this.entries.get(key) === entry && entry.observers.has(registration),
      ).catch(() => undefined)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      entry!.observers.delete(registration)
    }
  }

  async adopt(owner: string, value: ManagedServiceAccountAdoption, current: () => boolean): Promise<boolean> {
    if (this.closed || !current()) return false
    const key = this.key(owner, value.serviceId)
    let entry = this.entries.get(key)
    if (entry && !managedServiceUIBindingEqual(entry.binding, value.binding)) return false
    entry ??= { owner, binding: structuredClone(value.binding), observers: new Set() }
    this.entries.set(key, entry)
    if (value.phase === 'cancel') {
      if (!entry.pending) return current()
      if (entry.pending.requestId !== value.requestId) return false
      delete entry.pending
      return current()
    }
    if (!value.accounts) return false
    if (value.phase === 'prepare') {
      if (entry.pending) return false
      entry.pending = { requestId: value.requestId, serviceGeneration: value.accounts.serviceGeneration }
    } else if (
      entry.pending?.requestId !== value.requestId
      || entry.pending.serviceGeneration !== value.accounts.serviceGeneration
    ) return false
    const notified = new Set<Registration>()
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (this.closed || this.entries.get(key) !== entry || !current()) return false
        const next = [...entry.observers].filter(observer => !notified.has(observer))
        if (!next.length) {
          entry.last = structuredClone(value.accounts)
          if (value.phase === 'confirm') delete entry.pending
          return true
        }
        await Promise.all(next.map(async registration => {
          await deliver(
            registration,
            value.accounts!,
            () => !this.closed && this.entries.get(key) === entry && current() && entry.observers.has(registration),
          )
          notified.add(registration)
        }))
      }
    } catch { /* The owner must not report an unconfirmed handoff as successful. */ }
    return false
  }

  releaseOwner(owner: string): void {
    for (const [key, entry] of this.entries) if (entry.owner === owner) this.entries.delete(key)
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }
}
