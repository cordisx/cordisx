import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { JsonLineRpcError } from '../providers/json-line-rpc.js'

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

/** Locate an exact completed turn using metadata, then load only that one turn's items. */
export async function legacyChannelCompletion(
  request: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  sessionId: string,
  turnId: string,
): Promise<Completion> {
  let cursor: string | undefined
  const seen = new Set<string>(), deadline = Date.now() + 45_000
  for (let page = 0; page < 64 && Date.now() < deadline; page += 1) {
    const params = { threadId: sessionId, limit: 1, sortDirection: 'desc', ...(cursor === undefined ? {} : { cursor }) }
    let response: Record<string, unknown>
    try {
      response = object(await request('thread/turns/list', { ...params, itemsView: 'notLoaded' }))
      if (!Array.isArray(response.data) || response.data.length > 1) {
        return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
      }
      const turn = object(response.data[0])
      if (response.data.length && (typeof turn.id !== 'string' || !turn.id)) {
        return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
      }
      if (turn.id === turnId) {
        if (turn.status !== 'completed') return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
        const full = object(await request('thread/turns/list', { ...params, itemsView: 'full' }))
        const matching = Array.isArray(full.data) && full.data.length === 1 ? object(full.data[0]) : undefined
        // A changed page or turn must not substitute another final answer after metadata lookup.
        if (matching?.id !== turnId || matching.status !== 'completed' || !Array.isArray(matching.items)) {
          return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
        }
        return completionFromItems(matching.items.map(object), true)
      }
    } catch (error) {
      if (error instanceof JsonLineRpcError && error.message === 'RPC line exceeds maximum size') {
        return { state: 'failed', code: 'NATIVE_COMPLETION_PAGE_TOO_LARGE' }
      }
      throw error
    }
    const next = response.nextCursor
    if (!response.data.length || typeof next !== 'string' || !next || seen.has(next)) {
      return { state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' }
    }
    seen.add(next)
    cursor = next
  }
  return { state: 'failed', code: 'NATIVE_COMPLETION_PAGE_LIMIT' }
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
      // Some versions advertise the item method but reject it as unsupported.
      // Fall back only on first-page method-not-found; other failures retain their outcome.
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
