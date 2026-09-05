import { pathToFileURL } from 'node:url'
import type { JSDOM } from 'jsdom'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../../packages/cli/src/permission-contracts.js'
import { domPermissionAuthorizationKeyV3 } from '../../packages/cli/src/permission-model-v3.js'
import type { CordisXPersistedPermissionPolicyRecordV3 } from '../../packages/cli/src/permission-persistence.js'

export interface ExactDomPermissionFixture {
  readonly id: string
  readonly entry: string
  readonly pointIds: readonly string[]
}

export function exactDomPermissionPolicies(
  profileId: string,
  plugins: readonly ExactDomPermissionFixture[],
): readonly CordisXPersistedPermissionPolicyRecordV3[] {
  return plugins.flatMap(plugin =>
    plugin.pointIds.map(pointId => ({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
      schemaVersion: 3 as const,
      key: domPermissionAuthorizationKeyV3({
        profileId,
        identity: {
          source: pathToFileURL(plugin.entry).href,
          pluginId: plugin.id,
        },
        pointId,
        catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
      }),
      policy: 'allow-persistent' as const,
    }))
  )
}

export function installPermissionPolicyBridge(window: JSDOM['window']): void {
  Object.defineProperty(window, '__cordisxPermissionPolicyRequestV1', {
    configurable: true,
    value: (payload: string) => {
      const request = JSON.parse(payload) as { requestId: string; records: readonly unknown[] }
      queueMicrotask(() => {
        const receiver = (window as unknown as {
          __cordisxPermissionPolicyReceiveV1?: (response: string) => void
        }).__cordisxPermissionPolicyReceiveV1
        receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value: request.records }))
      })
    },
  })
}
