import { vi } from 'vitest'
import {
  CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  type CordisXExtensionPointControlAuthorizationV1,
  type CordisXExtensionPointControlClaimOptions,
  type CordisXHostExtensionPointControlCatalogV1,
} from '../../packages/cli/src/contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
  MemoryControlledSurfacePolicyStore,
  normalizeControlledSurfaceDeclaration,
} from '../../packages/cli/src/renderer/controlled-surfaces.js'

export const catalog: CordisXHostExtensionPointControlCatalogV1 = {
  $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  schemaVersion: 1,
  points: [
    {
      id: 'model.overlay',
      modes: [
        { id: 'compose', stacking: 'ordered', coexistsWith: [], defaultAuthorization: 'allow' },
        {
          id: 'replace',
          stacking: 'exclusive',
          exclusiveGroup: 'ownership',
          coexistsWith: [],
          defaultAuthorization: 'deny',
        },
      ],
      exclusiveGroups: [{
        id: 'ownership',
        modes: ['replace'],
        cardinality: 'one',
        selection: 'user',
        nativeFallback: true,
      }],
      safeProperties: [],
      safeCommands: [],
      safeEvents: [],
      ownership: { scope: 'subtree', suppressesDescendantsWhenModes: ['replace'] },
    },
    {
      id: 'model.reasoning-intensity',
      parentPointId: 'model.overlay',
      modes: [
        { id: 'compose', stacking: 'ordered', coexistsWith: ['overlay', 'proxy'], defaultAuthorization: 'allow' },
        {
          id: 'replace',
          stacking: 'exclusive',
          exclusiveGroup: 'renderer',
          coexistsWith: ['overlay'],
          defaultAuthorization: 'deny',
        },
        {
          id: 'overlay',
          stacking: 'ordered',
          coexistsWith: ['compose', 'replace', 'proxy'],
          defaultAuthorization: 'deny',
        },
        { id: 'proxy', stacking: 'ordered', coexistsWith: ['compose', 'overlay'], defaultAuthorization: 'deny' },
        {
          id: 'hide-native',
          stacking: 'exclusive',
          exclusiveGroup: 'renderer',
          coexistsWith: [],
          defaultAuthorization: 'deny',
        },
      ],
      exclusiveGroups: [{
        id: 'renderer',
        modes: ['replace', 'hide-native'],
        cardinality: 'one',
        selection: 'user',
        nativeFallback: true,
      }],
      safeProperties: [{
        id: 'reasoningIntensity',
        schema: { type: 'string', enum: ['low', 'medium', 'high'] },
        visibility: 'renderer-safe',
        mutable: false,
      }],
      safeCommands: [{
        id: 'setReasoningIntensity',
        dispatch: 'host-brokered',
        arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }],
      }],
      safeEvents: [{
        id: 'reasoningIntensityChanged',
        delivery: 'host-projected',
        payload: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }],
      }],
      ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
    },
  ],
}

export const generation = (
  pluginId: string,
  moduleGeneration = `${pluginId}-v1`,
  origin: 'explicit' | 'legacy-structured' = 'explicit',
) => ({
  principalHandle: `principal:${pluginId}:${origin}`,
  principalOrigin: origin,
  source: `https://plugins.example/${pluginId}`,
  pluginId,
  moduleGeneration,
})

export function declaration(
  pluginId: string,
  pointId: string,
  contributionId: string,
  control?: CordisXExtensionPointControlClaimOptions,
  order?: number,
) {
  return normalizeControlledSurfaceDeclaration({
    principalHandle: `principal:${pluginId}:${control === undefined ? 'legacy-structured' : 'explicit'}`,
    source: `https://plugins.example/${pluginId}`,
    pluginId,
    pointId,
    contributionId,
    control,
    order,
  })
}

export function authorization(
  pluginId: string,
  pointId: string,
  claimId: string,
  mode: CordisXExtensionPointControlAuthorizationV1['mode'],
  policy: 'allow' | 'deny',
  origin: 'explicit' | 'legacy-structured' = 'explicit',
): CordisXExtensionPointControlAuthorizationV1 {
  return {
    $schema: CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
    schemaVersion: 1,
    principalHandle: `principal:${pluginId}:${origin}`,
    identity: { source: `https://plugins.example/${pluginId}`, pluginId, pointId },
    claimId,
    mode,
    policy,
  }
}

export function activation(
  revision: number,
  digestCharacter: string,
  moduleGeneration = 'theme-v1',
): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: 'retry-theme' }),
    profileId: 'default',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'theme',
      version: '1.0.0',
      digest: `sha256:${digestCharacter.repeat(64)}`,
      moduleGeneration,
      enabled: true,
      dependencies: [],
    }],
  }
}

export function setup() {
  let intensity = 'high'
  let reasoningState: 'active' | 'pending' = 'active'
  const dispatch = vi.fn(async (_id: string, args: Readonly<Record<string, unknown>>) => {
    intensity = String(args.value)
  })
  const active = new Set(['outer-v1', 'legacy-v1', 'overlay-v1', 'replace-v1', 'denied-v1'])
  const plugins = ['outer', 'legacy', 'overlay', 'replace', 'denied']
  const policies = new ControlledSurfacePolicyBroker(
    new MemoryControlledSurfacePolicyStore({
      schemaVersion: 1,
      principals: plugins.flatMap(pluginId =>
        (['explicit', 'legacy-structured'] as const).map(origin => ({
          handle: `principal:${pluginId}:${origin}`,
          source: `https://plugins.example/${pluginId}`,
          pluginId,
          origin,
        }))
      ),
      authorizations: [],
      choices: [],
    }),
  )
  const coordinator = new ControlledSurfaceCoordinator(
    catalog,
    {
      'model.overlay': {
        currentState: () => ({ state: 'active', reason: 'point.mounted' }),
        readProperty: () => null,
        dispatch: () => undefined,
      },
      'model.reasoning-intensity': {
        currentState: () => ({
          state: reasoningState,
          reason: reasoningState === 'active' ? 'point.mounted' : 'point.pending',
        }),
        readProperty: id => id === 'reasoningIntensity' ? intensity : null,
        commandAvailability: () => ({ available: true }),
        eventAvailability: () => ({ available: true }),
        dispatch,
      },
    },
    'host-1',
    policies,
    item => active.has(item.moduleGeneration ?? ''),
  )
  return {
    coordinator,
    policies,
    dispatch,
    active,
    intensity: () => intensity,
    setReasoningState: (state: 'active' | 'pending') => {
      reasoningState = state
    },
  }
}
