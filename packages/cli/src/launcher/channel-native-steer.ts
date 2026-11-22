import { JsonLineRpcError } from '../providers/json-line-rpc.js'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { channelAttachmentTicket, channelNativeResourceInput } from './channel-inbound-resources.js'
import { channelSteerNotActive } from './channel-native-steer-error.js'
import { sameChannelPrincipal } from './channel-source-principal.js'
import { channelNativeMessagePrompt } from './channel-native-message-prompt.js'
import type { ChannelNativeCliContext } from './channel-cli-context.js'
import type { ChannelMessageContext } from './channel-message-context.js'
import type { ChannelReplyDefaults } from './channel-reply-routing.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
type Owner = {
  cli: ChannelNativeCliContext | undefined
  request(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
  sourceFor(sessionId: string, turnId: string): ChannelEventRef | undefined
  reserve(operationId: string, event: ChannelEventRef, sessionId: string, turnId: string): string | undefined
  release(operationId: string): void
  observe(operationId: string, sessionId: string, turnId: string): void
}
type Result = { state: 'accepted' | 'rejected' | 'failed' | 'reconciliation-required'; code?: string }

/** Submit a new Channel input to exactly the already acknowledged native turn. */
export async function channelNativeSteer(
  owner: Owner,
  operationId: string,
  message: ChannelUserInput,
  sessionId: string,
  turnId: string,
  signal?: AbortSignal,
  reply?: ChannelReplyDefaults & { readonly enabled: boolean },
  context?: ChannelMessageContext,
): Promise<Result> {
  if (signal?.aborted) return { state: 'rejected' }
  const original = owner.sourceFor(sessionId, turnId)
  if (!original || !sameChannelPrincipal(original, message.source.event)) return { state: 'rejected' }
  const contextToken = owner.reserve(operationId, message.source.event, sessionId, turnId)
  if (!contextToken) return { state: 'failed', code: 'CHANNEL_DISPATCH_CONTEXT_BUSY' }
  const prompt = channelNativeMessagePrompt({
    operationId,
    message,
    context,
    reply,
    cli: owner.cli,
    contextToken,
    capsule: undefined,
    brief: undefined,
    handoffMarker: undefined,
    logicalHandoff: undefined,
    logicalHistory: false,
  })
  let nativeInput: ReturnType<typeof channelNativeResourceInput>
  try {
    nativeInput = channelNativeResourceInput(prompt, await channelAttachmentTicket(message))
  } catch {
    owner.release(operationId)
    return { state: 'failed', code: 'CHANNEL_ATTACHMENT_UNAVAILABLE' }
  }
  if (signal?.aborted) {
    owner.release(operationId)
    return { state: 'rejected' }
  }
  try {
    const result = object(
      await owner.request('turn/steer', {
        threadId: sessionId,
        expectedTurnId: turnId,
        clientUserMessageId: operationId,
        input: nativeInput,
      }),
    )
    if (result.cordisxSteerRejected === true) {
      owner.release(operationId)
      return { state: 'rejected' }
    }
    if (result.turnId !== turnId) return { state: 'reconciliation-required', code: 'NATIVE_STEER_UNCERTAIN' }
    owner.observe(operationId, sessionId, turnId)
    return { state: 'accepted' }
  } catch (error) {
    if (channelSteerNotActive(error, turnId)) {
      owner.release(operationId)
      return { state: 'rejected' }
    }
    return { state: 'reconciliation-required', code: 'NATIVE_STEER_UNCERTAIN' }
  }
}

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never
export type ChannelNativeSteer = (...args: DropFirst<Parameters<typeof channelNativeSteer>>) => Promise<Result>

/** Positive bounded history evidence can recover an unknown receipt; absence never authorizes replay. */
export async function channelSteerObserved(
  request: Owner['request'],
  operationId: string,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const marker = '{"operationId":' + JSON.stringify(operationId) + ','
  const matches = (value: unknown) => {
    const item = object(value)
    return item.type === 'userMessage' && Array.isArray(item.content)
      && item.content.map(object).some(part =>
        part.type === 'text' && typeof part.text === 'string'
        && part.text.includes(marker)
      )
  }
  try {
    let cursor: string | undefined
    for (let page = 0; page < 8; page++) {
      const result = object(
        await request('thread/items/list', {
          threadId: sessionId,
          limit: 32,
          sortDirection: 'desc',
          ...(cursor ? { cursor } : {}),
        }),
      )
      if (!Array.isArray(result.data) || result.data.length > 32) return false
      if (result.data.map(object).some(row => row.turnId === turnId && matches(row.item))) return true
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) return false
      cursor = result.nextCursor
    }
  } catch (error) {
    // Older native versions lack item pagination; do not replace arbitrary transport errors with a full read.
    if (!(error instanceof JsonLineRpcError) || error.rpcCode !== -32601) return false
    try {
      let cursor: string | undefined
      for (let page = 0; page < 8; page++) {
        const result = object(
          await request('thread/turns/list', {
            threadId: sessionId,
            limit: 1,
            itemsView: 'full',
            sortDirection: 'desc',
            ...(cursor ? { cursor } : {}),
          }),
        )
        if (!Array.isArray(result.data) || result.data.length > 1) return false
        const turn = object(result.data[0])
        if (turn.id === turnId) return Array.isArray(turn.items) && turn.items.some(matches)
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) return false
        cursor = result.nextCursor
      }
    } catch { /* Unknown history remains fenced. */ }
  }
  return false
}
