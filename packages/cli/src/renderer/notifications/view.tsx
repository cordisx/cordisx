import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { HostIcon } from '../host-ui/HostIcon.js'
import { PluginIdentityMark } from '../manager/components/PluginIdentityMark.js'
import type { NotificationCenter, NotificationEntry } from './model.js'

function NotificationCard(
  { entry, center, zh }: { entry: NotificationEntry; center: NotificationCenter; zh: boolean },
) {
  const [menu, setMenu] = useState(false)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const [details, setDetails] = useState(false)
  const [copied, setCopied] = useState('')
  const [opening, setOpening] = useState(false)
  const [navigationError, setNavigationError] = useState('')
  const more = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  const source = entry.owner.presentation()
  const t = (cn: string, en: string) => zh ? cn : en
  useEffect(() => {
    entry.paused = menu || hover || focused || details
    return () => {
      entry.paused = false
    }
  }, [entry, menu, hover, focused, details])
  useEffect(() => {
    if (!menu) return
    const document = card.current?.ownerDocument
    const outside = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node)) setMenu(false)
    }
    document?.addEventListener('pointerdown', outside)
    card.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => document?.removeEventListener('pointerdown', outside)
  }, [menu])
  const identity = (
    <>
      <PluginIdentityMark pluginId={entry.owner.pluginId} name={source.name} icon={source.icon} />
      <span>{source.name}</span>
    </>
  )
  return (
    <article
      className="cxn-card"
      data-type={entry.options.type}
      ref={card}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <header className="cxn-header">
        {entry.owner.open && (entry.owner.canOpen?.() ?? true)
          ? (
            <button
              className="cxn-source"
              title={t('打开 ', 'Open ') + source.name}
              disabled={opening}
              onClick={() => {
                if (!entry.owner.active() || opening) return
                setOpening(true)
                setNavigationError('')
                void entry.owner.open!().catch(() => {
                  if (!entry.lifetime.signal.aborted) {
                    setNavigationError(t('暂时无法打开插件', 'Could not open plugin'))
                  }
                })
                  .finally(() => {
                    if (!entry.lifetime.signal.aborted) setOpening(false)
                  })
              }}
            >
              {identity}
            </button>
          )
          : <span className="cxn-source">{identity}</span>}
        <button
          className="cxn-icon"
          ref={more}
          aria-label={t('更多通知选项', 'More notification options')}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <HostIcon token="more" />
        </button>
        <button
          className="cxn-icon"
          aria-label={t('关闭通知', 'Dismiss notification')}
          onClick={() => center.dismiss(entry.id)}
        >
          <HostIcon token="close" />
        </button>
      </header>
      <div className="cxn-message" role={entry.options.type === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <span className="cxn-severity" aria-label={entry.options.type}>
          {entry.options.type === 'success' ? '✓' : entry.options.type === 'info' ? 'ⓘ' : '!'}
        </span>
        <div>
          <strong>{entry.options.message}</strong>
          {entry.count > 1 && <span className="cxn-count">×{entry.count}</span>}
          {entry.options.description && <p>{entry.options.description}</p>}
        </div>
      </div>
      {(entry.actionError || navigationError) && (
        <p className="cxn-error" role="alert">{entry.actionError || navigationError}</p>
      )}
      {(entry.options.details || entry.options.action) && (
        <footer className="cxn-footer">
          {entry.options.details && (
            <button aria-expanded={details} onClick={() => setDetails(!details)}>
              {t(details ? '收起详情' : '查看详情', details ? 'Hide details' : 'Show details')}
            </button>
          )}
          {entry.options.action && (
            <button
              className="cxn-action"
              disabled={entry.busy}
              onClick={() => void center.invoke(entry, t('操作未完成，请重试', 'Action failed. Please retry.'))}
            >
              {entry.busy ? t('处理中…', 'Working…') : entry.options.action.label}
            </button>
          )}
        </footer>
      )}
      {details && (
        <div className="cxn-details">
          <pre>{entry.options.details}</pre>
          <button
            onClick={() => {
              const clipboard = card.current?.ownerDocument.defaultView?.navigator.clipboard
              if (!clipboard) {
                setCopied(t('复制不可用', 'Copy unavailable'))
                return
              }
              void clipboard.writeText(entry.options.details!).then(
                () => setCopied(t('已复制', 'Copied')),
                () => setCopied(t('复制失败', 'Copy failed')),
              )
            }}
          >
            {t('复制详情', 'Copy details')}
          </button>
          <span role="status">{copied}</span>
        </div>
      )}
      {menu && (
        <div
          className="cxn-menu"
          role="menu"
          aria-label={t('通知规则', 'Notification rules')}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setMenu(false)
              more.current?.focus()
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
              const index = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
              const next = event.key === 'Home'
                ? 0
                : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              buttons[next]?.focus()
            }
          }}
        >
          {([
            ['kind', t('不再提醒此类消息', 'Mute this kind of notification')],
            ['hour', t('暂停此插件通知 1 小时', 'Pause this plugin for 1 hour')],
            ['today', t('今天暂停此插件通知', 'Pause this plugin for today')],
            ['plugin', t('屏蔽此插件所有通知', 'Mute all notifications from this plugin')],
          ] as const).map(([scope, label]) => (
            <button
              role="menuitem"
              key={scope}
              onClick={() => center.mute(entry, scope)}
            >
              {label}
            </button>
          ))}
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false)
              center.manage()
            }}
          >
            {t('管理通知规则', 'Manage notification rules')}
          </button>
        </div>
      )}
    </article>
  )
}

export function NotificationRules({ center, zh }: { center: NotificationCenter; zh: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const t = (cn: string, en: string) => zh ? cn : en
  useEffect(() => {
    const element = dialog.current
    const previous = element?.ownerDocument.activeElement as HTMLElement | null
    element?.showModal()
    return () => {
      element?.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      className="cxn-rules"
      ref={dialog}
      aria-label={t('通知规则', 'Notification rules')}
      onCancel={() => center.manage(false)}
    >
      <header>
        <strong>{t('通知规则', 'Notification rules')}</strong>
        <button className="cxn-icon" aria-label={t('关闭', 'Close')} onClick={() => center.manage(false)}>
          <HostIcon token="close" />
        </button>
      </header>
      {center.persistenceError && (
        <p role="alert">
          {t('规则仅在当前窗口生效，暂时无法保存。', 'Rules apply in this window only; saving is unavailable.')}
        </p>
      )}
      {center.getRules().length === 0 && <p>{t('没有屏蔽规则', 'No muted notifications')}</p>}
      {center.getRules().map(rule => (
        <div className="cxn-rule" key={rule.id}>
          <div>
            <strong>{rule.name}</strong>
            <p>{rule.kind ?? t('所有通知', 'All notifications')}</p>
            <small>
              {rule.expiresAt ? new Date(rule.expiresAt).toLocaleString() : t('持续屏蔽', 'Muted until restored')}
            </small>
          </div>
          <button onClick={() => center.removeRule(rule.id)}>{t('恢复通知', 'Restore notifications')}</button>
        </div>
      ))}
    </dialog>
  )
}

export function NotificationViewport({ center, document }: { center: NotificationCenter; document: Document }) {
  useSyncExternalStore(center.subscribe, center.snapshot, center.snapshot)
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh') || document.documentElement.lang === ''
  return (
    <>
      <section className="cxn-stack" aria-label={zh ? '插件通知' : 'Plugin notifications'}>
        {center.visible().map(entry => <NotificationCard key={entry.id} entry={entry} center={center} zh={zh} />)}
        {center.pending() > 0 && (
          <span className="cxn-pending">{zh ? `还有 ${center.pending()} 条待显示` : `${center.pending()} queued`}</span>
        )}
        {center.canUndo() && (
          <div className="cxn-undo" role="status">
            <span>
              {center.persistenceError
                ? (zh ? '本窗口已屏蔽，规则未保存' : 'Muted in this window; not saved')
                : (zh ? '已应用屏蔽规则' : 'Notification rule applied')}
            </span>
            <button onClick={() => center.undo()}>{zh ? '撤销' : 'Undo'}</button>
            <button onClick={() => center.manage()}>{zh ? '管理' : 'Manage'}</button>
          </div>
        )}
      </section>
      {center.isManaging() && <NotificationRules center={center} zh={zh} />}
    </>
  )
}
