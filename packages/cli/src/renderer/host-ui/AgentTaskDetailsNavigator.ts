import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v2'
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

const EXTERNAL_PROTOCOLS = new Set(['https:', 'codex:', 'claude:'])
const DETAILS_URL_PATTERN = /^(?!.*%(?:0[0-9A-F]|1[0-9A-F]|7F))(?!.*%(?![0-9A-F]{2}))(?![A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@)[^\u0000-\u0020\u007F\\?#]+$/u

/** Runtime mirror of the formal AgentLoop v2 canonical detailsUrl boundary. */
export function validateAgentLoopTaskDetailsUrl(input: AgentLoopTaskDetailsUrl): AgentLoopTaskDetailsUrl {
  if (input === null || typeof input !== 'object') throw new TypeError('Task details URL must be an object')
  const keys = Object.keys(input).sort()
  if (keys.length !== 2 || keys[0] !== 'target' || keys[1] !== 'url') throw new TypeError('Task details URL contains unknown fields')
  if (typeof input.url !== 'string' || input.url.length < 5 || input.url.length > 2_048 || !DETAILS_URL_PATTERN.test(input.url)) {
    throw new TypeError('Task details URL must be a bounded, canonical string')
  }
  if (input.target !== 'host' && input.target !== 'external') throw new TypeError('Task details target is invalid')
  let parsed: URL
  try { parsed = new URL(input.url) } catch { throw new TypeError('Task details URL is invalid') }
  for (const match of input.url.matchAll(/%([0-9A-F]{2})/gu)) {
    const byte = Number.parseInt(match[1]!, 16)
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e) {
      throw new TypeError('Task details URL must not percent-encode an unreserved character')
    }
  }
  if (parsed.username !== '' || parsed.password !== '') throw new TypeError('Task details URL credentials are forbidden')
  if (parsed.href !== input.url) throw new TypeError('Task details URL must be canonical')
  if (input.target === 'host') {
    if (parsed.protocol !== 'app:') throw new TypeError('Host task details must use app:')
  } else {
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) throw new TypeError('External task details protocol is forbidden')
    if (parsed.protocol === 'https:' && parsed.hostname === '') throw new TypeError('External https task details require a host')
    if ((parsed.protocol === 'codex:' || parsed.protocol === 'claude:') && parsed.hostname === '' && parsed.pathname === '') {
      throw new TypeError('External task details URL is empty')
    }
  }
  return Object.freeze({ url: input.url, target: input.target }) as AgentLoopTaskDetailsUrl
}

/** Side-effect boundary shared by Agent identity panels and Host task lists. */
export class HostAgentTaskDetailsNavigator {
  constructor(private readonly port: HostAgentTaskDetailsNavigationPort) {}

  navigate(input: AgentLoopTaskDetailsUrl): void | Promise<void> {
    const location = validateAgentLoopTaskDetailsUrl(input)
    return location.target === 'host'
      ? this.port.navigateHost(location.url)
      : this.port.navigateExternal(location.url)
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
