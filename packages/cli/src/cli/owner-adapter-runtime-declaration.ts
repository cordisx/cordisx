import type { CordisXCapabilityDeclarationV2, CordisXPermissionPolicyRecordV2 } from '../permission-contracts.js'
import { CapabilityRiskCatalog, CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { isChannelExactRequestDeclaration } from '../channel-exact-request-permissions.js'
import { normalizePermissionScopeV2, permissionSecurityFingerprint } from '../permission-model-v2.js'
import { isRuntimeExactRequestDeclaration } from '../runtime-exact-request-permissions.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { normalizePluginManifest } from '../renderer/platform/platform-manifest.js'
import { manifestDeclarationsV2 } from '../renderer/platform/platform-permission-types.js'
import { normalizeAbsoluteCwd } from '../renderer/platform/platform-runtime-exact-scope.js'

const runtimeCatalog = new CapabilityRiskCatalog()

/** Persistent policies cover only complete manifest declarations, never dynamic targets. */
export function ownerDeclaredRuntimePolicy(input: {
  readonly manifest: unknown
  readonly pluginId: string
  readonly record: CordisXPermissionPolicyRecordV2
}): boolean {
  try {
    if (ownerRuntimeDeclaration(input).exact) return false
    const risk = runtimeCatalog.get(input.record.key.capability)
    return (input.record.policy !== 'allow-persistent' || risk.persistentAllow)
      && (input.record.policy !== 'deny-persistent' || risk.persistentDeny)
  } catch {
    return false
  }
}

/** Match only a current declared capability or a single concrete exact-request target. */
export function ownerRuntimeDeclaration(input: {
  readonly manifest: unknown
  readonly pluginId: string
  readonly record: CordisXPermissionPolicyRecordV2
}): { readonly exact: boolean } {
  const invalid = (): never => {
    throw new Error('adapter-permission-unavailable')
  }
  const manifest = normalizePluginManifest(input.manifest, input.pluginId)
  if (manifest.schemaVersion === 1) return invalid()
  const record = input.record
  let declaration = manifestDeclarationsV2(manifest).find(item => item.name === record.key.capability)
  let exact = false
  if (!declaration) {
    const requested = manifest.capabilities.find(item =>
      item.name === record.key.capability
      && (isRuntimeExactRequestDeclaration(item) || isChannelExactRequestDeclaration(item))
    )
    if (!requested) return invalid()
    const scope = normalizePermissionScopeV2(record.key.scope)
    const keys = Object.keys(scope)
    const capability = record.key.capability
    const valid = capability === 'tasks.create'
      ? keys.length === 2 && scope.providers?.length === 1 && scope.cwdRoots?.length === 1
        && (normalizeAbsoluteCwd(scope.cwdRoots[0], 'posix') === scope.cwdRoots[0]
          || normalizeAbsoluteCwd(scope.cwdRoots[0], 'win32') === scope.cwdRoots[0])
      : ['tasks.content.read', 'tasks.control', 'turns.submit', 'turns.control'].includes(capability)
      ? keys.length === 1 && scope.sessions?.length === 1
      : capability === 'channel.accounts.connect'
      ? keys.length === 1 && scope.channelAccounts?.length === 1
      : capability === 'channel.bindings.write'
      ? keys.length === 1 && scope.channelTenants?.length === 1
      : false
    if (!valid) return invalid()
    declaration = { name: capability, required: false, scope } satisfies CordisXCapabilityDeclarationV2
    exact = true
  }
  if (
    !attachmentEqual(normalizePermissionScopeV2(declaration.scope), record.key.scope)
    || permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, declaration) !== record.key.securityFingerprint
  ) return invalid()
  return { exact }
}
