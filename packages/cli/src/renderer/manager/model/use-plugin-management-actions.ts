import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import { useEffect, useRef, useState } from 'react'
import type { PluginManagementConfigRequest, PluginManagementSnapshot } from '../../../management/contracts.js'
import { notificationCenterForDocument } from '../../notifications/host.js'
import { productLocale } from '../../ui-copy.js'
import type { ManagerPluginManagementBinding } from './plugin-management.js'

export function usePluginManagementActions(
  binding: ManagerPluginManagementBinding | undefined,
  snapshot: PluginManagementSnapshot | undefined,
  locale: string,
) {
  const [busyKey, setBusyKey] = useState<string>()
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  useEffect(() => {
    const owner = notificationCenterForDocument(document)?.bind({
      key: 'host/plugin-management-config',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    })
    notifications.current = owner?.api
    return () => {
      notifications.current = undefined
      owner?.dispose()
    }
  }, [])
  const notifyFailure = (kind: string, error: unknown) => {
    notifications.current?.show({
      kind: `plugin.management.${kind}.failed`,
      type: 'error',
      message: productLocale(locale) === 'zh-CN' ? '插件管理操作失败' : 'Plugin management action failed',
      description: error instanceof Error ? error.message : String(error),
    })
  }
  const mutate = async (key: string, request: PluginManagementConfigRequest, notifyOnFailure = true) => {
    if (binding === undefined || snapshot === undefined) return undefined
    setBusyKey(key)
    try {
      const result = await binding.mutate(request, snapshot.revision)
      if (result.status === 'rejected' || result.status === 'conflict') throw new Error(result.error.message)
      return result.snapshot
    } catch (error) {
      if (notifyOnFailure) notifyFailure(request.kind, error)
      throw error
    } finally {
      setBusyKey(undefined)
    }
  }
  return { busyKey, mutate, notifyFailure }
}
