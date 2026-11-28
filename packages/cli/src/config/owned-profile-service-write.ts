import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { HomeConfig, HomeConfigPlugin } from './home-config.js'

export interface OwnedServiceWrite {
  readonly configPath: string
  readonly profileId: string
  readonly pluginId: string
  readonly serviceId: string
  current(): boolean
  borrow(): () => Promise<void>
}

const equal = (left: unknown, right: unknown) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))

/** Only the selected service state for this profile may change under the borrowed lock. */
export function isOwnedServiceChange(
  owner: OwnedServiceWrite,
  configPath: string,
  previous: readonly HomeConfigPlugin[],
  candidate: readonly HomeConfigPlugin[],
): boolean {
  if (
    !owner.current() || path.resolve(configPath) !== owner.configPath || equal(previous, candidate)
    || previous.filter(plugin => plugin.id === owner.pluginId).length !== 1
    || candidate.filter(plugin => plugin.id === owner.pluginId).length !== 1
  ) return false
  const rest = (plugins: readonly HomeConfigPlugin[]) =>
    plugins.map(({ services, ...plugin }) => ({
      ...plugin,
      services: Object.entries(services ?? {}).flatMap(([serviceId, service]) => {
        const profiles = Object.entries(service.profiles).filter(([profileId]) =>
          plugin.id !== owner.pluginId || serviceId !== owner.serviceId || profileId !== owner.profileId
        ).sort(([left], [right]) => left.localeCompare(right))
        return profiles.length === 0 && plugin.id === owner.pluginId && serviceId === owner.serviceId
          ? []
          : [[serviceId, profiles]]
      }).sort(([left], [right]) => String(left).localeCompare(String(right))),
    }))
  return equal(rest(previous), rest(candidate))
}

/** The exemption cannot carry changes to other Home settings or policies. */
export function isOwnedHomeServiceChange(
  owner: OwnedServiceWrite,
  configPath: string,
  previous: HomeConfig,
  candidate: HomeConfig,
): boolean {
  const { plugins: previousPlugins, ...previousHome } = previous
  const { plugins: candidatePlugins, ...candidateHome } = candidate
  return equal(previousHome, candidateHome)
    && isOwnedServiceChange(owner, configPath, previousPlugins, candidatePlugins)
}
