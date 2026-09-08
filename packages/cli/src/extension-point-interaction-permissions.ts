import type { ExtensionPointInteractionCapabilityV1 } from '@cordisx/protocol/extension-point-visual/v1'
import type { PluginRuntimeManifestV10 } from '@cordisx/protocol/plugin-manifest/v10'
import { normalizePluginManifestV9 } from './permission-model-v4.js'
import { CapabilityRiskCatalog } from './capability-risk-catalog.js'
import { normalizeDomCapabilityDeclarationV3, normalizeDomPermissionScopeV3 } from './permission-model-v3.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v10.schema.json' as const
export type CordisXPluginManifestV10 = Omit<PluginRuntimeManifestV10, 'services'> & {
  readonly services: ReturnType<typeof normalizePluginManifestV9>['services']
}
export function normalizeInteractionDeclaration(value: unknown): ExtensionPointInteractionCapabilityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid interaction declaration')
  }
  const declaration = value as Record<string, unknown>
  if (
    Object.keys(declaration).some(key => !['name', 'required', 'scope'].includes(key))
    || declaration.name !== 'ui.extension-points.interact' || typeof declaration.required !== 'boolean'
  ) throw new Error('Invalid interaction declaration fields')
  if (declaration.scope === null || typeof declaration.scope !== 'object' || Array.isArray(declaration.scope)) {
    throw new Error('Interaction requires exact scope')
  }
  const scope = declaration.scope as Record<string, unknown>
  if (Object.keys(scope).some(key => !['extensionPoints', 'events'].includes(key))) {
    throw new Error('Unknown interaction scope dimension')
  }
  const points = normalizeDomPermissionScopeV3({ extensionPoints: scope.extensionPoints }).extensionPoints!
  const events = scope.events
  if (
    !Array.isArray(events) || events.length < 1 || events.length > 3 || new Set(events).size !== events.length
    || events.some(event => !['pointer.observe', 'activate', 'drag'].includes(event))
  ) throw new Error('Invalid interaction event scope')
  return Object.freeze({
    name: 'ui.extension-points.interact',
    required: declaration.required,
    scope: Object.freeze({ extensionPoints: points, events: Object.freeze([...events].sort()) }),
  })
}

/** Validate the additive edge while preserving the actual v10 identity. */
export function normalizeVisualManifestV10(value: unknown, expectedId: string): CordisXPluginManifestV10 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v10')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 || manifest.schemaVersion !== 10
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 36
  ) throw new Error('Unsupported manifest v10')
  const renders = manifest.capabilities.filter(item => item?.name === 'ui.extension-points.render').map(item => {
    const render = normalizeDomCapabilityDeclarationV3(item)
    return Object.freeze({
      name: 'ui.extension-points.render' as const,
      required: render.required,
      scope: Object.freeze({ extensionPoints: render.scope.extensionPoints! }),
    })
  })
  if (renders.length > 1) throw new Error('Duplicate render declaration')
  const interactions = manifest.capabilities.filter(item => item?.name === 'ui.extension-points.interact').map(
    normalizeInteractionDeclaration,
  )
  if (interactions.length > 1) throw new Error('Duplicate interaction declaration')
  const base = normalizePluginManifestV9(
    {
      ...manifest,
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v9.schema.json',
      schemaVersion: 9,
      capabilities: manifest.capabilities.filter(item =>
        item?.name !== 'ui.extension-points.interact' && item?.name !== 'ui.extension-points.render'
      ),
    },
    expectedId,
    new CapabilityRiskCatalog(),
  )
  return Object.freeze({
    ...base,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    capabilities: Object.freeze([...base.capabilities, ...renders, ...interactions]),
  })
}
