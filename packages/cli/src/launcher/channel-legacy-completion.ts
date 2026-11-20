import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Codex 0.149.1 fallback: inspect exactly one already-completed turn. */
export async function legacyChannelCompletion(
  request: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  sessionId: string,
  turnId: string,
): Promise<{ state: 'completed' | 'failed'; text?: string; code?: string }> {
  const response = object(await request('thread/read', { threadId: sessionId, includeTurns: true }))
  const thread = object(response.thread)
  if (thread.id !== sessionId || !Array.isArray(thread.turns)) {
    return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
  }
  const matching = thread.turns.map(object).filter(item => item.id === turnId)
  if (matching.length !== 1 || matching[0]!.status !== 'completed' || !Array.isArray(matching[0]!.items)) {
    return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
  }
  const finals = matching[0]!.items.map(object)
    .filter(item => item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string')
    .map(item => String(item.text))
  return finals.length
    ? { state: 'completed', text: finals.join('\n') }
    : { state: 'failed', code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE' }
}

/** Read final items without mixing content from another turn. */
export async function readChannelCompletion(
  request: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  sessionId: string,
  turnId: string,
): Promise<{ state: 'completed' | 'failed'; text?: string; code?: string }> {
  // Fetch items only for this exact completed turn; never load another chat's transcript.
  let cursor: string | undefined
  const messages: string[] = []
  for (let page = 0; page < 16; page += 1) {
    let result: Record<string, unknown>
    try {
      result = object(
        await request('thread/items/list', {
          threadId: sessionId,
          limit: 32,
          sortDirection: 'desc',
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
    } catch (error) {
      // Codex 0.149.1 has no item pagination. Read the exact completed turn
      // only for method-not-found; never substitute history on another error.
      if (object(error).rpcCode !== -32601 || cursor !== undefined) throw error
      return legacyChannelCompletion(request, sessionId, turnId)
    }
    if (!Array.isArray(result.data)) return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
    let olderTurn = false
    for (const raw of result.data) {
      const row = object(raw)
      if (row.turnId !== turnId) {
        if (messages.length) olderTurn = true
        continue
      }
      const item = object(row.item)
      if (item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') {
        messages.unshift(item.text)
      }
    }
    if (olderTurn || typeof result.nextCursor !== 'string' || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return messages.length
    ? { state: 'completed', text: messages.join('\n') }
    : { state: 'failed', code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE' }
}
