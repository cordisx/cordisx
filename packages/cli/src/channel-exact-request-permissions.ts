import type {
  PluginManifestChannelExactCapabilityDeclarationV16,
  PluginManifestChannelExactCapabilityNameV16,
  PluginRuntimeManifestV16,
} from '@cordisx/protocol/plugin-manifest/v16'
import { type CordisXPluginManifestV13, normalizePluginManifestV13 } from './runtime-exact-request-permissions.js'
import { validateStartupDeclaration } from './startup-declaration-validation.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v16.schema.json' as const
export type CordisXPluginManifestV16 = Omit<PluginRuntimeManifestV16, 'services'> & {
  readonly services: CordisXPluginManifestV13['services']
}
const CHANNEL_EXACT = new Set<PluginManifestChannelExactCapabilityNameV16>([
  'channel.accounts.connect',
  'channel.bindings.write',
])

export function isChannelExactRequestDeclaration(
  value: unknown,
): value is PluginManifestChannelExactCapabilityDeclarationV16 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).some(key => !['name', 'required', 'scope'].includes(key)) || item.required !== false
    || !CHANNEL_EXACT.has(item.name as PluginManifestChannelExactCapabilityNameV16)
    || item.scope === null || typeof item.scope !== 'object' || Array.isArray(item.scope)
  ) return false
  const scope = item.scope as Record<string, unknown>
  return Object.keys(scope).length === 1 && scope.runtime === 'exact-request'
}

/** Validate the successor itself before either launcher or renderer projects its predecessor plane. */
export function partitionChannelExactManifest(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v16')
  const input = value as Record<string, unknown>
  if (
    input.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 || input.schemaVersion !== 16
    || Object.keys(input).some(key =>
      !['$schema', 'schemaVersion', 'id', 'name', 'capabilities', 'services', 'startup'].includes(key)
    )
    || !Array.isArray(input.capabilities) || input.capabilities.length > 37 || !Array.isArray(input.services)
  ) {
    throw new Error('Unsupported manifest v16')
  }
  const names = new Set<string>()
  for (const item of input.capabilities) {
    const name = (item as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || names.has(name)) throw new Error('Duplicate or invalid capability')
    names.add(name)
    if (
      CHANNEL_EXACT.has(name as PluginManifestChannelExactCapabilityNameV16)
      && (item as { scope?: { runtime?: unknown } }).scope?.runtime !== undefined
      && !isChannelExactRequestDeclaration(item)
    ) throw new Error('Invalid Channel exact-request declaration')
  }
  const { startup, ...base } = input
  return {
    base: {
      ...base,
      services: input.services,
      capabilities: input.capabilities.filter(item => !isChannelExactRequestDeclaration(item)),
    },
    exact: input.capabilities.filter(isChannelExactRequestDeclaration).map(item => ({
      name: item.name,
      required: false as const,
      scope: Object.freeze({ runtime: 'exact-request' as const }),
    })),
    ...(startup === undefined ? {} : { startup: validateStartupDeclaration(startup) }),
  }
}

/** Renderer sees ordinary services only; Node managed-backend authority stays in the launcher. */
export function normalizeChannelExactManifestV16(value: unknown, expectedId: string): CordisXPluginManifestV16 {
  const { base, exact, startup } = partitionChannelExactManifest(value)
  const ordinary = normalizePluginManifestV13({
    ...base,
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v13.schema.json',
    schemaVersion: 13,
    services: (base.services as unknown[]).filter(service =>
      service === null || typeof service !== 'object'
      || Array.isArray(service) || (service as { kind?: unknown }).kind !== 'managed-backend'
    ),
  }, expectedId)
  return Object.freeze({
    ...ordinary,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V16,
    schemaVersion: 16,
    capabilities: Object.freeze([...ordinary.capabilities, ...exact]),
    ...(startup === undefined ? {} : { startup }),
  })
}

export function channelExactCapabilities(
  manifest: CordisXPluginManifestV16,
): ReadonlySet<PluginManifestChannelExactCapabilityNameV16> {
  return new Set(manifest.capabilities.filter(isChannelExactRequestDeclaration).map(item => item.name))
}
