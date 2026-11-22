import type {
  NativeProviderSelectionCommandChannel,
  NativeSubmissionScope,
} from './native-provider-selection-client.js'

export function nativeLogicalComposerConnected(disposed: boolean, composer?: HTMLElement, trigger?: HTMLElement) {
  return !disposed && (composer ?? trigger?.closest<HTMLElement>('[data-codex-composer-root]'))?.isConnected === true
}

/** Bind the two navigation operations to the current composer at call time. */
export function createNativeLogicalNavigation(input: {
  channel(): NativeProviderSelectionCommandChannel
  scope(): NativeSubmissionScope
  connected(): boolean
  navigate(): ((threadId: string) => void | Promise<void>) | undefined
}) {
  const context = () => ({
    channel: input.channel(),
    scope: input.scope(),
    current: input.scope,
    connected: input.connected,
    navigate: input.navigate(),
  })
  return {
    previous: (threadId: string) => {
      const current = context()
      return current.scope.threadId === threadId ? readNativeLogicalPrevious(current) : Promise.resolve(undefined)
    },
    open: (sessionId: string) => openNativeLogicalSource(context(), sessionId),
  }
}

/** Do not retain an earlier boundary after the active composer changes. */
export async function readNativeLogicalPrevious(input: {
  channel: NativeProviderSelectionCommandChannel
  scope: NativeSubmissionScope
  current(): NativeSubmissionScope
  connected(): boolean
}): Promise<string | undefined> {
  if (!input.scope.threadId || !input.channel.logicalPrevious || !input.connected()) return undefined
  try {
    const source = await input.channel.logicalPrevious({ scope: input.scope })
    return input.connected() && JSON.stringify(input.scope) === JSON.stringify(input.current())
        && typeof source === 'string' && source.length > 0 && source.length <= 512 && !/[\0\r\n]/u.test(source)
      ? source
      : undefined
  } catch {
    return undefined
  }
}

/** Recheck the exact active composer after the Host authorizes one source. */
export async function openNativeLogicalSource(input: {
  channel: NativeProviderSelectionCommandChannel
  scope: NativeSubmissionScope
  current(): NativeSubmissionScope
  connected(): boolean
  navigate?: ((threadId: string) => void | Promise<void>) | undefined
}, sessionId: string): Promise<'accepted' | 'unavailable'> {
  if (!input.scope.threadId || !input.channel.logicalSourceNavigation || !input.navigate || !input.connected()) {
    return 'unavailable'
  }
  try {
    if (
      !await input.channel.logicalSourceNavigation({ scope: input.scope, sessionId })
      || !input.connected() || JSON.stringify(input.scope) !== JSON.stringify(input.current())
    ) return 'unavailable'
    await input.navigate(sessionId)
    return 'accepted'
  } catch {
    return 'unavailable'
  }
}
