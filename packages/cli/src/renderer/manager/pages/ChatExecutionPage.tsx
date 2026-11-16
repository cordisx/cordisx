import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  availableChannelSettingsDestination,
  channelSettingsDestinations,
  subscribeChannelSettingsDestinations,
} from '../../channel-settings-destination.js'
import type { ChatExecutionReadbackV1 } from '@cordisx/protocol/chat-execution-settings/v1'
import type { ManagerModel } from '../../manager.js'
import type { NotificationCenter } from '../../notifications/model.js'
import { ChatExecutionForm } from '../../chat-execution-form.js'
import { EmptyState } from '../../host-ui/EmptyState.js'
import { Button } from 'tdesign-react'
import { HostIcon } from '../../host-ui/HostIcon.js'
import type { ManagerRouter } from '../model/routes.js'

/** General new-chat defaults use the same Host form and store as authorized Channel commands. */
export function ChatExecutionPage(
  { model, router, locale, notifications }: {
    model: ManagerModel
    router: ManagerRouter
    locale: string
    notifications?: NotificationCenter
  },
) {
  const [state, setState] = useState<{ signal: AbortSignal; readback?: ChatExecutionReadbackV1; error?: boolean }>()
  const zh = locale.startsWith('zh'), workflow = model.chatExecution
  const destinations = useSyncExternalStore(
    listener => subscribeChannelSettingsDestinations(document, listener),
    () => channelSettingsDestinations(document),
  )
  const [snapshot, setSnapshot] = useState(() => model.snapshot())
  useEffect(() => model.subscribe(() => setSnapshot(model.snapshot())), [model])
  const destination = availableChannelSettingsDestination(snapshot, destinations)
  const navigationItem = snapshot.settingsNavigationItems?.find(item =>
    item.owner === destination?.owner && !item.disabled && !item.permissionReview
  )
  const notification = useMemo(
    () =>
      notifications?.bind({
        key: 'host:chat-execution',
        pluginId: 'host',
        active: () => true,
        presentation: () => ({ name: 'CordisX' }),
      }),
    [notifications],
  )
  useEffect(() => () => notification?.dispose(), [notification])
  useEffect(() => {
    const lifetime = new AbortController()
    setState({ signal: lifetime.signal })
    if (workflow && !destination) {
      void workflow.read(undefined, lifetime.signal).then(readback => {
        if (!lifetime.signal.aborted) setState({ signal: lifetime.signal, readback })
      }).catch(() => {
        if (!lifetime.signal.aborted) setState({ signal: lifetime.signal, error: true })
      })
    }
    return () => lifetime.abort()
  }, [workflow, destination])
  return (
    <section className="cxr-page" data-chat-creation-defaults-page="true">
      {destination
        ? (
          <Button
            variant="outline"
            icon={<HostIcon token="action.settings" />}
            onClick={() => {
              if (navigationItem) {
                router.navigate({
                  kind: 'manager-content',
                  id: navigationItem.id,
                  reference: { id: destination.routeId },
                })
              }
            }}
          >
            {zh ? '打开渠道设置' : 'Open Channel settings'}
          </Button>
        )
        : !workflow || state?.error
        ? (
          <EmptyState
            icon="settings"
            title={zh ? '执行配置暂不可用' : 'Execution settings unavailable'}
            description={zh ? '当前原生运行时尚未连接。' : 'The native runtime is not connected.'}
          />
        )
        : state?.readback
        ? (
          <ChatExecutionForm
            initial={state.readback}
            locale={locale}
            signal={state.signal}
            read={() => workflow.read(undefined, state.signal)}
            save={(settings, revision) => workflow.saveDefaults(settings, revision)}
            onResult={result => {
              notification?.api.show({
                kind: 'chat.execution.settings',
                type: result.status === 'applied' ? 'success' : 'error',
                message: result.status === 'applied'
                  ? zh ? '已保存，新建对话时使用。' : 'Saved for newly created chats.'
                  : result.code === 'REVISION_CONFLICT'
                  ? zh ? '配置已变化，请重新读取后保存。' : 'Settings changed. Refresh before saving.'
                  : zh
                  ? '暂时无法保存执行配置。'
                  : 'Execution settings could not be saved.',
              })
            }}
          />
        )
        : <span role="status">{zh ? '正在读取…' : 'Loading…'}</span>}
    </section>
  )
}
