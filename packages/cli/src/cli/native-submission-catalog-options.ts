import type { HomeConfigProfile } from '../config/home-config.js'

/** Keep early native submission completion and the direct launch on one selected catalog. */
export function nativeSubmissionCatalogOptions(
  homeDir: string,
  profileId: string,
  profile: Pick<
    HomeConfigProfile,
    'dynamicModelCatalog' | 'defaultModelProvider' | 'configModelCatalogs' | 'selectorIcons'
  >,
) {
  return {
    managedCatalog: { homeDir, profileId },
    ...(profile.dynamicModelCatalog === undefined ? {} : { dynamicModelCatalog: profile.dynamicModelCatalog }),
    ...(profile.defaultModelProvider === undefined ? {} : { defaultProviderId: profile.defaultModelProvider }),
    ...(profile.configModelCatalogs === undefined ? {} : { configModelCatalogs: profile.configModelCatalogs }),
    ...(profile.selectorIcons === undefined ? {} : { selectorIcons: profile.selectorIcons }),
  }
}
