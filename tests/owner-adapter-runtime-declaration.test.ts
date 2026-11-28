import { expect, it } from 'vitest'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 } from '../packages/cli/src/channel-exact-request-permissions.js'
import { ownerRuntimeDeclaration } from '../packages/cli/src/cli/owner-adapter-runtime-declaration.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../packages/cli/src/permission-contracts.js'
import {
  normalizePermissionPolicyRecordV2,
  permissionSecurityFingerprint,
} from '../packages/cli/src/permission-model-v2.js'

it('allows only one declared Channel exact-request target', () => {
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V16,
    schemaVersion: 16,
    id: 'example',
    services: [],
    capabilities: [{ name: 'channel.accounts.connect', required: false, scope: { runtime: 'exact-request' } }],
  }
  const record = (accounts: Array<{ adapterId: string; accountId: string }>) => {
    const declaration = {
      name: 'channel.accounts.connect' as const,
      required: false,
      scope: { channelAccounts: accounts },
    }
    return normalizePermissionPolicyRecordV2({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2,
      key: {
        profileId: 'default',
        identity: { pluginId: 'example', source: 'file:///fixture.js' },
        capability: declaration.name,
        scope: declaration.scope,
        securityFingerprint: permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, declaration),
      },
      policy: 'ask',
    })
  }
  const one = { adapterId: 'fixture', accountId: 'one' }
  expect(ownerRuntimeDeclaration({ manifest, pluginId: 'example', record: record([one]) })).toEqual({ exact: true })
  expect(() =>
    ownerRuntimeDeclaration({
      manifest,
      pluginId: 'example',
      record: record([one, { adapterId: 'fixture', accountId: 'two' }]),
    })
  ).toThrow()
})
