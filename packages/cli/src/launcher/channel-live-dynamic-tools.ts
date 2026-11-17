import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelConversationTools } from './channel-conversation-tools.js'

export const CHANNEL_PREPARATION_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'cordisx_continuation_history',
    description: 'Read a bounded page of the confirmed source history for this preparation turn.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 32 },
        cursor: { type: 'string', maxLength: 16384 },
      },
    },
  },
  {
    type: 'function',
    name: 'cordisx_continuation_takeover_ready',
    description:
      'Signal the Host that this preparation turn is ready, using the supplied token. End this turn after acceptance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        token: { type: 'string', minLength: 64, maxLength: 64 },
      },
      required: ['token'],
    },
  },
])

/** Native app-server request IDs and thread/turn metadata are supplied by the owned connection. */
export async function handlePreparationToolCall(
  value: unknown,
  native: ChannelNativeSessions | undefined,
  tools: ChannelConversationTools | undefined,
): Promise<{ success: boolean; contentItems: { type: 'inputText'; text: string }[] }> {
  const params = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const name = params.tool, threadId = params.threadId, turnId = params.turnId
  const operation = name === 'cordisx_continuation_history'
    ? 'continuation-history'
    : name === 'cordisx_continuation_takeover_ready'
    ? 'continuation-takeover-ready'
    : undefined
  const unavailable = {
    success: false,
    contentItems: [{ type: 'inputText' as const, text: '{"status":"unavailable"}' }],
  }
  if (
    !operation || typeof threadId !== 'string' || typeof turnId !== 'string'
    || !native?.isPreparing(threadId) || !tools || params.namespace !== null && params.namespace !== undefined
  ) return unavailable
  try {
    const result = await tools.call(operation, params.arguments ?? {}, {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    })
    const text = JSON.stringify(result)
    if (text.length > 128_000) return unavailable
    const status = result && typeof result === 'object' ? (result as Record<string, unknown>).status : undefined
    return { success: status === 'ok' || status === 'accepted', contentItems: [{ type: 'inputText', text }] }
  } catch {
    return unavailable
  }
}
