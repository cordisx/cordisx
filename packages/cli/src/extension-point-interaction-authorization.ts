import type { ExtensionPointInteractionCapabilityV1 } from '@cordisx/protocol/extension-point-visual/v1'
import type {
  CordisXPermissionAuthorizationDecisionItemV4,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationItemV4,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionScopeV4,
} from './permission-contracts.js'
import { sha256Hex } from './permission-model-v2.js'
import { normalizeInteractionDeclaration } from './extension-point-interaction-permissions.js'
export const INTERACTION_CAPABILITY = 'ui.extension-points.interact' as const
export const VISUAL_PERMISSION_PLAN_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-plan.v5.schema.json' as const
export const VISUAL_PERMISSION_DECISION_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v5.schema.json' as const
export type VisualPermissionScope = CordisXPermissionScopeV4 & ExtensionPointInteractionCapabilityV1['scope']
export interface VisualPermissionAuthorizationItemV5
  extends Omit<CordisXPermissionAuthorizationItemV4, 'capability' | 'scope'>
{
  readonly capability: typeof INTERACTION_CAPABILITY
  readonly scope: VisualPermissionScope
}
export interface VisualPermissionAuthorizationPlanV5
  extends Omit<CordisXPermissionAuthorizationPlanV4, '$schema' | 'schemaVersion' | 'declarations'>
{
  readonly $schema: typeof VISUAL_PERMISSION_PLAN_SCHEMA_V5
  readonly schemaVersion: 5
  readonly declarations: readonly VisualPermissionAuthorizationItemV5[]
}
export interface VisualPermissionAuthorizationDecisionV5
  extends Omit<CordisXPermissionAuthorizationDecisionV4, '$schema' | 'schemaVersion' | 'decisions'>
{
  readonly $schema: typeof VISUAL_PERMISSION_DECISION_SCHEMA_V5
  readonly schemaVersion: 5
  readonly decisions: readonly (Omit<CordisXPermissionAuthorizationDecisionItemV4, 'capability' | 'scope'> & {
    readonly capability: typeof INTERACTION_CAPABILITY
    readonly scope: VisualPermissionScope
  })[]
}
export function visualInteractionPlan(
  input: Omit<VisualPermissionAuthorizationPlanV5, '$schema' | 'schemaVersion' | 'declarations'>,
  declaration: ExtensionPointInteractionCapabilityV1,
): VisualPermissionAuthorizationPlanV5 {
  const normalized = normalizeInteractionDeclaration(declaration)
  const message = (key: string, fallback: string) =>
    Object.freeze({ namespace: 'permission', key: `permission.ui.extension-points.interact.${key}`, fallback })
  return Object.freeze({
    ...input,
    $schema: VISUAL_PERMISSION_PLAN_SCHEMA_V5,
    schemaVersion: 5,
    declarations: Object.freeze([Object.freeze({
      capability: INTERACTION_CAPABILITY,
      required: normalized.required,
      scope: normalized.scope,
      securityFingerprint: `sha256:${
        sha256Hex(JSON.stringify({ catalogVersion: input.catalogVersion, declaration: normalized }))
      }` as const,
      policy: 'ask' as const,
      decisionRequired: true,
      authorizationMode: 'explicit-user' as const,
      resourceClass: 'dom-rendering' as const,
      certifiedImplicitApproval: false,
      sensitivity: 'general' as const,
      persistentAllow: false,
      persistentDeny: false,
      allowedDecisions: Object.freeze(['allow-once', 'deny-once'] as const),
      defaultDecision: 'deny-once' as const,
      presentation: Object.freeze({
        name: message('name', 'Observe pointer in visual extension points'),
        description: message('description', 'Receive normalized pointer position in the listed visual seats.'),
        risk: message('risk', 'The plugin can react to pointer movement while its visual is active.'),
        limitation: message(
          'limitation',
          'No input text, raw events, native handlers or native action control. Permission lasts for this plugin generation.',
        ),
      }),
    })]),
  })
}
