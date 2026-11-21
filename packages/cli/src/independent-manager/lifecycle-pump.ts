import type { ManagerRendererLifecycleReceipt } from './lifecycle-client.js'

interface Client {
  readonly closed: boolean
  handle(command: unknown): Promise<ManagerRendererLifecycleReceipt>
  close(): Promise<void>
}

/** A failure retires this renderer; the owner decides whether reconciliation is required. */
export function startManagerRendererLifecyclePump(input: {
  readonly window: Pick<Window, 'fetch'>
  readonly sessionToken: string
  readonly client: Client
  readonly onFailure?: () => void
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
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    controller.abort()
    closing = input.client.close()
    return closing
  }
  const fail = () => {
    if (closed) return
    if (!failureReported) {
      failureReported = true
      try {
        input.onFailure?.()
      } catch { /* one renderer notification cannot keep a broken session alive */ }
    }
    void close()
  }
  const post = async (
    path: '/api/renderer/poll' | '/api/renderer/admit' | '/api/renderer/acknowledge',
    body: unknown,
  ) => {
    if (closed) throw new Error('renderer-pump-closed')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), path === '/api/renderer/poll' ? 25_000 : 20_000)
    try {
      const response = await input.window.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.sessionToken}` },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([controller.signal, timeout.signal]),
      })
      if (!response.ok || closed || timeout.signal.aborted) throw new Error('renderer-pump-unavailable')
      const content = await response.text()
      if (content.length > 1_048_576 || closed || timeout.signal.aborted) throw new Error('renderer-pump-invalid')
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
  const firstPoll = post('/api/renderer/poll', { timeoutMs: 15_000 })
  const admitted = post('/api/renderer/admit', {}).then(result => {
    if (closed || result.admitted !== true || Object.keys(result).length !== 1) {
      throw new Error('renderer-admission-unavailable')
    }
    return true
  }).catch(() => {
    fail()
    return false
  })
  const stopped = (async () => {
    let polling = firstPoll
    try {
      while (!closed) {
        const result = await polling
        if (Object.keys(result).length !== 1 || !Object.hasOwn(result, 'command')) {
          throw new Error('renderer-pump-invalid')
        }
        if (result.command !== null) {
          const receipt = await input.client.handle(result.command)
          if (closed) return
          const acknowledged = await post('/api/renderer/acknowledge', { receipt })
          if (Object.keys(acknowledged).length !== 1 || acknowledged.accepted !== true || !receipt.ok) {
            throw new Error('renderer-pump-receipt-unavailable')
          }
        }
        if (!closed) polling = post('/api/renderer/poll', { timeoutMs: 15_000 })
      }
    } catch {
      fail()
    } finally {
      await close()
    }
  })()
  return { admitted, stopped, close }
}
