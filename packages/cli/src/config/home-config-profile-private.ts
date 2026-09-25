import type { HomeConfig, HomeConfigIconThemePreference } from './home-config.js'
import {
  type ManagedProviderRecord,
  parseManagedProviderRecord,
} from '../launcher/model-catalog/managed-provider-schema.js'

const ICON_PROVIDER_ID =
  /^(?:builtin:[a-z0-9][a-z0-9._-]{0,63}|plugin:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63})$/
const ICON_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ICON_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseIconThemePreference(value: unknown): HomeConfigIconThemePreference | undefined {
  // A corrupted optional preference must not make the whole Host profile unavailable.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const preference = value as Record<string, unknown>
  if (
    Object.keys(preference).sort().join(',') !== 'namespace,providerGeneration,providerId,providerVersion,revision'
    || !Number.isSafeInteger(preference.revision) || (preference.revision as number) < 1
    || typeof preference.providerId !== 'string' || !ICON_PROVIDER_ID.test(preference.providerId)
    || typeof preference.namespace !== 'string' || !ICON_NAMESPACE.test(preference.namespace)
    || typeof preference.providerVersion !== 'string' || !SEMVER.test(preference.providerVersion)
    || typeof preference.providerGeneration !== 'string' || !ICON_GENERATION.test(preference.providerGeneration)
  ) return undefined
  return {
    revision: preference.revision as number,
    providerId: preference.providerId as HomeConfigIconThemePreference['providerId'],
    namespace: preference.namespace,
    providerVersion: preference.providerVersion,
    providerGeneration: preference.providerGeneration,
  }
}

export function parseManagedProviders(value: unknown, label: string): readonly ManagedProviderRecord[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error(`${label} must be an array`)
  if ((value?.length ?? 0) > 64) throw new Error(`${label} must contain at most 64 records`)
  const records = (value ?? []).map(record => parseManagedProviderRecord(record))
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`${label} contains duplicate ids`)
    ids.add(record.id)
  }
  return records
}

/** Return a printable home-config projection without managed Provider credentials or references. */
export function redactedHomeConfig(config: HomeConfig): unknown {
  return {
    ...config,
    apps: Object.fromEntries(
      Object.entries(config.apps).map(([appId, app]) => [appId, {
        ...app,
        profiles: Object.fromEntries(
          Object.entries(app.profiles).map(([profileId, profile]) => [profileId, {
            ...profile,
            ...(profile.managedProviders === undefined
              ? {}
              : {
                managedProviders: profile.managedProviders.map((
                  { secret: _secret, credentialRef: _ref, ...record },
                ) => ({
                  ...record,
                  credentialState: 'set',
                })),
              }),
          }]),
        ),
      }]),
    ),
  }
}
