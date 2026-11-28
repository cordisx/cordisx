import path from 'node:path'

export interface OwnedPackageWrite {
  readonly homeDir: string
  readonly profileId: string
  readonly pluginId: string
  current(): boolean
  borrow(): () => Promise<void>
}

/** Track borrowed work; only the profile fence can install this in its private context. */
export function createOwnedPackageWrite(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly pluginId: string
  readonly isCurrent: () => boolean
}): { readonly owner: OwnedPackageWrite; finish(): Promise<void> } {
  let accepting = true
  let borrowed = 0
  const waiters = new Set<() => void>()
  const authorityCurrent = () => {
    try {
      return input.isCurrent()
    } catch {
      return false
    }
  }
  const current = () => accepting && authorityCurrent()
  const owner: OwnedPackageWrite = {
    homeDir: path.resolve(input.homeDir),
    profileId: input.profileId,
    pluginId: input.pluginId,
    current,
    borrow() {
      if (!current()) throw new Error('owned package write is unavailable')
      borrowed++
      let released = false
      return async () => {
        if (released) return
        released = true
        borrowed--
        if (borrowed === 0) { for (const notify of waiters) notify() }
      }
    },
  }
  return {
    owner,
    async finish() {
      const outstanding = borrowed !== 0
      accepting = false
      if (borrowed !== 0) await new Promise<void>(resolve => waiters.add(resolve))
      if (outstanding || !authorityCurrent()) throw new Error('owned package write result is uncertain')
    },
  }
}
