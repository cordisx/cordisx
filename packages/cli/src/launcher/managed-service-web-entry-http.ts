/** One bounded JSON exchange. Never follows a redirect or forwards ambient credentials. */
export async function readWebEntryJSON(
  fetch: typeof globalThis.fetch,
  url: URL,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>> = {},
  body?: object,
): Promise<unknown> {
  signal.throwIfAborted()
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
    signal,
    redirect: 'error',
    credentials: 'omit',
  })
  if (signal.aborted || !response.ok || response.redirected) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('web entry response unavailable')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('web entry response is empty')
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      total += value.byteLength
      if (total > 64 * 1024) {
        await reader.cancel()
        throw new Error('web entry response is too large')
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
