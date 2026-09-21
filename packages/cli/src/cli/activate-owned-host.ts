import { hasMatchingProcessIdentity } from './supervisor-state.js'
import type { ReadyLaunchResult } from './supervisor-command.js'
import { nativeOperation } from '../shortcuts/native.js'

export interface ActivatedOwnedHost {
  readonly ok: true
  readonly hostPid: number
  readonly hostStartedAt: string
  readonly warning?: string
}

/** Activate only the Host PID whose start identity is still owned by this ready supervisor. */
export async function activateOwnedHost(ready: ReadyLaunchResult): Promise<ActivatedOwnedHost> {
  const state = ready.state
  if (
    !state.hostPid || !state.hostProcessStartedAt
    || !await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
  ) {
    return {
      ok: true,
      hostPid: state.hostPid ?? 0,
      hostStartedAt: state.hostProcessStartedAt ?? '',
      warning: '应用已运行，未能确认对应窗口，未切到前台。',
    }
  }
  const activated = await nativeOperation<{ activated: boolean }>({
    operation: 'activate',
    pid: state.hostPid,
    startedAt: state.hostProcessStartedAt,
  }).catch(() => ({ activated: false }))
  return activated.activated
    ? { ok: true, hostPid: state.hostPid, hostStartedAt: state.hostProcessStartedAt }
    : {
      ok: true,
      hostPid: state.hostPid,
      hostStartedAt: state.hostProcessStartedAt,
      warning: '应用已运行，未能切到前台。',
    }
}
