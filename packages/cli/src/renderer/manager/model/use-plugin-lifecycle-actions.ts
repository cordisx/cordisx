import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import type { DialogsV1 } from '@cordisx/protocol/dialogs/v1'
import { useEffect, useRef, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../plugin-lifecycle-contracts.js'
import { dialogCenterForDocument } from '../../dialogs/host.js'
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
