import type { HomeConfigProfile } from '../config/home-config.js'

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
) {
  return {
    managedCatalog: { homeDir, profileId },
    nativeDiscoveryEnvironment: nativeDiscoveryEnvironment(environment, planEnvironment),
    ...(profile.dynamicModelCatalog === undefined ? {} : { dynamicModelCatalog: profile.dynamicModelCatalog }),
    ...(profile.nativeModelDiscovery === undefined ? {} : { nativeModelDiscovery: profile.nativeModelDiscovery }),
    ...(profile.defaultModelProvider === undefined ? {} : { defaultProviderId: profile.defaultModelProvider }),
    ...(profile.configModelCatalogs === undefined ? {} : { configModelCatalogs: profile.configModelCatalogs }),
    ...(profile.selectorIcons === undefined ? {} : { selectorIcons: profile.selectorIcons }),
    ...(profile.providerBindings === undefined ? {} : { providerBindings: profile.providerBindings }),
  }
}
