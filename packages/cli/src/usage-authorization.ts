import type { UsageReadCapabilityV1 } from '@cordisx/protocol/usage/v1'
import type {
  CordisXPermissionAuthorizationDecisionItemV4,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationItemV4,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionScopeV4,
} from './permission-contracts.js'
import { sha256Hex } from './permission-model-v2.js'
import { normalizeUsageDeclaration } from './usage-permissions.js'
export const USAGE_CAPABILITY = 'usage.read' as const
export const USAGE_PERMISSION_PLAN_SCHEMA_V6 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-plan.v6.schema.json' as const
export const USAGE_PERMISSION_DECISION_SCHEMA_V6 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v6.schema.json' as const
export type UsagePermissionScope = CordisXPermissionScopeV4 & UsageReadCapabilityV1['scope']
export interface UsagePermissionAuthorizationItemV6
  extends Omit<CordisXPermissionAuthorizationItemV4, 'capability' | 'scope'>
{
  readonly capability: typeof USAGE_CAPABILITY
  readonly scope: UsagePermissionScope
}
export interface UsagePermissionAuthorizationPlanV6
  extends Omit<CordisXPermissionAuthorizationPlanV4, '$schema' | 'schemaVersion' | 'declarations'>
{
  readonly $schema: typeof USAGE_PERMISSION_PLAN_SCHEMA_V6
  readonly schemaVersion: 6
  readonly declarations: readonly UsagePermissionAuthorizationItemV6[]
}
export interface UsagePermissionAuthorizationDecisionV6
  extends Omit<CordisXPermissionAuthorizationDecisionV4, '$schema' | 'schemaVersion' | 'decisions'>
{
  readonly $schema: typeof USAGE_PERMISSION_DECISION_SCHEMA_V6
  readonly schemaVersion: 6
  readonly decisions: readonly (Omit<CordisXPermissionAuthorizationDecisionItemV4, 'capability' | 'scope'> & {
    readonly capability: typeof USAGE_CAPABILITY
    readonly scope: UsagePermissionScope
  })[]
}
export function usagePermissionPlan(
  input: Omit<UsagePermissionAuthorizationPlanV6, '$schema' | 'schemaVersion' | 'declarations'>,
  declaration: UsageReadCapabilityV1,
): UsagePermissionAuthorizationPlanV6 {
  const normalized = normalizeUsageDeclaration(declaration)
  const message = (key: string, fallback: string) =>
    Object.freeze({ namespace: 'permission', key: `permission.usage.read.${key}`, fallback })
  return Object.freeze({
    ...input,
    $schema: USAGE_PERMISSION_PLAN_SCHEMA_V6,
    schemaVersion: 6,
    declarations: Object.freeze([Object.freeze({
      capability: USAGE_CAPABILITY,
      required: normalized.required,
      scope: normalized.scope,
      securityFingerprint: `sha256:${
        sha256Hex(JSON.stringify({ catalogVersion: input.catalogVersion, declaration: normalized }))
      }` as const,
      policy: 'ask' as const,
      decisionRequired: true,
      authorizationMode: 'explicit-user' as const,
      resourceClass: 'non-dom' as const,
      certifiedImplicitApproval: false,
      sensitivity: 'general' as const,
      persistentAllow: false,
      persistentDeny: false,
      allowedDecisions: Object.freeze(['allow-once', 'deny-once'] as const),
      defaultDecision: 'deny-once' as const,
      presentation: Object.freeze({
        name: message('name', 'Read local usage totals'),
        description: message(
          'description',
          'Read validated input and output Token totals observed in the current local profile.',
        ),
        risk: message('risk', 'The plugin can use aggregate local usage for its own features.'),
        limitation: message(
          'limitation',
          'No messages, credentials, raw paths or account billing totals. This access lasts for the current plugin generation.',
        ),
      }),
    })]),
  })
}
