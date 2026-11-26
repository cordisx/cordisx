import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { HomeConfig, HomeConfigPlugin } from './home-config.js'

export interface OwnedConfiguredWrite {
  readonly configPath: string
  readonly profileId: string
  readonly pluginId: string
  current(): boolean
  borrow(): () => Promise<void>
}

const equal = (left: unknown, right: unknown) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))

/** Only the selected configured plugin's state for this profile may change. */
export function isOwnedConfiguredChange(
  owner: OwnedConfiguredWrite,
  configPath: string,
  previous: readonly HomeConfigPlugin[],
  candidate: readonly HomeConfigPlugin[],
): boolean {
  if (
    !owner.current() || path.resolve(configPath) !== owner.configPath
    || previous.filter(plugin => plugin.id === owner.pluginId).length !== 1
    || candidate.filter(plugin => plugin.id === owner.pluginId).length !== 1
  ) return false
  const rest = (plugins: readonly HomeConfigPlugin[]) =>
    plugins.map(({ profiles, ...plugin }) => ({
      ...plugin,
      profiles: Object.entries(profiles ?? {}).filter(([profileId]) =>
        plugin.id !== owner.pluginId || profileId !== owner.profileId
      ).sort(([left], [right]) => left.localeCompare(right)),
    }))
  return equal(rest(previous), rest(candidate))
}

/** No unrelated Home settings, policies, services, or plugin identity may change. */
export function isOwnedHomeConfiguredChange(
  owner: OwnedConfiguredWrite,
  configPath: string,
  previous: HomeConfig,
  candidate: HomeConfig,
): boolean {
  const { plugins: previousPlugins, ...previousHome } = previous
  const { plugins: candidatePlugins, ...candidateHome } = candidate
  return equal(previousHome, candidateHome)
    && isOwnedConfiguredChange(owner, configPath, previousPlugins, candidatePlugins)
}

/** Track borrowed writes until the owner action and its authority have settled. */
export function createOwnedConfiguredWrite(input: {
  readonly configPath: string
  readonly profileId: string
  readonly pluginId: string
  readonly isCurrent: () => boolean
}): { readonly owner: OwnedConfiguredWrite; finish(): Promise<void> } {
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
  const owner: OwnedConfiguredWrite = {
    configPath: path.resolve(input.configPath),
    profileId: input.profileId,
    pluginId: input.pluginId,
    current,
    borrow() {
      if (!current()) throw new Error('owned configured plugin write is unavailable')
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
      if (outstanding || !authorityCurrent()) throw new Error('owned configured plugin write result is uncertain')
    },
  }
}
