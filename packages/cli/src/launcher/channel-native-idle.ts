import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type NativeReader = {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** A system error is selectable only when the same backend confirms its latest turn failed. */
export async function channelNativeIdle(codex: NativeReader, threadId: string) {
  const read = async () =>
    object(
      object(
        await codex.nativeRequest('thread/read', {
          threadId,
          includeTurns: false,
        }),
      ).thread,
    )
  let thread = await read()
  if (thread.id !== threadId) return undefined
  const status = object(thread.status).type
  if (status === 'idle' || status === 'notLoaded') return thread
  if (status !== 'systemError') return undefined
  const turns = object(
    await codex.nativeRequest('thread/turns/list', {
      threadId,
      limit: 1,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
    }),
  )
  if (!Array.isArray(turns.data) || turns.data.length !== 1 || object(turns.data[0]).status !== 'failed') {
    return undefined
  }
  thread = await read()
  return thread.id === threadId && object(thread.status).type === 'systemError' ? thread : undefined
}
