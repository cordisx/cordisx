import { checkPreparationSignal, NativeAdapterPreparationError } from './preparation-error.js'

type Waiter = { grant(): void }
let busy = false
const waiters: Waiter[] = []

/** Bound memory across overlapping preparations in this Host process, not just within one caller. */
export async function acquireAdapterWorkerSlot(signal: AbortSignal): Promise<() => void> {
  checkPreparationSignal(signal)
  if (busy) {
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        grant() {
          signal.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new NativeAdapterPreparationError('cancelled', 'Native adapter preparation cancelled while queued'))
      }
      waiters.push(waiter)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } else {
    busy = true
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const waiter = waiters.shift()
    if (waiter) waiter.grant()
    else busy = false
  }
}
