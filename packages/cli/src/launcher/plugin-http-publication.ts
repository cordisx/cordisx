import type { LocalWalletHttpResultV4 } from '@cordisx/protocol/plugin-http/v4'
const guards = new WeakMap<object, () => void>()
/** Private publication guard; no functions or authority enter the serialized reply. */
export function guardPluginHttpPublication(
  result: LocalWalletHttpResultV4<unknown>,
  guard: () => void,
  live: () => boolean = () => true,
): LocalWalletHttpResultV4<unknown> {
  if (result.status !== 'accepted') return result
  guards.set(result, () => {
    if (!live()) throw new Error('HTTP publication retired')
    guard()
  })
  return publishPluginHttpResult(result) as LocalWalletHttpResultV4<unknown>
}
export function publishPluginHttpResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const guard = guards.get(result)
  if (!guard) return result
  try {
    guard()
    return result
  } catch {
    return { status: 'unavailable', code: 'stale-generation' }
  }
}
/** Called synchronously at the CDP/HTTP serialization boundary, after all awaited work. */
export function publishPluginHttpEnvelope<T extends Record<string, unknown>>(reply: T): T {
  const value = publishPluginHttpResult(reply.value)
  return value === reply.value ? reply : { ...reply, value }
}
