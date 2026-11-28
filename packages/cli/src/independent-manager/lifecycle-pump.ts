import type { ManagerRendererLifecycleReceipt } from './lifecycle-client.js'

interface Client {
  readonly closed: boolean
  readonly quiesced?: boolean
  handle(command: unknown): Promise<ManagerRendererLifecycleReceipt>
  close(): Promise<void>
}

class PollTransportError extends Error {}

/** A failure retires this renderer; the owner decides whether reconciliation is required. */
export function startManagerRendererLifecyclePump(input: {
  readonly window: Pick<Window, 'fetch'>
  readonly sessionToken: string
  readonly client: Client
  readonly onFailure?: (reason?: 'poll-transport') => void
  /** Only an idle, admitted renderer may attempt owner-confirmed poll recovery. */
  readonly canRecoverPoll?: () => boolean
  /** Called only after the owner has accepted a successful quiescence receipt. */
  readonly onQuiesced?: () => void
}): {
  readonly admitted: Promise<boolean>
  readonly stopped: Promise<void>
  close(): Promise<void>
} {
  if (!/^[a-f0-9]{64}$/u.test(input.sessionToken)) throw new Error('renderer-pump-session-invalid')
  const controller = new AbortController()
  let closed = false
  let failureReported = false
  let closing: Promise<void> | undefined
  let hasAdmitted = false
  let nextSequence = 1
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    controller.abort()
    closing = input.client.close()
    return closing
  }
  const fail = (reason?: 'poll-transport') => {
    if (closed) return
    if (!failureReported) {
      failureReported = true
      try {
        input.onFailure?.(reason)
      } catch { /* one renderer notification cannot keep a broken session alive */ }
    }
    void close()
  }
  const post = async (
    path: '/api/renderer/poll' | '/api/renderer/poll-recover' | '/api/renderer/admit' | '/api/renderer/acknowledge',
    body: unknown,
  ) => {
    if (closed) throw new Error('renderer-pump-closed')
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(),
      path === '/api/renderer/poll-recover' ? 40_000 : path === '/api/renderer/poll' ? 25_000 : 20_000,
    )
    try {
      const transportFailure = (error: unknown): never => {
        if (!closed && path === '/api/renderer/poll') {
          throw new PollTransportError('renderer-poll-transport', { cause: error })
        }
        throw error
      }
      const response = await input.window.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.sessionToken}` },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([controller.signal, timeout.signal]),
      }).catch(transportFailure)
      if (!response.ok || closed) throw new Error('renderer-pump-unavailable')
      if (timeout.signal.aborted) transportFailure(new Error('renderer-pump-timeout'))
      const content = await response.text().catch(transportFailure)
      if (content.length > 1_048_576 || closed) throw new Error('renderer-pump-invalid')
      if (timeout.signal.aborted) transportFailure(new Error('renderer-pump-timeout'))
      const result: unknown = JSON.parse(content)
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('renderer-pump-invalid')
      }
      return result as Record<string, unknown>
    } finally {
      clearTimeout(timer)
    }
  }

  // The owner may need this poll to deliver synchronize before admission can
  // complete. Start the poll first and wait for both paths independently.
  const poll = () => {
    if (!Number.isSafeInteger(nextSequence) || nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('renderer-poll-sequence-unavailable')
    }
    const sequence = nextSequence++
    return { sequence, result: post('/api/renderer/poll', { timeoutMs: 15_000, pollSequence: sequence }) }
  }
  const canRecover = () => {
    try {
      return hasAdmitted && !closed && input.canRecoverPoll?.() === true
    } catch {
      return false
    }
  }
  const firstPoll = poll()
  const admitted = post('/api/renderer/admit', {}).then(result => {
    if (closed || result.admitted !== true || Object.keys(result).length !== 1) {
      throw new Error('renderer-admission-unavailable')
    }
    hasAdmitted = true
    return true
  }).catch(() => {
    fail()
    return false
  })
  const stopped = (async () => {
    let polling = firstPoll
    let consecutiveRecoveries = 0
    try {
      while (!closed) {
        let result: Record<string, unknown>
        try {
          result = await polling.result
        } catch (error) {
          if (error instanceof PollTransportError && consecutiveRecoveries === 0 && canRecover()) {
            try {
              const recovery = await post('/api/renderer/poll-recover', { pollSequence: polling.sequence })
              if (recovery.recovered === true && Object.keys(recovery).length === 1 && canRecover()) {
                consecutiveRecoveries++
                polling = poll()
                continue
              }
            } catch { /* A failed confirmation falls back to normal retirement. */ }
          }
          throw error
        }
        if (Object.keys(result).length !== 1 || !Object.hasOwn(result, 'command')) {
          throw new Error('renderer-pump-invalid')
        }
        consecutiveRecoveries = 0
        if (result.command !== null) {
          const receipt = await input.client.handle(result.command)
          if (closed) return
          const acknowledged = await post('/api/renderer/acknowledge', { receipt })
          if (Object.keys(acknowledged).length !== 1 || acknowledged.accepted !== true || !receipt.ok) {
            throw new Error('renderer-pump-receipt-unavailable')
          }
          if (input.client.quiesced === true) {
            input.onQuiesced?.()
            return
          }
        }
        if (!closed) polling = poll()
      }
    } catch (error) {
      fail(error instanceof PollTransportError ? 'poll-transport' : undefined)
    } finally {
      await close()
    }
  })()
  return { admitted, stopped, close }
}
