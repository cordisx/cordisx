import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'

/** Check the owner snapshot and close a stale renderer peer. */
export async function serviceRendererBootstrapStatus(input: {
  readonly entry: ServiceRendererBootstrapEntry | undefined
  readonly current: (entry: ServiceRendererBootstrapEntry) => boolean
  readonly configurationCurrent: (entry: ServiceRendererBootstrapEntry) => Promise<boolean>
  readonly checkManagedServiceUI: () => void
}): Promise<{ readonly status: 'ok'; readonly current: boolean }> {
  const { entry } = input
  if (entry?.lifecycleTransition) {
    const current = input.current(entry) && entry.lifecycleTransition.isCurrent()
    if (!current) entry.peer.close()
    return { status: 'ok', current }
  }
  if (entry?.channelTransition) {
    const current = input.current(entry) && entry.channelTransition.isCurrent()
    if (!current) entry.peer.close()
    return { status: 'ok', current }
  }
  if (entry?.config && !await input.configurationCurrent(entry)) {
    entry.stale = true
    entry.peer.close()
    return { status: 'ok', current: false }
  }
  if (entry?.managedContext) {
    try {
      input.checkManagedServiceUI()
    } catch {
      return { status: 'ok', current: false }
    }
  }
  return { status: 'ok', current: true }
}
