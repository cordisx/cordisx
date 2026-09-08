import type { CordisXRouteReference } from '../../contracts.js'
import type { ManagerSettingsNavigationItemSnapshot } from '../manager.js'
import type { ManagerContentAgentDefinitionTarget } from '../navigation.js'
import type { ManagerRoute } from './model/routes.js'

export interface HostManagerContentOpenRequest {
  readonly contributionId: string
  readonly root: CordisXRouteReference
  readonly target: CordisXRouteReference
}

function sameRouteReference(left: CordisXRouteReference, right: CordisXRouteReference): boolean {
  if (left.id !== right.id) return false
  const leftParams = left.params ?? {}
  const rightParams = right.params ?? {}
  const keys = Object.keys(leftParams).sort()
  if (keys.length !== Object.keys(rightParams).length) return false
  return keys.every(key => leftParams[key] === rightParams[key])
}

/** Resolve the one visible Manager navigation root that owns an exact subject. */
export function resolveHostManagerAgentDefinitionOpenRequest(
  target: ManagerContentAgentDefinitionTarget | undefined,
  items: readonly ManagerSettingsNavigationItemSnapshot[],
): HostManagerContentOpenRequest | undefined {
  if (target?.parent === undefined) return undefined
  const parent = target.parent
  const candidates = items.filter(item =>
    item.owner === target.owner
    && !item.disabled
    && sameRouteReference(item.route, parent)
  )
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  if (candidate === undefined) return undefined
  return Object.freeze({
    contributionId: candidate.id,
    root: structuredClone(parent),
    target: structuredClone(target.route),
  })
}

/** Host-private bridge into the single Manager modal and its internal history. */
export class HostManagerNavigationController {
  private listener: ((request: HostManagerContentOpenRequest) => void) | undefined
  private returnPort:
    | Readonly<
      { readonly capture: () => readonly ManagerRoute[]; readonly restore: (routes: readonly ManagerRoute[]) => void }
    >
    | undefined
  private pendingReturn: readonly ManagerRoute[] | undefined

  bind(listener: (request: HostManagerContentOpenRequest) => void): () => void {
    if (this.listener !== undefined) throw new Error('CordisX Manager navigation controller is already bound')
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  openManagerContent(request: HostManagerContentOpenRequest): void {
    if (this.listener === undefined) throw new Error('CordisX Manager is unavailable')
    this.listener(structuredClone(request))
  }

  /** Binds Host-private current-route capture/restore across Manager remounts. */
  bindReturnPort(
    port: Readonly<{
      readonly capture: () => readonly ManagerRoute[]
      readonly restore: (routes: readonly ManagerRoute[]) => void
    }>,
  ): () => void {
    if (this.returnPort !== undefined) throw new Error('CordisX Manager return capture is already bound')
    this.returnPort = port
    this.restorePendingReturn()
    return () => {
      if (this.returnPort === port) this.returnPort = undefined
    }
  }

  captureReturn(): (() => void) | undefined {
    const captured = this.returnPort?.capture()
    if (captured === undefined || captured.length === 0) return undefined
    this.pendingReturn = structuredClone(captured)
    return () => this.restorePendingReturn()
  }

  private restorePendingReturn(): void {
    const pending = this.pendingReturn
    const port = this.returnPort
    if (pending === undefined || port === undefined) return
    this.pendingReturn = undefined
    port.restore(structuredClone(pending))
  }
}

/** Resolve a public plugin route to one visible, same-owner Manager navigation root. */
export function resolveHostManagerRouteOpenRequest(
  owner: string,
  target: CordisXRouteReference,
  items: readonly ManagerSettingsNavigationItemSnapshot[],
  parent: (reference: CordisXRouteReference) => CordisXRouteReference | undefined,
  tabs: (root: CordisXRouteReference) => readonly CordisXRouteReference[] = () => [],
): HostManagerContentOpenRequest | undefined {
  let current: CordisXRouteReference | undefined = target
  const seen = new Set<string>()
  while (current && seen.size < 32) {
    const key = JSON.stringify(current)
    if (seen.has(key)) return undefined
    seen.add(key)
    const matches = items.filter(item =>
      item.owner === owner && !item.disabled
      && (sameRouteReference(item.route, current!) || tabs(item.route).some(tab => sameRouteReference(tab, current!)))
    )
    if (matches.length === 1) return { contributionId: matches[0]!.id, root: matches[0]!.route, target }
    if (matches.length > 1) return undefined
    current = parent(current)
  }
  return undefined
}
