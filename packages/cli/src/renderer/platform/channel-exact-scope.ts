import type { PluginManifestChannelExactCapabilityNameV16 } from '@cordisx/protocol/plugin-manifest/v16'
import { normalizePermissionScopeV2 } from '../../permission-model-v2.js'
import type { CordisXPermissionScopeV2 } from '../../permission-contracts.js'
import type { RequestedScope } from './platform-permission-store.js'

/** Host-internal target from the same validated credential/connection/binding used for dispatch. */
export function materializeChannelExactScope(
  capability: PluginManifestChannelExactCapabilityNameV16,
  requested: RequestedScope,
): CordisXPermissionScopeV2 | undefined {
  const target = requested.channelTenant ?? requested.channelAccount
  if (!target) return undefined
  try {
    if (capability === 'channel.accounts.connect') {
      return normalizePermissionScopeV2({
        channelAccounts: [{ adapterId: target.adapterId, accountId: target.accountId }],
      })
    }
    return requested.channelTenant === undefined
      ? undefined
      : normalizePermissionScopeV2({ channelTenants: [requested.channelTenant] })
  } catch {
    return undefined
  }
}
