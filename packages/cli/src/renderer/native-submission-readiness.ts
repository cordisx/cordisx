/** Boot the Host independently; install the native selector only after its real guard is ready. */
export function scheduleNativeSubmissionReadiness(input: {
  ready: Promise<boolean> | undefined
  current(): boolean
  install(): Promise<() => void>
  unavailable(): () => void
}): () => void {
  let disposed = false
  let cleanup: (() => void) | undefined
  const live = () => !disposed && input.current()
  const unavailable = () => {
    if (live()) cleanup = input.unavailable()
  }
  void Promise.resolve(input.ready ?? false).then(async ready => {
    if (!live()) return
    if (!ready) {
      unavailable()
      return
    }
    const installed = await input.install()
    if (!live()) installed()
    else cleanup = installed
  }).catch(unavailable)
  return () => {
    if (disposed) return
    disposed = true
    cleanup?.()
  }
}
