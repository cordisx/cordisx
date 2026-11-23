import { randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { type ChannelNativeSteer, channelNativeSteer } from './channel-native-steer.js'
import { channelProgressNative, type ChannelProgressNotice } from './channel-progress-native.js'
import type { ChannelNativeCliContext } from './channel-cli-context.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

type SourceEntry = { source: ChannelEventRef; token: string; threadId?: string; turnId?: string }
export function channelNativeContextOperations(input: {
  sources: Map<string, SourceEntry>
  cli: ChannelNativeCliContext | undefined
  request(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
  sourceFor(session: string, turn: string): ChannelEventRef | undefined
  observed(id: string, session: string, turn: string): void
}) {
  const steer: ChannelNativeSteer = (...args) =>
    channelNativeSteer({
      cli: input.cli,
      request: input.request,
      sourceFor: input.sourceFor,
      reserve: (id, source, threadId, turnId) => {
        if (input.sources.has(id) || input.sources.size >= 128) return undefined
        const token = randomBytes(24).toString('hex')
        input.sources.set(id, { source, token, threadId, turnId })
        return token
      },
      release: id => {
        input.sources.delete(id)
      },
      observe: input.observed,
    }, ...args)
  const progress = (notice: ChannelProgressNotice, current: () => boolean) => {
    const entry = [...input.sources.values()].find(entry =>
      entry.threadId === notice.sessionId
      && entry.turnId === notice.turnId && entry.source.messageId === notice.source.messageId
    )
    return channelProgressNative({
      notice,
      cli: input.cli,
      source: input.sourceFor(notice.sessionId, notice.turnId),
      context: entry?.token,
      current,
      request: input.request,
    })
  }
  return { steer, progress }
}
