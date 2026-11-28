import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage<true>()

/** Prevent nested owner writes from acquiring profile fences in opposite orders. */
export function hasOwnedProfileWrite(): boolean {
  return current.getStore() === true
}

export async function runOwnedProfileWrite<T>(action: () => Promise<T>): Promise<T> {
  if (hasOwnedProfileWrite()) throw new Error('owned profile write is unavailable')
  return await current.run(true, action)
}
