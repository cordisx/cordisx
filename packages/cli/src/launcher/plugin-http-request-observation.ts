import type { HttpResponseV1, HttpResultV1 } from '@cordisx/protocol/plugin-http/v1'
import { bindDiagnostic, diagnostic, diagnosticError, diagnosticId, diagnosticRef } from '../diagnostics/context.js'

export { diagnosticError }
export function observePluginHttpRequest(
  pluginId: string,
  emit = diagnostic,
): (event: string, detail?: Record<string, string | number | undefined>) => void {
  const requestRef = diagnosticId(), started = performance.now()
  return (event, detail = {}) =>
    emit({
      event,
      requestRef,
      pluginRef: diagnosticRef(pluginId),
      provider: 'unknown',
      model: 'unknown',
      elapsedMs: Math.round(performance.now() - started),
      ...detail,
    })
}

/** Body observation stays bounded. Credential/account fences remain with the owning authority around this call. */
export async function observePluginHttpResponse(
  response: Response,
  abort: AbortController,
  report: ReturnType<typeof observePluginHttpRequest>,
): Promise<HttpResultV1<HttpResponseV1>> {
  report('http-response-headers', { statusCode: response.status })
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    return { status: 'unavailable', code: 'redirect-denied' }
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0, first = true
  if (reader !== undefined) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (first) {
        report('http-first-event', { statusCode: response.status })
        first = false
      }
      bytes += next.value.byteLength
      if (bytes > 1_048_576) {
        await reader.cancel()
        abort.abort()
        return { status: 'unavailable', code: 'response-too-large' }
      }
      chunks.push(next.value)
    }
  }
  return {
    status: 'accepted',
    value: {
      statusCode: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.concat(chunks).toString('utf8'),
    },
  }
}

export function createPluginHttpRequestObserver(): typeof observePluginHttpRequest {
  const emit = bindDiagnostic()
  return pluginId => observePluginHttpRequest(pluginId, emit)
}
export function finishPluginHttpRequest(
  report: ReturnType<typeof observePluginHttpRequest>,
  input: { expired: boolean; aborted: boolean; outcome: string; statusCode?: number },
): void {
  report(
    input.expired
      ? 'http-request-deadline'
      : input.aborted
      ? 'http-request-cancelled'
      : input.outcome === 'completed'
      ? 'http-request-completed'
      : 'http-request-failed',
    { statusCode: input.statusCode, outcome: input.outcome },
  )
}
