import type {
  NativeProviderSelectionCommandChannel,
  NativeSubmissionScope,
} from './native-provider-selection-client.js'

export function nativeLogicalComposerConnected(disposed: boolean, composer?: HTMLElement, trigger?: HTMLElement) {
  return !disposed && (composer ?? trigger?.closest<HTMLElement>('[data-codex-composer-root]'))?.isConnected === true
}

/** Bind navigation operations to the current composer at call time. */
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
    next: (threadId: string) => {
      const current = context()
      return current.scope.threadId === threadId ? readNativeLogicalNext(current) : Promise.resolve(undefined)
    },
    open: (sessionId: string) => openNativeLogicalSource(context(), sessionId),
  }
}

type NeighborInput = {
  channel: NativeProviderSelectionCommandChannel
  scope: NativeSubmissionScope
  current(): NativeSubmissionScope
  connected(): boolean
}

/** Do not retain a boundary after the active composer changes. */
async function readNativeLogicalNeighbor(input: NeighborInput, direction: 'logicalPrevious' | 'logicalNext') {
  const read = input.channel[direction]
  if (!input.scope.threadId || !read || !input.connected()) return undefined
  try {
    const source = await read({ scope: input.scope })
    return input.connected() && JSON.stringify(input.scope) === JSON.stringify(input.current())
        && typeof source === 'string' && source.length > 0 && source.length <= 512 && !/[\0\r\n]/u.test(source)
      ? source
      : undefined
  } catch {
    return undefined
  }
}

export const readNativeLogicalPrevious = (input: NeighborInput) => readNativeLogicalNeighbor(input, 'logicalPrevious')
export const readNativeLogicalNext = (input: NeighborInput) => readNativeLogicalNeighbor(input, 'logicalNext')

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
