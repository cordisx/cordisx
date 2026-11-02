/** Owns startup cancellation from the CLI entry until all owned cleanup drains. */
export function createStartupLifetime(parent?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  return {
    signal: controller.signal,
    abort,
    close() {
      abort()
      parent?.removeEventListener('abort', abort)
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    },
  }
}
