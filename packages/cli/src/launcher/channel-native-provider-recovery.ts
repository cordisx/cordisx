import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { nativeResumeProviderMismatch } from './native-resume-provider-mismatch.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export class ChannelNativeProviderRecovery {
  constructor(
    private readonly input: {
      readonly nativeRequest: (
        method: NativeBridgeMethod,
        params: Readonly<Record<string, unknown>>,
      ) => Promise<unknown>
      readonly confirmedResumeTarget?: (threadId: string) => Promise<{ providerId: string; model: string } | undefined>
    },
  ) {}

  async target(threadId: string) {
    return await this.input.confirmedResumeTarget?.(threadId)
  }

  async probe(threadId: string, target: { providerId: string; model: string }, fence: ChannelNativeSourceFence) {
    try {
      const result = object(
        await this.input.nativeRequest(
          'thread/resume',
          fence.allowOwned('thread/resume', threadId, {
            threadId,
            excludeTurns: true,
            modelProvider: target.providerId,
            model: target.model,
          }),
        ),
      )
      return object(result.thread).id === threadId && result.modelProvider === target.providerId
          && result.model === target.model
        ? { state: 'resumed' as const }
        : { state: 'unknown' as const }
    } catch (error) {
      const sourceProvider = nativeResumeProviderMismatch(error, target.providerId)
      return sourceProvider ? { state: 'mismatch' as const, sourceProvider } : { state: 'unknown' as const }
    }
  }

  async restore(threadId: string, providerId: string, fence: ChannelNativeSourceFence) {
    const result = object(
      await this.input.nativeRequest(
        'thread/resume',
        fence.allowOwned('thread/resume', threadId, {
          threadId,
          excludeTurns: true,
          modelProvider: providerId,
        }),
      ),
    )
    if (
      object(result.thread).id !== threadId || result.modelProvider !== providerId || typeof result.model !== 'string'
    ) {
      return undefined
    }
    return { providerId, model: result.model }
  }
}
