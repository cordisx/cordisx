import { useEffect, useMemo, useState } from 'react'
import type { ChatExecutionReadbackV1 } from '@cordisx/protocol/chat-execution-settings/v1'
import type { ManagerModel } from '../../manager.js'
import type { NotificationCenter } from '../../notifications/model.js'
import { ChatExecutionForm } from '../../chat-execution-form.js'
import { EmptyState } from '../../host-ui/EmptyState.js'

/** Profile defaults stay Host-owned; plugin settings destinations cannot replace this page. */
export function ChatExecutionPage(
  { model, locale, notifications }: {
    model: ManagerModel
    locale: string
    notifications?: NotificationCenter
  },
) {
  const [state, setState] = useState<{ signal: AbortSignal; readback?: ChatExecutionReadbackV1; error?: boolean }>()
  const zh = locale.startsWith('zh'), workflow = model.chatExecution
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
    if (workflow) {
      void workflow.read(undefined, lifetime.signal).then(readback => {
        if (!lifetime.signal.aborted) setState({ signal: lifetime.signal, readback })
      }).catch(() => {
        if (!lifetime.signal.aborted) setState({ signal: lifetime.signal, error: true })
      })
    }
    return () => lifetime.abort()
  }, [workflow])
  return (
    <section className="cxr-page" data-chat-creation-defaults-page="true">
      {!workflow || state?.error
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
