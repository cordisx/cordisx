import type { CordisXPermissionScopeV4 } from '../permission-contracts.js'
/** Usage is a local metadata provider, not a DOM extension point. */
export function usagePermissionAvailability(bridgePresent: boolean, scope: CordisXPermissionScopeV4) {
  const reason = {
    namespace: 'permission',
    key: bridgePresent ? 'permission.usage.available' : 'permission.usage.unavailable',
    fallback: bridgePresent
      ? 'Validated local Token usage is available with a generation-scoped grant.'
      : 'The local usage bridge is unavailable.',
  }
  return {
    status: bridgePresent ? 'supported' as const : 'unavailable' as const,
    reason,
    providers: bridgePresent
      ? [{
        providerId: 'host-local-usage',
        providerName: { namespace: 'permission', key: 'permission.usage.read.name', fallback: 'Local usage' },
        kind: 'host-local' as const,
        family: 'platform' as const,
        status: 'supported' as const,
        reason,
        scope,
      }]
      : [],
  }
}
