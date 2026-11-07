/** Registered only by the Host-owned Manager page mount. DOM attributes do not grant a seat. */
const seats = new WeakMap<Element, { readonly owner: string; readonly signal: AbortSignal }>()

export function registerManagedConsoleSeat(body: Element, owner: string, signal: AbortSignal): void {
  seats.set(body, { owner, signal })
}

export function activeManagedConsoleSeat(target: Element, owner: string): boolean {
  if (!target.isConnected || target.ownerDocument !== document) return false
  for (let node: Element | null = target; node; node = node.parentElement) {
    const seat = seats.get(node)
    if (seat) return seat.owner === owner && !seat.signal.aborted
  }
  return false
}
