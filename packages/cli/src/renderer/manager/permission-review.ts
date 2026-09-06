import type { CordisXLocalizedText, CordisXPluginIdentity } from '../../contracts.js'
import { PermissionAuthorizationViewModel } from '../../permission-authorization-view-model.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV4,
} from '../../permission-contracts.js'
import { BrowserPermissionAuthorizationPromptV2 } from '../platform/platform-permission-store.js'
import type { ManagerPermissionSnapshot, ManagerPluginSnapshot } from '../manager.js'

type ReviewPlan = CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4

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
): BrowserPermissionAuthorizationPromptV2 {
  const availability = permissionAvailability(plan, permissions)
  return new BrowserPermissionAuthorizationPromptV2(document, (_current, identity) => ({
    plugin: { name: plugin.name, source: identity.source, trust: 'configured' },
    availability,
    resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
    scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
    requestSource: identity.source,
  }))
}

function identity(plugin: Pick<ManagerPluginSnapshot, 'id' | 'source'>): CordisXPluginIdentity {
  return Object.freeze({ id: plugin.id, source: plugin.source })
}

export async function requestPluginAuthorizationV2(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV2,
  permissions: readonly ManagerPermissionSnapshot[],
): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
  if (plan.declarations.length === 0) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }
  const authorization = prompt(document, plugin, plan, permissions)
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
): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
  if (!plan.declarations.some(item => item.decisionRequired)) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }
  const authorization = prompt(document, plugin, plan, permissions)
  try {
    return await authorization.requestV4(plan, identity(plugin))
  } finally {
    authorization.dispose()
  }
}
