import type { ChatExecutionPreferences } from './chat-execution-preferences.js'

type Handler = (operation: string, value: unknown, beforeEffect?: () => Promise<boolean>) => Promise<object>

/** Fence and persist explicit native selections around the launch-owned model handler. */
export function headlessModelSelection<T extends Handler>(
  backend: T,
  getExecution: () => ChatExecutionPreferences | undefined,
): T {
  const tails = new Map<string, Promise<void>>()
  const wrapped: Handler = async (operation, value, beforeEffect) => {
    const target = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const thread = operation === 'select' && typeof target.threadId === 'string' ? target.threadId : undefined
    if (!thread) return backend(operation, value, beforeEffect)
    const previous = tails.get(thread) ?? Promise.resolve()
    let release!: () => void
    const done = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => done)
    tails.set(thread, tail)
    await previous
    try {
      const execution = getExecution()
      if (!execution) return { status: 'rejected', reason: 'native-selection-persistence-unavailable' }
      const prior = execution.read('local', thread)?.modelSelection
      try {
        // Persist uncertainty before the native effect so a crash cannot restore stale state.
        await execution.recordModelSelection(thread, undefined, { value: prior })
      } catch {
        return { status: 'rejected', reason: 'native-selection-persistence-unavailable' }
      }
      let result: object
      try {
        result = await backend(operation, value, beforeEffect)
      } catch (error) {
        await execution.recordModelSelection(thread).catch(() => {})
        throw error
      }
      const status = (result as { status?: unknown }).status
      try {
        const observed = execution.read('local', thread)?.modelSelection
        if (status === 'selected' && typeof target.providerId === 'string' && typeof target.model === 'string') {
          if (
            observed?.status === 'confirmed'
            && (observed.providerId !== target.providerId || observed.model !== target.model)
          ) {
            return { status: 'reconciliation-required', reason: 'native-selection-changed' }
          }
          await execution.recordModelSelection(thread, { providerId: target.providerId, model: target.model }, {
            value: observed,
          })
        } else if (status === 'rejected') {
          if (observed?.status !== 'confirmed') {
            await execution.recordModelSelection(
              thread,
              prior?.status === 'confirmed' ? prior : prior ? undefined : null,
              {
                value: observed,
              },
            )
          }
        } else {
          await execution.recordModelSelection(thread, undefined, { value: observed })
        }
      } catch {
        return { status: 'reconciliation-required', reason: 'native-selection-persistence-unavailable' }
      }
      return result
    } finally {
      release()
      if (tails.get(thread) === tail) tails.delete(thread)
    }
  }
  return wrapped as T
}
