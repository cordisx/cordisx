import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type Completion = { state: 'completed' | 'failed'; text?: string; code?: string }

/** Only use an unphased answer when the complete turn leaves no commentary ambiguity. */
function completionFromItems(items: readonly Record<string, unknown>[], complete: boolean): Completion {
  const finals = items
    .filter(item => item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string')
    .map(item => String(item.text))
  if (finals.length) return { state: 'completed', text: finals.join('\n') }
  const messages = items.filter(item => item.type === 'agentMessage')
  const candidate = messages[0]
  if (
    complete && messages.length === 1 && candidate !== undefined && candidate === items.at(-1)
    && candidate.phase == null && typeof candidate.text === 'string' && candidate.text.trim().length > 0
  ) return { state: 'completed', text: candidate.text }
  return { state: 'failed', code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE' }
}

/** Codex 0.149.1 fallback: inspect exactly one already-completed turn. */
export async function legacyChannelCompletion(
  request: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  sessionId: string,
  turnId: string,
): Promise<Completion> {
  const response = object(await request('thread/read', { threadId: sessionId, includeTurns: true }))
  const thread = object(response.thread)
  if (thread.id !== sessionId || !Array.isArray(thread.turns)) {
    return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
  }
  const matching = thread.turns.map(object).filter(item => item.id === turnId)
  if (matching.length !== 1 || matching[0]!.status !== 'completed' || !Array.isArray(matching[0]!.items)) {
    return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
  }
  return completionFromItems(matching[0]!.items.map(object), true)
}

/** Read final items without mixing content from another turn. */
export async function readChannelCompletion(
  request: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  sessionId: string,
  turnId: string,
): Promise<Completion> {
  // Fetch items only for this exact completed turn; never load another chat's transcript.
  let cursor: string | undefined
  const items: Record<string, unknown>[] = []
  let seenTurn = false
  let complete = false
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
    for (const raw of result.data) {
      const row = object(raw)
      if (row.turnId !== turnId) {
        if (seenTurn) {
          complete = true
          break
        }
        continue
      }
      seenTurn = true
      items.unshift(object(row.item))
    }
    if (complete) break
    if (typeof result.nextCursor !== 'string') {
      complete = true
      break
    }
    if (result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return completionFromItems(items, complete)
}
