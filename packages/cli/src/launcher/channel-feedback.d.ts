import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
export interface ChannelReactionReceipt {
  reactionId: string
  emojiType?: string
  removed?: boolean
}
export function channelFeedbackOutbound(target: ChannelThreadRef): void
export function instrumentFeedbackRuntime(runtime: unknown): void
export function readFeedbackSettings(home?: string): Promise<unknown>
export function createFeedbackSdkAccess(channelFor: (event: ChannelEventRef) => any, current: () => boolean): {
  react(event: ChannelEventRef, emojiType: string): Promise<ChannelReactionReceipt>
  remove(event: ChannelEventRef, reactionId: string): Promise<ChannelReactionReceipt>
  wait(event: ChannelEventRef, target: ChannelThreadRef, text: string, recordId: string): Promise<void>
}
export class ChannelFeedback {
  constructor(options: any)
  routed(recordId: string): Promise<void>
  completed(recordId: string): Promise<void>
  jobUpdated(recordId: string): void
  dispose(): void
}
