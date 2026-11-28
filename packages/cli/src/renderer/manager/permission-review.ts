import type { CordisXLocalizedText, CordisXPluginIdentity } from '../../contracts.js'
import { CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V4 } from '../../permission-contracts.js'
import {
  assertDeferredPermissionDecision,
  type DeferredPermissionDecision,
  type DeferredPermissionPlan,
  noDeferredPermissionDecision,
} from '../../permission-deferral.js'
import { PermissionAuthorizationViewModel } from '../../permission-authorization-view-model.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationItemV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV4,
} from '../../permission-contracts.js'
import { BrowserPermissionAuthorizationPromptV2 } from '../platform/platform-permission-store.js'
import type { ManagerPermissionSnapshot, ManagerPluginSnapshot } from '../manager.js'

type ReviewPlan = CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4
type ReviewOptions = { readonly sessionOnly?: boolean; readonly requireTrustedEvents?: boolean }

function permissionAvailability(
  plan: ReviewPlan,
  permissions: readonly ManagerPermissionSnapshot[],
) {
  return Object.fromEntries(plan.declarations.flatMap(declaration => {
    const permission = permissions.find(item => item.capability === declaration.capability)
    if (permission === undefined) return []
    return [[
      declaration.capability,
      Object.freeze({
        status: permission.availability.status,
        reason: Object.freeze({
          namespace: 'cordisx.permission.host',
          key: `availability.${declaration.capability}`,
          fallback: permission.availability.reasonText,
        }) satisfies CordisXLocalizedText,
        providerIds: Object.freeze(permission.availability.providers.map(provider => provider.providerId)),
      }),
    ]]
  })) as Partial<
    Record<CordisXPermissionCapabilityV4, {
      readonly status: 'supported' | 'degraded' | 'unavailable'
      readonly reason: CordisXLocalizedText
      readonly providerIds: readonly string[]
    }>
  >
}

function prompt(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: ReviewPlan,
  permissions: readonly ManagerPermissionSnapshot[],
  options: ReviewOptions,
): BrowserPermissionAuthorizationPromptV2 {
  const availability = permissionAvailability(plan, permissions)
  return new BrowserPermissionAuthorizationPromptV2(document, (_current, identity) => ({
    plugin: { name: plugin.name, source: identity.source, trust: 'configured' },
    availability,
    resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
    scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
    requestSource: identity.source,
  }), options)
}

function identity(plugin: Pick<ManagerPluginSnapshot, 'id' | 'source'>): CordisXPluginIdentity {
  return Object.freeze({ id: plugin.id, source: plugin.source })
}

export async function requestPluginAuthorizationV2(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV2,
  permissions: readonly ManagerPermissionSnapshot[],
  options: ReviewOptions = {},
): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
  if (plan.declarations.length === 0) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }
  const authorization = prompt(document, plugin, plan, permissions, options)
  try {
    return await authorization.request(plan, identity(plugin))
  } finally {
    authorization.dispose()
  }
}

export async function requestPluginAuthorizationV4(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV4,
  permissions: readonly ManagerPermissionSnapshot[],
  options: ReviewOptions = {},
): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
  if (!plan.declarations.some(item => item.decisionRequired)) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }
  const authorization = prompt(document, plugin, plan, permissions, options)
  try {
    return await authorization.requestV4(plan, identity(plugin))
  } finally {
    authorization.dispose()
  }
}

/** Present only undecided required entries; the complete v7 plan remains the apply authority. */
export async function requestPluginAuthorizationV7(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: DeferredPermissionPlan,
  permissions: readonly ManagerPermissionSnapshot[],
  options: ReviewOptions = {},
): Promise<DeferredPermissionDecision | undefined> {
  const pending = plan.declarations.filter((item): item is CordisXPermissionAuthorizationItemV4 =>
    item.decisionRequired && item.authorizationMode !== 'deferred'
  )
  if (pending.length === 0) return noDeferredPermissionDecision(plan)
  const review: CordisXPermissionAuthorizationPlanV4 = {
    ...plan,
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V4,
    schemaVersion: 4,
    declarations: pending,
  }
  const choice = await requestPluginAuthorizationV4(document, plugin, review, permissions, options)
  if (choice === undefined) return undefined
  const result: DeferredPermissionDecision = {
    ...choice,
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
  }
  assertDeferredPermissionDecision(plan, result)
  return result
}
