import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import type { DialogsV1 } from '@cordisx/protocol/dialogs/v1'
import { useContext, useEffect, useRef, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../plugin-lifecycle-contracts.js'
import { dialogCenterForDocument } from '../../dialogs/host.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import { notificationCenterForDocument } from '../../notifications/host.js'
import { productLocale } from '../../ui-copy.js'
import { StandalonePluginLifecycleContext } from './standalone-plugin-lifecycle.js'
import { reviewStandaloneLifecycle } from '../../standalone-lifecycle-review.js'
import {
  requestPluginAuthorizationV2,
  requestPluginAuthorizationV4,
  requestPluginAuthorizationV7,
} from '../permission-review.js'

export interface PluginLifecycleActions {
  readonly busyPluginId: string | undefined
  readonly operationsAvailable: boolean
  canRun(plugin: ManagerPluginSnapshot, operation: 'enable' | 'disable' | 'uninstall'): boolean
  run(plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1): Promise<void>
}

export function usePluginLifecycleActions(
  model: ManagerModel,
  snapshot: ManagerSnapshot,
): PluginLifecycleActions {
  const [busyPluginId, setBusyPluginId] = useState<string>()
  const standalone = useContext(StandalonePluginLifecycleContext)
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  const dialogs = useRef<DialogsV1 | undefined>(undefined)
  useEffect(() => {
    const notificationBinding = notificationCenterForDocument(document)?.bind({
      key: 'host/plugin-management',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    })
    const dialogBinding = dialogCenterForDocument(document)?.bind({
      key: 'host/plugin-management',
      name: () => 'CordisX',
      active: () => true,
      report: kind => {
        notificationBinding?.api.show({
          kind: `plugin.lifecycle.${kind}.failed`,
          type: 'error',
          message: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件操作失败' : 'Plugin operation failed',
        })
      },
    })
    notifications.current = notificationBinding?.api
    dialogs.current = dialogBinding?.api
    return () => {
      notifications.current = undefined
      dialogs.current = undefined
      dialogBinding?.dispose()
      notificationBinding?.dispose()
    }
  }, [snapshot.localization.locale])
  const operationsAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
    && model.requestPluginLifecycle !== undefined
  const reviewOptions = model.permissionReviewInWeb === true
    ? { sessionOnly: true, requireTrustedEvents: true }
    : undefined
  const canRun = (plugin: ManagerPluginSnapshot, operation: 'enable' | 'disable' | 'uninstall'): boolean => {
    if (standalone && !plugin.package) return false
    if (operationsAvailable) return true
    const management = standalone?.snapshot
    const item = management?.plugins.find(value => value.id === plugin.id)
    return !!standalone?.binding.planLifecycle && !!standalone.binding.executeLifecycle
      && !!plugin.package && !!snapshot.pluginLifecycle && management?.profileId === snapshot.pluginLifecycle.profileId
      && management.runtime.kind === 'active'
      && management.runtime.runtimeGeneration === snapshot.pluginLifecycle.runtimeGeneration
      && management.rendererLifecycleAccess === 'session-scoped-v1'
      && management.activationRevision === snapshot.pluginLifecycle.revision
      && !!item && item.version === plugin.package.version && item.digest === plugin.package.digest
      && item.moduleGeneration === plugin.package.moduleGeneration
      && item.canonicalSource === plugin.package.canonicalSource && item.availableOperations.includes(operation)
  }

  const run = async (plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1) => {
    setBusyPluginId(plugin.id)
    try {
      if (
        !operationsAvailable && standalone && (operation.kind === 'enable' || operation.kind === 'disable'
          || operation.kind === 'uninstall')
      ) {
        if (!canRun(plugin, operation.kind)) throw new Error('Plugin lifecycle operation is unavailable')
        const request = { kind: `plugin-${operation.kind}` as const, pluginId: plugin.id }
        const plan = await standalone.binding.planLifecycle!(request)
        if (plan.status !== 'planned' || plan.executionRequest?.kind !== 'plugin-execute-plan') {
          throw new Error('error' in plan ? plan.error.message : 'Plugin operation could not be planned')
        }
        if (operation.kind === 'disable' || operation.kind === 'uninstall') {
          const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
          const affected = (plan.affectedPluginIds ?? []).join(zh ? '、' : ', ') || plugin.name
          const confirmation = await dialogs.current?.confirm({
            kind: `plugin.lifecycle.${operation.kind}.confirm`,
            title: operation.kind === 'disable'
              ? (zh ? '确认禁用插件' : 'Disable plugin?')
              : (zh ? '确认卸载插件' : 'Uninstall plugin?'),
            description: zh ? `此操作会影响：${affected}。继续吗？` : `This action affects: ${affected}. Continue?`,
            confirmLabel: operation.kind === 'disable'
              ? (zh ? '禁用插件' : 'Disable plugin')
              : (zh ? '卸载' : 'Uninstall'),
            tone: 'danger',
            run: () => {},
          })
          if (confirmation?.status !== 'completed') return
        }
        let result = await standalone.binding.executeLifecycle!(plan.executionRequest, plan.snapshot.revision)
        if (result.status === 'permission-review-required' && operation.kind === 'enable') {
          const review = result.permissionPlan
          if (
            !standalone.binding.applyLifecycleReview || review.schemaVersion !== 7
            || result.request.kind !== 'plugin-enable' || result.request.pluginId !== plugin.id
            || review.identity.pluginId !== plugin.id || review.profileId !== snapshot.pluginLifecycle?.profileId
            || review.binding.runtimeGeneration !== snapshot.pluginLifecycle.runtimeGeneration
            || review.binding.requestId !== result.candidateId
            || result.snapshot.activationRevision !== snapshot.pluginLifecycle.revision
          ) throw new Error('Plugin permission review is unavailable')
          const choice = await reviewStandaloneLifecycle(
            document,
            { id: plugin.id, name: plugin.name, source: review.identity.source },
            review,
            snapshot.permissions.filter(item => item.identity.id === plugin.id),
            result.candidateId,
          )
          if (!choice) return
          result = await standalone.binding.applyLifecycleReview(
            result.candidateId,
            choice.decision,
            choice.proof,
            choice.requestId,
          )
        }
        if (result.status !== 'applied') {
          throw new Error('error' in result ? result.error.message : 'Plugin operation could not be completed')
        }
        return
      }
      if (model.requestPluginLifecycle === undefined) return
      let result = await model.requestPluginLifecycle(operation)
      if (
        (operation.kind === 'disable' || operation.kind === 'uninstall') && result.outcome === 'planned'
        && result.impactToken !== undefined
      ) {
        const separator = productLocale(snapshot.localization.locale) === 'zh-CN' ? '、' : ', '
        const affected = result.affectedPluginIds.join(separator) || plugin.name
        const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
        const confirmation = await dialogs.current?.confirm({
          kind: `plugin.lifecycle.${operation.kind}.confirm`,
          title: operation.kind === 'disable'
            ? (zh ? '确认禁用插件' : 'Disable plugin?')
            : (zh ? '确认卸载插件' : 'Uninstall plugin?'),
          description: zh
            ? `此操作会影响：${affected}。继续吗？`
            : `This action affects: ${affected}. Continue?`,
          confirmLabel: operation.kind === 'disable'
            ? (zh ? '禁用插件' : 'Disable plugin')
            : (zh ? '卸载' : 'Uninstall'),
          tone: 'danger',
          run: () => {},
        })
        if (confirmation?.status !== 'completed') return
        result = await model.requestPluginLifecycle({ ...operation, impactToken: result.impactToken })
      }
      if (operation.kind === 'enable' && result.outcome === 'planned') {
        const target = { kind: 'enable' as const, pluginId: plugin.id }
        const planV7 = await model.permissionLifecycleReviewPlanV7?.(target)
        const planV4 = planV7 === undefined ? await model.permissionLifecycleReviewPlanV4?.(target) : undefined
        const planV2 = planV7 === undefined && planV4 === undefined
          ? await model.permissionLifecycleReviewPlanV2?.(target)
          : undefined
        if (planV7 !== undefined) {
          if (model.applyPermissionLifecycleReviewV7 === undefined) {
            throw new Error('Permission review v7 is unavailable')
          }
          const decision = await requestPluginAuthorizationV7(
            document,
            { id: planV7.identity.pluginId, name: plugin.name, source: planV7.identity.source },
            planV7,
            snapshot.permissions.filter(item =>
              item.identity.id === planV7.identity.pluginId && item.identity.source === planV7.identity.source
            ),
            reviewOptions,
          )
          if (decision === undefined) return
          result = await model.applyPermissionLifecycleReviewV7(decision)
        } else if (planV4 !== undefined) {
          if (model.applyPermissionLifecycleReviewV4 === undefined) {
            throw new Error('Permission review v4 is unavailable')
          }
          const decision = await requestPluginAuthorizationV4(
            document,
            { id: planV4.identity.pluginId, name: plugin.name, source: planV4.identity.source },
            planV4,
            snapshot.permissions.filter(item =>
              item.identity.id === planV4.identity.pluginId && item.identity.source === planV4.identity.source
            ),
            reviewOptions,
          )
          if (decision === undefined) return
          result = await model.applyPermissionLifecycleReviewV4(decision)
        } else if (planV2 !== undefined) {
          if (model.applyPermissionLifecycleReviewV2 === undefined) {
            throw new Error('Permission review v2 is unavailable')
          }
          const decision = await requestPluginAuthorizationV2(
            document,
            { id: planV2.identity.pluginId, name: plugin.name, source: planV2.identity.source },
            planV2,
            snapshot.permissions.filter(item =>
              item.identity.id === planV2.identity.pluginId && item.identity.source === planV2.identity.source
            ),
            reviewOptions,
          )
          if (decision === undefined) return
          result = await model.applyPermissionLifecycleReviewV2(decision)
        } else {
          throw new Error('The Host will not enable this plugin without a modern permission review')
        }
        if (result.outcome !== 'applied') {
          throw new Error(result.error?.message ?? `Enable ended with ${result.outcome}`)
        }
      }
      if (result.error !== undefined) {
        notifications.current?.show({
          kind: `plugin.lifecycle.${operation.kind}.failed`,
          type: 'error',
          message: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件操作失败' : 'Plugin operation failed',
          description: result.error.message,
        })
      }
    } catch (error) {
      notifications.current?.show({
        kind: `plugin.lifecycle.${operation.kind}.failed`,
        type: 'error',
        message: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件操作失败' : 'Plugin operation failed',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyPluginId(undefined)
    }
  }

  return { busyPluginId, operationsAvailable, canRun, run }
}
