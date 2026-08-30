import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v2'

/** Host-private notification for same-document task URL pushes. */
export const CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT = 'cordisx:host-task-details-navigation'

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
  if (parsed.username !== '' || parsed.password !== '') throw new TypeError('Task details URL credentials are forbidden')
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
