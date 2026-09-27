import type { HomeConfigProfile } from '../config/home-config.js'
import { type HomeConfigEnvironmentVariable, mergeHomeEnvironment } from '../config/home-config-environment.js'

export function hostModelServiceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  entries: readonly HomeConfigEnvironmentVariable[],
  planEnvironment?: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return mergeHomeEnvironment(environment, entries, planEnvironment)
}

export function nativeDiscoveryEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  planEnvironment?: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({ ...environment, ...(planEnvironment ?? {}) })
}

/** Keep early native submission completion and the direct launch on one selected catalog. */
export function nativeSubmissionCatalogOptions(
  homeDir: string,
  profileId: string,
  profile: Pick<
    HomeConfigProfile,
    | 'dynamicModelCatalog'
    | 'nativeModelDiscovery'
    | 'defaultModelProvider'
    | 'configModelCatalogs'
    | 'selectorIcons'
    | 'providerBindings'
  >,
  environment: Readonly<Record<string, string | undefined>>,
  planEnvironment?: Readonly<Record<string, string>>,
  recoverLegacyLock?: Readonly<{ exitedPid: number; inode: number }>,
  environmentVariables: readonly HomeConfigEnvironmentVariable[] = [],
) {
  const nativeEnvironment = hostModelServiceEnvironment(environment, environmentVariables, planEnvironment)
  return {
    managedCatalog: {
      homeDir,
      profileId,
      ...(recoverLegacyLock === undefined ? {} : { recoverLegacyLock }),
    },
    nativeDiscoveryEnvironment: nativeEnvironment,
    ...(profile.dynamicModelCatalog === undefined ? {} : { dynamicModelCatalog: profile.dynamicModelCatalog }),
    ...(profile.nativeModelDiscovery === undefined ? {} : { nativeModelDiscovery: profile.nativeModelDiscovery }),
    ...(profile.defaultModelProvider === undefined ? {} : { defaultProviderId: profile.defaultModelProvider }),
    ...(profile.configModelCatalogs === undefined ? {} : { configModelCatalogs: profile.configModelCatalogs }),
    ...(profile.selectorIcons === undefined ? {} : { selectorIcons: profile.selectorIcons }),
    ...(profile.providerBindings === undefined ? {} : { providerBindings: profile.providerBindings }),
  }
}
