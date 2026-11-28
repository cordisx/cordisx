/** Release a waiting transport read when its renderer leaves; resource cleanup remains owner-controlled. */
export async function awaitObservationOrAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('MANAGED_SERVICE_UI_UNAVAILABLE'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([operation, stopped])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
