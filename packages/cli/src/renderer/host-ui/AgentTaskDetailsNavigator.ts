import type { AgentDetailReference } from '@cordisx/protocol/agents/v1'
import { withoutCordisXRouteHistoryEntry } from '../codex-router-history.js'

/** Host-private notification for same-document task URL pushes. */
export const CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT = 'cordisx:host-task-details-navigation'

export interface HostTaskDetailsSameDocumentView {
  readonly history: Pick<History, 'state' | 'pushState'>
  dispatchEvent(event: Event): boolean
}

export interface HostAgentTaskDetailsNavigationPort {
  /** Enters the Host-owned native history without interpreting the provider URL here. */
  navigateHost(url: string): void | Promise<void>
  /** Delegates a validated provider URL to the Host's external-link boundary. */
  navigateExternal(url: string): void | Promise<void>
}

/** Runtime mirror of the formal Host-owned Agent detail reference boundary. */
export function validateAgentLoopTaskDetailsUrl(input: AgentDetailReference): AgentDetailReference {
  if (input === null || typeof input !== 'object') throw new TypeError('Task details URL must be an object')
  const keys = Object.keys(input).sort()
  if (keys.length !== 2 || keys[0] !== 'kind' || keys[1] !== 'ref') throw new TypeError('Agent detail reference contains unknown fields')
  if (input.kind !== 'host' || typeof input.ref !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/u.test(input.ref)) {
    throw new TypeError('Agent detail reference is invalid')
  }
  return Object.freeze({ kind: 'host', ref: input.ref })
}

/** Side-effect boundary shared by Agent identity panels and Host task lists. */
export class HostAgentTaskDetailsNavigator {
  constructor(private readonly port: HostAgentTaskDetailsNavigationPort) {}

  navigate(input: AgentDetailReference): void | Promise<void> {
    const location = validateAgentLoopTaskDetailsUrl(input)
    return this.port.navigateHost(`app://-/playground/simulator/tasks/${encodeURIComponent(location.ref)}`)
  }
}

/** Commits one Host-owned app: task URL and notifies the same native history adapter synchronously. */
export function navigateHostTaskDetailsSameDocument(view: HostTaskDetailsSameDocumentView, value: string): void {
  const target = new URL(value)
  if (target.protocol !== 'app:' || target.hostname !== '-' || target.search !== '' || target.hash !== '') {
    throw new Error('Host task details URL is unavailable')
  }
  view.history.pushState(withoutCordisXRouteHistoryEntry(view.history.state), '', target.pathname)
  const EventConstructor = (view as HostTaskDetailsSameDocumentView & { readonly Event?: typeof Event }).Event ?? Event
  view.dispatchEvent(new EventConstructor(CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT))
}
