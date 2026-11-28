import { useEffect, useState } from 'react'
import { Button } from 'tdesign-react'
import type { PluginAuthorizationHistoryItem } from '../../../permission-decision-history.js'
import { projectPermissionCapabilityName } from '../../../permission-locales.js'
import { BrowserPermissionHistoryBinding } from '../../permission-history-binding.js'
import type { ManagerModel } from '../../manager.js'
import { productLocale } from '../../ui-copy.js'

/** Lifecycle review history belongs to the current service's exact plugin identity. */
export function PluginAuthorizationHistory({ pluginId, locale, model }: {
  readonly pluginId: string
  readonly locale: string
  readonly model: ManagerModel
}) {
  const native = model.pluginAuthorizationHistory
  const supported = native !== undefined || typeof globalThis.__cordisxPermissionHistoryRequestV1 === 'function'
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<
    { readonly status: 'loading' | 'unavailable' } | {
      readonly status: 'ready'
      readonly items: readonly PluginAuthorizationHistoryItem[]
    }
  >({ status: 'loading' })
  useEffect(() => {
    if (!supported) return
    let active = true
    let binding: BrowserPermissionHistoryBinding | undefined
    setState({ status: 'loading' })
    try {
      if (!native) binding = BrowserPermissionHistoryBinding.connect()
      if (!native && !binding) throw new Error('plugin authorization history is unavailable')
      void (native?.(pluginId) ?? binding!.readLifecycle(pluginId)).then(items => {
        if (active) setState({ status: 'ready', items })
      }, () => {
        if (active) setState({ status: 'unavailable' })
      })
    } catch {
      setState({ status: 'unavailable' })
    }
    return () => {
      active = false
      binding?.dispose()
    }
  }, [native, pluginId, refresh, supported])
  if (!supported) return null
  const zh = productLocale(locale) === 'zh-CN'
  return (
    <section className="cxr-section" data-plugin-authorization-history>
      <h3>{zh ? '授权记录' : 'Authorization history'}</h3>
      <Button tag="button" type="button" theme="default" variant="outline" onClick={() => setRefresh(n => n + 1)}>
        {zh ? '刷新' : 'Refresh'}
      </Button>
      <p>{zh ? '来源表示服务收到请求的客户端。' : 'The source is the client that sent the request to the service.'}</p>
      {state.status === 'loading' ? <p>{zh ? '正在读取…' : 'Loading…'}</p> : null}
      {state.status === 'unavailable'
        ? <p role="status">{zh ? '暂时无法读取记录。' : 'History is unavailable.'}</p>
        : null}
      {state.status === 'ready' && state.items.length === 0
        ? <p>{zh ? '暂无记录；较早的操作可能没有记录来源。' : 'No records; older operations may not have a source.'}</p>
        : null}
      {state.status === 'ready'
        ? state.items.map((item, index) => {
          const action = item.operation === 'runtime'
            ? zh ? '运行时权限' : 'Runtime permission'
            : item.operation === 'install'
            ? zh ? '安装' : 'Install'
            : item.operation === 'update'
            ? zh ? '更新' : 'Update'
            : zh
            ? '启用'
            : 'Enable'
          return (
            <div key={`${item.requestedAt}-${index}`}>
              <p>
                {action} · {item.client === 'codex' ? 'Codex' : 'CordisX Web'} ·{' '}
                {new Date(item.requestedAt).toLocaleString(zh ? 'zh-CN' : 'en')}
                {item.committedAt === undefined ? zh ? ' · 结果未确认' : ' · Outcome unconfirmed' : ''}
              </p>
              {item.decisions.map((choice, choiceIndex) => {
                const selected = choice.decision === 'allow-once'
                  ? zh ? '单次允许' : 'Allow once'
                  : choice.decision === 'deny-once'
                  ? zh ? '单次拒绝' : 'Deny once'
                  : choice.decision === 'allow' || choice.decision === 'allow-persistent'
                  ? zh ? '允许' : 'Allow'
                  : choice.decision === 'ask'
                  ? zh ? '询问' : 'Ask'
                  : zh
                  ? '拒绝'
                  : 'Deny'
                return (
                  <p key={`${choice.capability}-${choiceIndex}`}>
                    {projectPermissionCapabilityName(
                      choice.capability as Parameters<typeof projectPermissionCapabilityName>[0],
                      locale,
                    )} · {selected}
                  </p>
                )
              })}
            </div>
          )
        })
        : null}
    </section>
  )
}
