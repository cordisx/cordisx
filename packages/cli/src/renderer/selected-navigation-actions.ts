import type { CordisXJsonScalar, CordisXRouteReference } from '../contracts.js'
import type { HostNavigationCollectionAction } from './host-ui/NavigationCollectionActions.js'

export interface HostSelectedNavigationActionCandidate {
  readonly owner: string
  readonly itemId: string
  readonly route: CordisXRouteReference
  readonly actions: readonly HostNavigationCollectionAction[]
}

function paramsKey(params: Readonly<Record<string, CordisXJsonScalar>> | undefined): string {
  return JSON.stringify(Object.entries(params ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

function sameRoute(left: CordisXRouteReference, right: CordisXRouteReference): boolean {
  return left.id === right.id && paramsKey(left.params) === paramsKey(right.params)
}

/**
 * Host-internal bridge from the structured navigation renderer to the active
 * Agent Conversation Shell. Action objects are retained by identity so both
 * surfaces use the same executor, confirmation, feedback, and state.
 */
export class SelectedNavigationActionRegistry {
  private candidates: readonly HostSelectedNavigationActionCandidate[] = []
  private readonly listeners = new Set<() => void>()
  private disposed = false

  replace(candidates: readonly HostSelectedNavigationActionCandidate[]): void {
    if (this.disposed) return
    this.candidates = Object.freeze([...candidates])
    for (const listener of this.listeners) listener()
  }

  selected(
    owner: string,
    route: CordisXRouteReference,
  ): HostSelectedNavigationActionCandidate | undefined {
    if (this.disposed) return undefined
    const matches = this.candidates.filter(candidate => candidate.owner === owner && sameRoute(candidate.route, route))
    return matches.length === 1 ? matches[0] : undefined
  }

  isSelected(owner: string, itemId: string, route: CordisXRouteReference): boolean {
    return this.selected(owner, route)?.itemId === itemId
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.candidates = []
    this.listeners.clear()
  }
}
