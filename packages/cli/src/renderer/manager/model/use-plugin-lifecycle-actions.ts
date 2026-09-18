import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import { useEffect, useRef, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../plugin-lifecycle-contracts.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import { notificationCenterForDocument } from '../../notifications/host.js'
import { productLocale } from '../../ui-copy.js'

export interface PluginLifecycleActions {
  readonly busyPluginId: string | undefined
  readonly operationsAvailable: boolean
  run(plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1): Promise<void>
}

export function usePluginLifecycleActions(
  model: ManagerModel,
  snapshot: ManagerSnapshot,
): PluginLifecycleActions {
  const [busyPluginId, setBusyPluginId] = useState<string>()
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  useEffect(() => {
    const binding = notificationCenterForDocument(document)?.bind({
      key: 'host/plugin-management',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    })
    notifications.current = binding?.api
    return () => {
      notifications.current = undefined
      binding?.dispose()
    }
  }, [])
  const operationsAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
    && model.requestPluginLifecycle !== undefined

  const run = async (plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1) => {
    if (model.requestPluginLifecycle === undefined) return
    setBusyPluginId(plugin.id)
    try {
      let result = await model.requestPluginLifecycle(operation)
      if (
        (operation.kind === 'disable' || operation.kind === 'uninstall') && result.outcome === 'planned'
        && result.impactToken !== undefined
      ) {
        const separator = productLocale(snapshot.localization.locale) === 'zh-CN' ? '、' : ', '
        const affected = result.affectedPluginIds.join(separator) || plugin.name
        const prompt = productLocale(snapshot.localization.locale) === 'zh-CN'
          ? `此操作会影响：${affected}。继续吗？`
          : `This action affects: ${affected}. Continue?`
        if (!window.confirm(prompt)) return
        result = await model.requestPluginLifecycle({ ...operation, impactToken: result.impactToken })
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

  return { busyPluginId, operationsAvailable, run }
}
