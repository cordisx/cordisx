import type { ChannelMemoryModelConnection } from './channel-user-memory-model.js'
import type { ChannelModelCandidate } from './channel-model-priority.js'
import { ChannelManagedConnectionUnavailable } from './channel-user-memory-connection.js'

/** Probe only with synthetic input and no tools; never send the Channel message. */
export async function channelModelConnectivity(
  connect: ChannelMemoryModelConnection | undefined,
  candidate: ChannelModelCandidate,
  parent?: AbortSignal,
  timeoutMs = 15_000,
  beforeRequest?: () => Promise<boolean>,
): Promise<boolean> {
  if (!connect) return true // This provider has no supported direct Responses connection.
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
  let claimed = false
  const pending = connect(candidate.providerId, candidate.model, signal)
  void pending.then(connection => {
    if (!claimed && signal.aborted) connection.dispose()
  }, () => {})
  let connection: Awaited<typeof pending>
  try {
    connection = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('PROBE_TIMEOUT'))
        else signal.addEventListener('abort', () => reject(new Error('PROBE_TIMEOUT')), { once: true })
      }),
    ])
    claimed = true
  } catch (error) {
    // Unsupported direct connections are inconclusive; a known managed failure or timeout is unavailable.
    return !signal.aborted && !(error instanceof ChannelManagedConnectionUnavailable)
  }
  try {
    if (connection.protocols && !connection.protocols.includes('openai-responses')) return true
    if (beforeRequest && !await beforeRequest()) return false
    const response = await fetch(`${connection.baseUrl.replace(/\/$/u, '')}/responses`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { ...connection.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: candidate.model,
        instructions: 'Reply with OK. Do not call tools.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Connectivity check.' }] }],
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: false,
        max_output_tokens: 64,
      }),
    })
    if ([401, 403, 408, 429].includes(response.status) || response.status >= 500) {
      await response.body?.cancel().catch(() => {})
      return false
    }
    if (!response.ok || Number(response.headers.get('content-length')) > 16384 || !response.body) {
      await response.body?.cancel().catch(() => {})
      return true // Incompatible Responses implementations cannot establish health.
    }
    const reader = response.body.getReader()
    let bytes = 0, content = ''
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 16384) return true
        content += decoder.decode(chunk.value, { stream: true })
      }
      content += decoder.decode()
    } finally {
      await reader.cancel().catch(() => {})
    }
    // Parsing is intentionally only an acknowledgement; an unusual format is inconclusive.
    try {
      const result = JSON.parse(content) as { status?: unknown }
      return result.status !== 'failed'
    } catch {
      return true
    }
  } catch {
    return false // Network errors and the bounded probe timeout are safe to skip.
  } finally {
    connection.dispose()
  }
}
