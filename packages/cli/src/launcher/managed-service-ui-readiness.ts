/** Keep the initial fence until both startup and source adoption settle. */
export function trackManagedServiceUIInitialReadiness(
  readiness: readonly Promise<unknown>[],
  finish: (failed: boolean) => void,
): Promise<void> {
  const ready = Promise.all(readiness).then(
    () => finish(false),
    error => {
      finish(true)
      throw error
    },
  )
  void ready.catch(() => undefined)
  return ready
}

/** Wait for the owner's initial adoption without keeping a retired renderer alive. */
export async function waitForManagedServiceUIInitialReadiness(
  ready: Promise<void> | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<void> {
  const unavailable = () => new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
  if (!ready || signal.aborted || !isCurrent()) throw unavailable()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (failed: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (failed) reject(unavailable())
      else resolve()
    }
    const onAbort = () => finish(true)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else void ready.then(() => finish(false), () => finish(true))
  })
  if (signal.aborted || !isCurrent()) throw unavailable()
}
