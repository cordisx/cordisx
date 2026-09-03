import type { CordisXRouteReference } from '../../contracts.js'
import type { ManagerSettingsNavigationItemSnapshot } from '../manager.js'
import type { ManagerContentAgentDefinitionTarget } from '../navigation.js'

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
  const candidates = items.filter(item => item.owner === target.owner
    && !item.disabled
    && sameRouteReference(item.route, target.parent))
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  if (candidate === undefined) return undefined
  return Object.freeze({
    contributionId: candidate.id,
    root: structuredClone(target.parent),
    target: structuredClone(target.route),
  })
}

/** Host-private bridge into the single Manager modal and its internal history. */
export class HostManagerNavigationController {
  private listener: ((request: HostManagerContentOpenRequest) => void) | undefined

  bind(listener: (request: HostManagerContentOpenRequest) => void): () => void {
    if (this.listener !== undefined) throw new Error('CordisX Manager navigation controller is already bound')
    this.listener = listener
    return () => { if (this.listener === listener) this.listener = undefined }
  }

  openManagerContent(request: HostManagerContentOpenRequest): void {
    if (this.listener === undefined) throw new Error('CordisX Manager is unavailable')
    this.listener(structuredClone(request))
  }
}
