/** Host-private signal bridge for existing v1/v2 answerers; no public wire shape changes. */
export async function runApprovalInvocation<Value>(
  controllers: Set<AbortController>,
  source: AbortSignal | undefined,
  invoke: (signal: AbortSignal) => Value | Promise<Value>,
  requesterControllers?: Set<AbortController>,
): Promise<Value> {
  const controller = new AbortController()
  controllers.add(controller)
  requesterControllers?.add(controller)
  const abort = (): void => controller.abort()
  source?.addEventListener('abort', abort, { once: true })
  if (source?.aborted) controller.abort()
  let remove = (): void => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => reject(new Error('Approval invocation closed'))
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
    remove = () => controller.signal.removeEventListener('abort', rejectAbort)
  })
  try {
    if (controller.signal.aborted) return await interrupted
    return await Promise.race([Promise.resolve().then(() => invoke(controller.signal)), interrupted])
  } finally {
    remove()
    source?.removeEventListener('abort', abort)
    controllers.delete(controller)
    requesterControllers?.delete(controller)
    controller.abort()
  }
}
