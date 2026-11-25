import { randomUUID } from 'node:crypto'
import type { ChannelMemoryModelConnection } from './channel-user-memory-model.js'
import type { ChannelModelCandidate } from './channel-model-priority.js'
import { ChannelCredentialUnavailable, ChannelManagedConnectionUnavailable } from './channel-user-memory-connection.js'

export type ChannelConnectivityEvidence = 'healthy' | 'unavailable' | 'inconclusive' | 'cancelled'
type ProbeResult = { evidence: ChannelConnectivityEvidence; legacyAvailable: boolean }
const result = (evidence: ChannelConnectivityEvidence, legacyAvailable: boolean): ProbeResult => ({
  evidence,
  legacyAvailable,
})

async function boundedProbeFence(check: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  let abort!: () => void
  try {
    return await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('PROBE_CANCELLED'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Probe only with synthetic input and no tools; never send the Channel message. */
async function channelModelConnectivityProbe(
  connect: ChannelMemoryModelConnection | undefined,
  candidate: ChannelModelCandidate,
  parent?: AbortSignal,
  timeoutMs = 15_000,
  beforeRequest?: () => Promise<boolean>,
): Promise<ProbeResult> {
  if (parent?.aborted) return result('cancelled', false)
  if (!connect) return result('inconclusive', true)
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
    // Local connection preparation is not a completed model request.
    if (parent?.aborted) return result('cancelled', false)
    // A stalled credential/connection setup is not evidence that a model request failed.
    if (timeout.aborted) return result('inconclusive', false)
    if (error instanceof ChannelCredentialUnavailable) return result('unavailable', false)
    return result('inconclusive', !(error instanceof ChannelManagedConnectionUnavailable))
  }
  let requestStarted = false
  try {
    if (connection.protocols && !connection.protocols.includes('openai-responses')) return result('inconclusive', true)
    if (beforeRequest && !await boundedProbeFence(beforeRequest, signal)) return result('cancelled', false)
    if (parent?.aborted) return result('cancelled', false)
    if (timeout.aborted) return result('inconclusive', false)
    requestStarted = true
    const response = await fetch(`${connection.baseUrl.replace(/\/$/u, '')}/responses`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { ...connection.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: candidate.model,
        // A probe is a synthetic request, never a reusable conversation session.
        prompt_cache_key: randomUUID(),
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
      return result('unavailable', false)
    }
    if (!response.ok || Number(response.headers.get('content-length')) > 16384 || !response.body) {
      await response.body?.cancel().catch(() => {})
      return result('inconclusive', true)
    }
    const reader = response.body.getReader()
    let bytes = 0, content = ''
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 16384) return result('inconclusive', true)
        content += decoder.decode(chunk.value, { stream: true })
      }
      content += decoder.decode()
    } finally {
      await reader.cancel().catch(() => {})
    }
    // Parsing is intentionally only an acknowledgement; an unusual format is inconclusive.
    try {
      const result = JSON.parse(content) as { status?: unknown; model?: unknown }
      return result.status === 'completed'
        ? {
          evidence: result.model === candidate.model
              || typeof result.model === 'string' && connection.responseModelAliases?.includes(result.model)
            ? 'healthy'
            : 'inconclusive',
          legacyAvailable: true,
        }
        : result.status === 'failed'
        ? { evidence: 'unavailable', legacyAvailable: false }
        : { evidence: 'inconclusive', legacyAvailable: true }
    } catch {
      return result('inconclusive', true)
    }
  } catch (error) {
    if (parent?.aborted) return result('cancelled', false)
    if (timeout.aborted) return result(requestStarted ? 'unavailable' : 'inconclusive', false)
    if (!requestStarted) return result('inconclusive', false)
    // A generic fetch rejection can also be malformed local configuration or a redirect.
    const cause = error instanceof Error && error.cause && typeof error.cause === 'object'
      ? error.cause as { code?: unknown }
      : undefined
    return result(
      [
          'ECONNREFUSED',
          'ECONNRESET',
          'ENOTFOUND',
          'EAI_AGAIN',
          'EHOSTUNREACH',
          'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_SOCKET',
        ].includes(String(cause?.code))
        ? 'unavailable'
        : 'inconclusive',
      false,
    )
  } finally {
    connection.dispose()
  }
}

/** Existing creation selection retains its compatibility behavior for inconclusive probes. */
export async function channelModelConnectivity(...args: Parameters<typeof channelModelConnectivityProbe>) {
  return (await channelModelConnectivityProbe(...args)).legacyAvailable
}

/** Consumers that might move an existing conversation must require explicit evidence. */
export async function channelModelConnectivityEvidence(...args: Parameters<typeof channelModelConnectivityProbe>) {
  return (await channelModelConnectivityProbe(...args)).evidence
}
