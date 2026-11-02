/** A generation keeps endpoint ownership while either pending or active. */
export class ManagedServiceEndpointReservations {
  private readonly held = new Map<string, object>()
  private readonly owners = new Map<object, Set<string>>()

  reserve(owner: object, key: string): void {
    const current = this.held.get(key)
    if (current !== undefined && current !== owner) {
      throw new Error('managed service endpoint is reserved by another generation')
    }
    this.held.set(key, owner)
    const keys = this.owners.get(owner) ?? new Set<string>()
    keys.add(key)
    this.owners.set(owner, keys)
  }

  release(owner: object): void {
    for (const key of this.owners.get(owner) ?? []) if (this.held.get(key) === owner) this.held.delete(key)
    this.owners.delete(owner)
  }
}
