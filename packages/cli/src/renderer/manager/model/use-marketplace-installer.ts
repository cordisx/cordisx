import { useEffect, useRef, useState } from 'react'
import type { CordisXPluginLifecycleResultV1 } from '../../../plugin-lifecycle-contracts.js'
import type { MarketplaceCatalogPlugin } from '../../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { notificationCenterForDocument } from '../../notifications/host.js'
import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import { requestPluginAuthorizationV2, requestPluginAuthorizationV4 } from '../permission-review.js'

export interface MarketplaceInstallCopy {
  readonly failed: string
  readonly succeeded: string
}

export interface MarketplaceInstaller {
  readonly available: boolean
  readonly installingIdentity: string | undefined
  run(plugin: MarketplaceCatalogPlugin, name: string): Promise<void>
  cancel(): void
}

export function useMarketplaceInstaller(
  manager: ManagerModel,
  snapshot: ManagerSnapshot,
  copy: MarketplaceInstallCopy,
): MarketplaceInstaller {
  const [installingIdentity, setInstallingIdentity] = useState<string | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  useEffect(() => {
    const binding = notificationCenterForDocument(document)?.bind({
      key: 'host/marketplace',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX Marketplace' }),
    })
    notifications.current = binding?.api
    return () => {
      controller.current?.abort()
      notifications.current = undefined
      binding?.dispose()
    }
  }, [])
  const available = snapshot.pluginLifecycle?.operationsAvailable === true
    && manager.inspectMarketplaceArtifact !== undefined
    && manager.requestPluginLifecycle !== undefined
  return {
    available,
    installingIdentity,
    cancel: () => controller.current?.abort(),
    run: async (plugin, name) => {
      if (plugin.artifact === undefined || manager.inspectMarketplaceArtifact === undefined) return
      controller.current?.abort()
      const request = new AbortController()
      controller.current = request
      setInstallingIdentity(plugin.identity)
      try {
        const inspection = await manager.inspectMarketplaceArtifact({
          pluginId: plugin.id,
          version: plugin.version,
          canonicalSource: plugin.source,
          artifact: plugin.artifact,
        }, request.signal)
        if (
          inspection.outcome !== 'planned' || inspection.candidateId === undefined || inspection.package === undefined
          || (inspection.operation !== 'install' && inspection.operation !== 'update')
          || inspection.package.id !== plugin.id || inspection.package.version !== plugin.version
          || inspection.package.canonicalSource !== plugin.source
        ) {
          throw new Error(
            inspection.error?.message ?? 'Marketplace artifact inspection did not produce a valid candidate',
          )
        }
        const target = { kind: 'candidate' as const, candidateId: inspection.candidateId }
        const planV4 = await manager.permissionLifecycleReviewPlanV4?.(target)
        const planV2 = planV4 === undefined ? await manager.permissionLifecycleReviewPlanV2?.(target) : undefined
        let result: CordisXPluginLifecycleResultV1 | undefined
        if (planV4 !== undefined) {
          if (manager.applyPermissionLifecycleReviewV4 === undefined) {
            throw new Error('Permission review v4 is unavailable')
          }
          const decision = await requestPluginAuthorizationV4(
            document,
            { id: plugin.id, name, source: planV4.identity.source },
            planV4,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === planV4.identity.source
            ),
          )
          if (decision === undefined) return
          result = await manager.applyPermissionLifecycleReviewV4(decision)
        } else if (planV2 !== undefined) {
          if (manager.applyPermissionLifecycleReviewV2 === undefined) {
            throw new Error('Permission review v2 is unavailable')
          }
          const decision = await requestPluginAuthorizationV2(
            document,
            { id: plugin.id, name, source: planV2.identity.source },
            planV2,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === planV2.identity.source
            ),
          )
          if (decision === undefined) return
          result = await manager.applyPermissionLifecycleReviewV2(decision)
        } else {
          throw new Error('The Host will not install this package without a modern permission review')
        }
        if (result === undefined || result.outcome !== 'applied') {
          throw new Error(result?.error?.message ?? `Installation ended with ${result?.outcome ?? 'no result'}`)
        }
        notifications.current?.show({
          kind: 'marketplace.install.succeeded',
          type: 'success',
          message: copy.succeeded,
        })
      } catch (error) {
        if (request.signal.aborted) return
        notifications.current?.show({
          kind: 'marketplace.install.failed',
          type: 'error',
          message: copy.failed,
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (controller.current === request) {
          controller.current = undefined
          setInstallingIdentity(undefined)
        }
      }
    },
  }
}
