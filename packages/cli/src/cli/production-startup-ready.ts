import { abortable } from '../launcher/cdp-session.js'
import type { ManagedServiceStartupSession } from '../launcher/managed-service-startup-lifecycle.js'

/** Publish workspace readiness after core/legacy adoption, independently of caller requirements. */
export function productionStartupReady(
  session: Pick<ManagedServiceStartupSession, 'coreReady'>,
  applied: () => Promise<void>,
  publish: (signal?: AbortSignal) => Promise<void>,
): (signal?: AbortSignal) => Promise<void> {
  return async signal => {
    await abortable(session.coreReady, signal)
    signal?.throwIfAborted()
    await applied()
    signal?.throwIfAborted()
    await publish(signal)
  }
}
