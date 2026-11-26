import { createContext, createElement, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { CordisXPluginLifecycleResultV1 } from '../../../plugin-lifecycle-contracts.js'
import type { MarketplaceCatalogPlugin } from '../../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import type { PluginManagementRequest, PluginManagementSnapshot } from '../../../management/contracts.js'
import type { PluginManagementBinding } from '../../management-binding.js'
import { productLocale } from '../../ui-copy.js'
import { notificationCenterForDocument } from '../../notifications/host.js'
import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import {
  requestPluginAuthorizationV2,
  requestPluginAuthorizationV4,
  requestPluginAuthorizationV7,
} from '../permission-review.js'

export interface MarketplaceInstallCopy {
  readonly failed: string
  readonly succeeded: string
}

export interface MarketplaceInstaller {
  readonly available: boolean
  readonly installingIdentity: string | undefined
  readonly cancellable: boolean
  run(plugin: MarketplaceCatalogPlugin, name: string): Promise<void>
  cancel(): void
}

const MarketplaceInstallerContext = createContext<MarketplaceInstaller | undefined>(undefined)

function sameSelection(
  request: PluginManagementRequest,
  selection: Extract<PluginManagementRequest, { readonly kind: 'plugin-plan-marketplace' }>,
): boolean {
  return request.kind === 'plugin-plan-marketplace' && request.pluginId === selection.pluginId
    && request.sourceUrl === selection.sourceUrl && request.version === selection.version
    && request.expectedCanonicalSource === selection.expectedCanonicalSource
    && request.expectedArtifactIntegrity === selection.expectedArtifactIntegrity
}

function installationError(error: { readonly code: string; readonly message: string }, locale: string): string {
  if (productLocale(locale) !== 'zh-CN') return error.message
  const messages: Readonly<Record<string, string>> = {
    'permission-review-unavailable': '该插件需要权限审核，独立管理页暂不支持此操作。',
    'catalog-unavailable': '插件商店来源暂时不可用。',
    'catalog-selection-changed': '插件商店信息已变化，请刷新后重试。',
    'artifact-inspection-failed': '插件制品下载或校验失败，请重试。',
  }
  return messages[error.code] ?? error.message
}

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
  options: {
    readonly document?: Document
    readonly feedbackActive?: boolean
    readonly standalone?: {
      readonly binding: PluginManagementBinding
      readonly snapshot: PluginManagementSnapshot | undefined
    }
  } = {},
): MarketplaceInstaller {
  const [installingIdentity, setInstallingIdentity] = useState<string | undefined>(undefined)
  const [cancellable, setCancellable] = useState(false)
  const cancellableRef = useRef(false)
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
  const nativeAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
    && manager.inspectMarketplaceArtifact !== undefined
    && manager.requestPluginLifecycle !== undefined
  const standalone = options.standalone
  const management = standalone?.snapshot
  const lifecycle = snapshot.pluginLifecycle
  const standaloneAvailable = !!standalone?.binding.planLifecycle && !!standalone.binding.executeLifecycle
    && !!management && !!lifecycle && management.profileId === lifecycle.profileId
    && management.runtime.kind === 'active' && management.runtime.runtimeGeneration === lifecycle.runtimeGeneration
    && management.activationRevision === lifecycle.revision
    && management.rendererLifecycleAccess === 'session-scoped-v1'
  const available = nativeAvailable || standaloneAvailable
  const updateCancellable = (value: boolean) => {
    cancellableRef.current = value
    setCancellable(value)
  }
  return {
    available,
    installingIdentity,
    cancellable,
    cancel: () => {
      if (cancellableRef.current) controller.current?.abort()
    },
    run: async (plugin, name) => {
      if (plugin.artifact === undefined || !available) return
      if (controller.current !== undefined) return
      const request = new AbortController()
      const feedbackSessionId = notificationSession.current?.id
      controller.current = request
      setInstallingIdentity(plugin.identity)
      updateCancellable(true)
      try {
        if (!nativeAvailable && standaloneAvailable && standalone && management && lifecycle) {
          const selection = {
            kind: 'plugin-plan-marketplace' as const,
            pluginId: plugin.id,
            sourceUrl: plugin.feedUrl,
            version: plugin.version,
            expectedCanonicalSource: plugin.source,
            expectedArtifactIntegrity: plugin.artifact.integrity,
          }
          const plan = await standalone.binding.planLifecycle!(selection)
          if (request.signal.aborted) return
          if (
            plan.status !== 'planned' || plan.executionRequest?.kind !== 'plugin-execute-plan'
            || plan.snapshot.profileId !== lifecycle.profileId
            || plan.snapshot.activationRevision !== lifecycle.revision
            || plan.snapshot.runtime.kind !== 'active'
            || plan.snapshot.runtime.runtimeGeneration !== lifecycle.runtimeGeneration
            || plan.snapshot.rendererLifecycleAccess !== 'session-scoped-v1'
            || !sameSelection(plan.request, selection)
          ) {
            throw new Error(
              'error' in plan
                ? installationError(plan.error, snapshot.localization.locale)
                : 'Plugin installation could not be planned',
            )
          }
          // Once dispatched, the owner may commit; cancellation cannot promise rollback.
          updateCancellable(false)
          const result = await standalone.binding.executeLifecycle!(plan.executionRequest, plan.snapshot.revision)
          if (
            result.status !== 'applied' || result.pendingActivation
            || !sameSelection(result.request, selection)
            || !result.snapshot.plugins.some(item =>
              item.id === plugin.id && item.version === plugin.version && item.enabled
            )
          ) {
            throw new Error(
              'error' in result
                ? installationError(result.error, snapshot.localization.locale)
                : 'Plugin installation was not confirmed',
            )
          }
          const session = notificationSession.current
          if (session !== undefined && session.id === feedbackSessionId) {
            session.api.show({ kind: 'marketplace.install.succeeded', type: 'success', message: copy.succeeded })
          }
          return
        }
        if (manager.inspectMarketplaceArtifact === undefined) throw new Error('Plugin installation is unavailable')
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
        const planV7 = await manager.permissionLifecycleReviewPlanV7?.(target)
        const planV4 = planV7 === undefined ? await manager.permissionLifecycleReviewPlanV4?.(target) : undefined
        const planV2 = planV7 === undefined && planV4 === undefined
          ? await manager.permissionLifecycleReviewPlanV2?.(target)
          : undefined
        let result: CordisXPluginLifecycleResultV1 | undefined
        if (planV7 !== undefined) {
          if (manager.applyPermissionLifecycleReviewV7 === undefined) {
            throw new Error('Permission review v7 is unavailable')
          }
          const decision = await requestPluginAuthorizationV7(
            ownerDocument,
            { id: plugin.id, name, source: planV7.identity.source },
            planV7,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === planV7.identity.source
            ),
          )
          if (decision === undefined) return
          result = await manager.applyPermissionLifecycleReviewV7(decision)
        } else if (planV4 !== undefined) {
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
          updateCancellable(false)
        }
      }
    },
  }
}
