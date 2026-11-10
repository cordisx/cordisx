import { type CdpSession, removeCdpFutureScript } from './cdp-session.js'

/** Retain failed renderer cleanup steps without repeating successful removals. */
export function nativeSubmissionChannelCleanup(
  generation: string,
  identifier: () => string | undefined,
  originalSession?: CdpSession,
): (session: CdpSession) => Promise<void> {
  let disposed = false
  let bindingRemoved = false
  let scriptRemoved = false
  let pending: Promise<void> | undefined
  return async session => {
    if (pending !== undefined) return await pending
    pending = (async () => {
      if (!disposed) {
        const result = await session.send('Runtime.evaluate', {
          expression: `(() => {
            const owner = globalThis.__cordisxNativeProviderOwner
            if (owner !== undefined && owner.rendererGeneration !== ${JSON.stringify(generation)}) {
              throw new Error('Native channel cleanup owner changed')
            }
            globalThis.__cordisxNativeSubmissionChannelDispose?.()
          })()`,
        })
        if (result.exceptionDetails !== undefined) throw new Error('Native channel cleanup was rejected')
        disposed = true
      }
      if (!bindingRemoved) {
        await session.send('Runtime.removeBinding', { name: '__cordisxNativeSubmissionCommand' })
        bindingRemoved = true
      }
      const script = identifier()
      if (!scriptRemoved && script !== undefined) {
        await removeCdpFutureScript(session, script, originalSession ?? session)
        scriptRemoved = true
      }
    })()
    try {
      await pending
    } finally {
      pending = undefined
    }
  }
}
