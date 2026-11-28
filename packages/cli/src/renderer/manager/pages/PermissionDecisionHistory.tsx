import { useEffect, useState } from 'react'
import { Button } from 'tdesign-react'
import type { PermissionDecisionHistoryItem } from '../../../permission-decision-history.js'
import { BrowserPermissionHistoryBinding } from '../../permission-history-binding.js'
import type { ManagerModel, ManagerPermissionSnapshot } from '../../manager.js'
import { productLocale } from '../../ui-copy.js'

type State = { readonly status: 'loading' | 'unavailable' } | {
  readonly status: 'ready'
  readonly items: readonly PermissionDecisionHistoryItem[]
}

/** Show service-owned decisions for this exact plugin and permission scope. */
export function PermissionDecisionHistory({ permission, locale, model, refreshKey = 0 }: {
  readonly permission: ManagerPermissionSnapshot
  readonly locale: string
  readonly model: ManagerModel
  readonly refreshKey?: number
}) {
  const nativeHistory = model.permissionHistory
  const supported = nativeHistory !== undefined || typeof globalThis.__cordisxPermissionHistoryRequestV1 === 'function'
  const [state, setState] = useState<State>({ status: 'loading' })
  const [manualRefresh, setManualRefresh] = useState(0)
  const scope = JSON.stringify(permission.scope)
  useEffect(() => {
    if (!supported) return
    let binding: BrowserPermissionHistoryBinding | undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    setState({ status: 'loading' })
    try {
      if (!nativeHistory) binding = BrowserPermissionHistoryBinding.connect()
      if (!binding && !nativeHistory) throw new Error('permission history is unavailable')
      const read = () =>
        void (nativeHistory?.(permission.identity.id) ?? binding!.read(permission.identity.id)).then(items => {
          if (!live) return
          setState({
            status: 'ready',
            items: items.filter(item => {
              const key = item.record.key
              return key.identity.source === permission.identity.source
                && key.identity.pluginId === permission.identity.id
                && key.capability === permission.capability && JSON.stringify(key.scope) === scope
                && (!('securityFingerprint' in key) || key.securityFingerprint === permission.fingerprint)
            }),
          })
          if (items.some(item => item.committedAt === undefined) && retries++ < 2) timer = setTimeout(read, 750)
        }, () => {
          if (live) setState({ status: 'unavailable' })
        })
      read()
    } catch {
      setState({ status: 'unavailable' })
    }
    return () => {
      live = false
      if (timer) clearTimeout(timer)
      binding?.dispose()
    }
  }, [
    nativeHistory,
    supported,
    permission.identity.id,
    permission.identity.source,
    permission.capability,
    permission.fingerprint,
    permission.policy,
    scope,
    refreshKey,
    manualRefresh,
  ])
  if (!supported) return null
  const chinese = productLocale(locale) === 'zh-CN'
  return (
    <section className="cxr-section" data-permission-decision-history>
      <h3>{chinese ? '授权记录' : 'Authorization history'}</h3>
      <Button
        tag="button"
        type="button"
        theme="default"
        variant="outline"
        onClick={() => setManualRefresh(value => value + 1)}
      >
        {chinese ? '刷新' : 'Refresh'}
      </Button>
      <p>{chinese ? '记录服务收到的权限决定。' : 'Decisions received by the service are recorded here.'}</p>
      {state.status === 'loading' ? <p>{chinese ? '正在读取…' : 'Loading…'}</p> : null}
      {state.status === 'unavailable'
        ? <p role="status">{chinese ? '暂时无法读取授权来源。' : 'Authorization source is unavailable.'}</p>
        : null}
      {state.status === 'ready' && state.items.length === 0
        ? (
          <p>
            {chinese
              ? '近期没有来源记录；旧授权和单次授权可能未记录来源。'
              : 'No recent source is recorded; older and one-time decisions may be missing.'}
          </p>
        )
        : null}
      {state.status === 'ready'
        ? state.items.map((item, index) => {
          const decision = item.decision === 'ask'
            ? chinese ? '恢复询问' : 'Ask again'
            : item.decision === 'allow-once'
            ? chinese ? '单次允许' : 'Allowed once'
            : item.decision === 'deny-once'
            ? chinese ? '单次拒绝' : 'Denied once'
            : item.decision === 'allow' || item.decision === 'allow-persistent'
            ? chinese ? '允许' : 'Allowed'
            : chinese
            ? '拒绝'
            : 'Denied'
          const client = item.client === 'codex' ? 'Codex' : 'CordisX Web'
          return (
            <p key={`${item.requestedAt}-${index}`}>
              {decision} · {client} · {new Date(item.requestedAt).toLocaleString(chinese ? 'zh-CN' : 'en')}
              {item.committedAt === undefined ? chinese ? ' · 结果未确认' : ' · Outcome unconfirmed' : ''}
            </p>
          )
        })
        : null}
    </section>
  )
}
