import {
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPluginManifestV4,
} from '../../packages/cli/src/permission-contracts.js'
import { sha256Hex } from '../../packages/cli/src/permission-model-v2.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  type PermissionAuthorizationPromptV2,
  PermissionBroker,
  type PermissionPrompt,
} from '../../packages/cli/src/renderer/platform.js'

export const identity = { source: 'https://plugins.example/certified-dom', id: 'certified-dom' } as const

export const digest = `sha256:${'a'.repeat(64)}` as const

export const legacyPrompt: PermissionPrompt = { request: async () => 'deny' }

export function manifest(capabilities: CordisXPluginManifestV4['capabilities'] = []): CordisXPluginManifestV4 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: identity.id,
    capabilities,
    services: [],
  }, identity.id) as CordisXPluginManifestV4
}

export function certification(
  overrides: Partial<CordisXCertifiedPermissionProjectionV1> = {},
): CordisXCertifiedPermissionProjectionV1 {
  const payload = {
    source: identity.source,
    pluginId: identity.id,
    version: '1.2.3',
    integrity: digest,
    reviewPolicy: { id: 'cordisx-marketplace-review' as const, version: '1.0.0' },
    reviewedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    evidence: {
      kind: 'protected-marketplace-review' as const,
      reference: 'https://github.com/cordisx/marketplace/pull/123',
    },
    feed: {
      generatedAt: '2026-08-30T00:00:00.000Z',
      root: 'https://marketplace.example/feed.json',
      authority: 'cordisx.marketplace.codeowners/v1' as const,
    },
  }
  return {
    $schema: CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
    schemaVersion: 1,
    kind: 'cordisx-certified-permission-eligibility',
    status: 'active',
    ...payload,
    fingerprint: `sha256:${sha256Hex(JSON.stringify(payload))}`,
    revision: payload.feed.generatedAt,
    ...overrides,
  }
}

export function explicitV3(
  plan: CordisXPermissionAuthorizationPlanV3,
  choice: CordisXPermissionAuthorizationDecisionV3['decisions'][number]['decision'],
): CordisXPermissionAuthorizationDecisionV3 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
    schemaVersion: 3,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: choice,
    })),
  }
}

export function explicitV2(plan: CordisXPermissionAuthorizationPlanV2): CordisXPermissionAuthorizationDecisionV2 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once',
    })),
  }
}

export function broker(input: {
  readonly certified?: CordisXCertifiedPermissionProjectionV1
  readonly domChoice?: CordisXPermissionAuthorizationDecisionV3['decisions'][number]['decision']
  readonly store?: MemoryPermissionPolicyStore
  readonly profile?: string
  readonly generation?: string
  readonly moduleGeneration?: string
  readonly capabilities?: CordisXPluginManifestV4['capabilities']
  readonly now?: () => Date
}) {
  let domPrompts = 0
  let nonDomPrompts = 0
  const prompt: PermissionAuthorizationPromptV2 = {
    request: async (plan) => {
      nonDomPrompts += 1
      return explicitV2(plan)
    },
    requestV3: async (plan) => {
      domPrompts += 1
      return explicitV3(plan, input.domChoice ?? 'allow-once')
    },
  }
  const value = new PermissionBroker(
    input.store ?? new MemoryPermissionPolicyStore(),
    legacyPrompt,
    input.now ?? (() => new Date('2026-08-30T12:00:00.000Z')),
    100,
    input.profile ?? 'work',
    input.generation ?? 'runtime-1',
    undefined,
    undefined,
    prompt,
  )
  if (input.certified !== undefined) {
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [input.certified] })
  }
  const unregister = value.register(
    identity,
    manifest(input.capabilities),
    { pluginId: identity.id, moduleGeneration: input.moduleGeneration ?? 'module-1' },
    undefined,
    { version: '1.2.3', integrity: digest },
  )
  return { value, unregister, domPrompts: () => domPrompts, nonDomPrompts: () => nonDomPrompts }
}
