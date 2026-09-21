import { createContext, createElement, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
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

const MarketplaceInstallerContext = createContext<MarketplaceInstaller | undefined>(undefined)

export function MarketplaceInstallerProvider(
  { installer, children }: { readonly installer: MarketplaceInstaller; readonly children: ReactNode },
) {
  return createElement(MarketplaceInstallerContext.Provider, { value: installer }, children)
}

export function useManagerMarketplaceInstaller(
  manager: ManagerModel,
  snapshot: ManagerSnapshot,
  copy: MarketplaceInstallCopy,
): MarketplaceInstaller {
  const installer = useContext(MarketplaceInstallerContext)
  const local = useMarketplaceInstaller(manager, snapshot, copy, { feedbackActive: installer === undefined })
  return installer ?? local
}

export function useMarketplaceInstaller(
  manager: ManagerModel,
  snapshot: ManagerSnapshot,
  copy: MarketplaceInstallCopy,
  options: { readonly document?: Document; readonly feedbackActive?: boolean } = {},
): MarketplaceInstaller {
  const [installingIdentity, setInstallingIdentity] = useState<string | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const notificationSession = useRef<{ readonly id: number; readonly api: NotificationsV1 } | undefined>(undefined)
  const notificationSequence = useRef(0)
  const ownerDocument = options.document ?? document
  const feedbackActive = options.feedbackActive ?? true
  // Installation survives Manager close; only its transient feedback belongs to an open session.
  useEffect(() => {
    if (!feedbackActive) return
    const id = ++notificationSequence.current
    const binding = notificationCenterForDocument(ownerDocument)?.bind({
      key: 'host/marketplace',
      pluginId: 'cordisx',
      active: () => notificationSession.current?.id === id,
      presentation: () => ({ name: 'CordisX Marketplace' }),
    })
    if (binding !== undefined) notificationSession.current = { id, api: binding.api }
    return () => {
      if (notificationSession.current?.id === id) notificationSession.current = undefined
      binding?.dispose()
    }
  }, [feedbackActive, ownerDocument])
  useEffect(() => () => controller.current?.abort(), [])
  const available = snapshot.pluginLifecycle?.operationsAvailable === true
    && manager.inspectMarketplaceArtifact !== undefined
    && manager.requestPluginLifecycle !== undefined
  return {
    available,
    installingIdentity,
    cancel: () => controller.current?.abort(),
    run: async (plugin, name) => {
      if (plugin.artifact === undefined || manager.inspectMarketplaceArtifact === undefined) return
      if (controller.current !== undefined) return
      const request = new AbortController()
      const feedbackSessionId = notificationSession.current?.id
      controller.current = request
      setInstallingIdentity(plugin.identity)
      try {
        const inspection = await manager.inspectMarketplaceArtifact({
          schemaVersion: plugin.schemaVersion as 3 | 4 | 5 | 6 | 7 | 8,
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
            ownerDocument,
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
            ownerDocument,
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
        const session = notificationSession.current
        if (session !== undefined && session.id === feedbackSessionId) {
          session.api.show({
            kind: 'marketplace.install.succeeded',
            type: 'success',
            message: copy.succeeded,
          })
        }
      } catch (error) {
        if (request.signal.aborted) return
        const session = notificationSession.current
        if (session !== undefined && session.id === feedbackSessionId) {
          session.api.show({
            kind: 'marketplace.install.failed',
            type: 'error',
            message: copy.failed,
            description: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        if (controller.current === request) {
          controller.current = undefined
          setInstallingIdentity(undefined)
        }
      }
    },
  }
}
