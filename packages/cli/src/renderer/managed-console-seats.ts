/** Registered only by the Host-owned Manager page mount. DOM attributes do not grant a seat. */
interface ManagedConsoleSeat {
  readonly body: Element
  readonly owner: string
  readonly signal: AbortSignal
}

const seats = new WeakMap<Element, ManagedConsoleSeat>()
let activePage: ManagedConsoleSeat | undefined

export function registerManagedConsoleSeat(body: Element, owner: string, signal: AbortSignal): void {
  const seat = { body, owner, signal }
  seats.set(body, seat)
  activePage = seat
  signal.addEventListener('abort', () => {
    if (activePage === seat) activePage = undefined
  }, { once: true })
}

export function activeManagedConsolePage(owner: string): ManagedConsoleSeat | undefined {
  const seat = activePage
  return seat?.owner === owner && !seat.signal.aborted && seat.body.isConnected
      && seat.body.ownerDocument === document
    ? seat
    : undefined
}

export function activeManagedConsoleSeat(target: Element, owner: string): boolean {
  if (!target.isConnected || target.ownerDocument !== document) return false
  for (let node: Element | null = target; node; node = node.parentElement) {
    const seat = seats.get(node)
    if (seat) return seat.owner === owner && !seat.signal.aborted
  }
  return false
}
