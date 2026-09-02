import type { ManagerCollectionAction, ManagerCollectionItem, ManagerCollectionLeadingVisual } from '@cordisx/protocol/manager-collection/v1'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { CordisXIconToken } from '../../../contracts.js'
import { HostAgentAvatar } from '../../host-ui/conversation/AgentAvatar.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { HostSurfaceIcon } from '../../host-ui/HostSurfaceIcon.js'
import {
  HostManagerCollectionPageRegistry,
  type HostManagerCollectionPageOptions,
  type ManagerCollectionDialogState,
} from '../../manager-collection.js'

function ActionIcon({ action }: { readonly action: ManagerCollectionAction }) {
  const semantic = action.id.toLocaleLowerCase().split(/[.:/_-]/u).at(-1)
  if (semantic === 'pin' || semantic === 'unpin') return <HostSurfaceIcon token="host:pin" state={action.pressed || semantic === 'unpin' ? 'active' : 'default'} />
  if (semantic === 'archive') return <HostSurfaceIcon token="host:archive" />
  if (semantic === 'restore' || semantic === 'unarchive') return <HostSurfaceIcon token="host:restore" />
  if (semantic === 'delete' || semantic === 'remove') return <HostSurfaceIcon token="host:delete" />
  if (action.icon !== undefined) return <HostSurfaceIcon token={action.icon as CordisXIconToken} state={action.pressed ? 'active' : 'default'} />
  if (action.kind === 'copy-route-link' || action.kind === 'copy-text') return <HostIcon token="copy" />
  if (action.kind === 'text-input-command') return <HostIcon token="edit" />
  return <HostIcon token={action.tone === 'danger' ? 'delete' : 'more'} />
}

function LeadingVisual({ item, title }: { readonly item: ManagerCollectionItem; readonly title: string }) {
  const visual = item.leadingVisual
  if (visual.kind === 'semantic-icon') return <span className="cxr-manager-collection-visual" data-kind="semantic-icon"><HostSurfaceIcon token={visual.icon} /></span>
  if (visual.kind === 'avatar') return <span className="cxr-manager-collection-visual" data-kind="avatar"><HostAgentAvatar participant={{ id: item.id, role: 'agent', name: title, avatar: visual.avatar }} /></span>
  return <AvatarStack visual={visual} />
}

function AvatarStack({ visual }: { readonly visual: Extract<ManagerCollectionLeadingVisual, { kind: 'avatar-stack' }> }) {
  const visible = visual.entries.slice(0, 3)
  return <span className="cxr-manager-collection-visual cxr-manager-collection-avatar-stack" data-kind="avatar-stack" data-count={visual.entries.length}>
    {visible.map((entry, index) => <span key={entry.id} data-avatar-slot={index}><HostAgentAvatar participant={{ id: entry.id, role: 'agent', name: entry.id, avatar: entry.avatar }} /></span>)}
    {visual.entries.length > 3 ? <span className="cxr-manager-collection-avatar-overflow">+{visual.entries.length - 3}</span> : null}
  </span>
}

function enabledMenuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root === null ? [] : [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
}

function OverflowMenu({
  actions,
  item,
  registry,
  busy,
  rememberTrigger,
}: {
  readonly actions: readonly ManagerCollectionAction[]
  readonly item: ManagerCollectionItem
  readonly registry: HostManagerCollectionPageRegistry
  readonly busy: boolean
  readonly rememberTrigger: (element: HTMLElement | null) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (restore: boolean) => {
    setOpen(false)
    if (restore) queueMicrotask(() => trigger.current?.focus({ preventScroll: true }))
  }
  useLayoutEffect(() => {
    if (!open) return
    enabledMenuItems(menu.current)[0]?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof registry.options.document.defaultView!.Node && !menu.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    registry.options.document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => registry.options.document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open, registry])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true); return
    }
    const items = enabledMenuItems(menu.current)
    const current = items.indexOf(event.target as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? items[(current + 1 + items.length) % items.length]
      : event.key === 'ArrowUp' ? items[(current - 1 + items.length) % items.length]
        : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); next.focus() }
  }
  return <span className="cxr-manager-collection-overflow" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="cxr-manager-collection-action" aria-label={registry.options.hostCopy('more-actions')} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}><HostIcon token="more" /></button>
    {!open ? null : <div ref={menu} className="cxr-manager-collection-menu" role="menu" aria-label={registry.options.hostCopy('more-actions')} onKeyDown={onKeyDown}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" disabled={busy || action.disabled.value} aria-pressed={action.pressed} data-tone={action.tone}
        title={action.disabled.reason === undefined ? undefined : registry.localized(action.disabled.reason, `item:${item.id}:action:${action.id}:disabled`)}
        onClick={() => { rememberTrigger(trigger.current); close(false); registry.requestAction(item.id, action.id) }}>
        <ActionIcon action={action} /><span>{registry.localized(action.label, `item:${item.id}:action:${action.id}:label`)}</span>
      </button>)}
    </div>}
  </span>
}

function Row({ item, registry, busy, rememberTrigger }: { readonly item: ManagerCollectionItem; readonly registry: HostManagerCollectionPageRegistry; readonly busy: boolean; readonly rememberTrigger: (element: HTMLElement | null) => void }) {
  const direct = item.actions.filter(action => action.placement === 'direct')
  const overflow = item.actions.filter(action => action.placement === 'overflow')
  const title = registry.localized(item.title, `item:${item.id}:title`)
  const summary = registry.localized(item.summary, `item:${item.id}:summary`)
  const disabledReason = item.disabled.reason === undefined ? undefined : registry.localized(item.disabled.reason, `item:${item.id}:disabled`)
  return <article className="cxr-manager-collection-row" role="listitem" data-manager-collection-item={item.id} data-disabled={item.disabled.value || undefined}>
    <button type="button" className="cxr-manager-collection-open" disabled={item.disabled.value} aria-label={title} aria-description={disabledReason ?? summary} onClick={() => void registry.open(item.id)}>
      <LeadingVisual item={item} title={title} />
      <span className="cxr-manager-collection-copy"><strong>{title}</strong><span>{summary}</span></span>
    </button>
    {direct.length === 0 && overflow.length === 0 ? null : <span className="cxr-manager-collection-actions" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      {direct.map(action => <button key={action.id} type="button" className="cxr-manager-collection-action" data-tone={action.tone} disabled={busy || action.disabled.value}
        aria-label={registry.localized(action.ariaLabel ?? action.label, `item:${item.id}:action:${action.id}:aria`)} aria-pressed={action.pressed}
        title={action.disabled.reason === undefined ? registry.localized(action.label, `item:${item.id}:action:${action.id}:label`) : registry.localized(action.disabled.reason, `item:${item.id}:action:${action.id}:disabled`)}
        onClick={event => { rememberTrigger(event.currentTarget); registry.requestAction(item.id, action.id) }}><ActionIcon action={action} /></button>)}
      {overflow.length === 0 ? null : <OverflowMenu actions={overflow} item={item} registry={registry} busy={busy} rememberTrigger={rememberTrigger} />}
    </span>}
  </article>
}

function Dialog({ dialog, registry, restoreFocus }: { readonly dialog: ManagerCollectionDialogState; readonly registry: HostManagerCollectionPageRegistry; readonly restoreFocus: () => void }) {
  const titleId = useId()
  const descriptionId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(dialog.input?.initialValue ?? '')
  const normalized = dialog.input?.trim === 'both' ? value.trim() : value
  const length = [...normalized].length
  const valid = dialog.input === undefined || (length >= dialog.input.minLength && length <= dialog.input.maxLength && !/[\u0000-\u001F\u007F]/u.test(normalized))
  const close = () => { registry.cancelDialog(); restoreFocus() }
  useLayoutEffect(() => {
    const target = panel.current?.querySelector<HTMLElement>('input,button')
    target?.focus()
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Enter' && valid && !event.nativeEvent.isComposing
      && event.target instanceof registry.options.document.defaultView!.HTMLInputElement) {
      event.preventDefault()
      registry.submitDialog(normalized)
      restoreFocus()
      return
    }
    if (event.key !== 'Tab' || panel.current === null) return
    const focusable = [...panel.current.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')]
    if (focusable.length === 0) return
    const current = focusable.indexOf(event.target as HTMLElement)
    const next = event.shiftKey ? focusable[(current - 1 + focusable.length) % focusable.length] : focusable[(current + 1) % focusable.length]
    event.preventDefault(); next?.focus()
  }
  return <div className="cxr-manager-collection-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={panel} className="cxr-manager-collection-dialog" data-tone={dialog.tone} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={dialog.description === undefined ? undefined : descriptionId} onKeyDown={onKeyDown}>
      <h3 id={titleId}>{registry.localized(dialog.title, `dialog:${dialog.actionId}:title`)}</h3>
      {dialog.description === undefined ? null : <p id={descriptionId}>{registry.localized(dialog.description, `dialog:${dialog.actionId}:description`)}</p>}
      {dialog.input === undefined ? null : <label><span>{registry.localized(dialog.input.label, `dialog:${dialog.actionId}:label`)}</span><input type="text" value={value}
        placeholder={dialog.input.placeholder === undefined ? undefined : registry.localized(dialog.input.placeholder, `dialog:${dialog.actionId}:placeholder`)}
        onChange={event => setValue(event.currentTarget.value)} aria-invalid={!valid} /></label>}
      <div className="cxr-manager-collection-dialog-actions"><button type="button" onClick={close}>{registry.options.hostCopy('cancel')}</button><button type="button" data-tone={dialog.tone === 'danger' ? 'danger' : 'primary'} disabled={!valid}
        onClick={() => { registry.submitDialog(normalized); restoreFocus() }}>{registry.localized(dialog.confirmLabel, `dialog:${dialog.actionId}:confirm`)}</button></div>
    </div>
  </div>
}

function ViewSelector({ registry, views, active, panelId }: { readonly registry: HostManagerCollectionPageRegistry; readonly views: NonNullable<ReturnType<HostManagerCollectionPageRegistry['snapshot']>['registration']>['views']; readonly active: string; readonly panelId: string }) {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const activate = (id: string) => { registry.setView(id); queueMicrotask(() => refs.current.get(id)?.focus({ preventScroll: true })) }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? views[(index + 1) % views.length]
      : event.key === 'ArrowLeft' ? views[(index - 1 + views.length) % views.length]
        : event.key === 'Home' ? views[0] : event.key === 'End' ? views.at(-1) : undefined
    if (next !== undefined) { event.preventDefault(); activate(next.id) }
  }
  return <div className="cxr-manager-collection-views" role="tablist" aria-label={registry.options.hostCopy('views')}>
    {views.map((view, index) => <button key={view.id} id={`${panelId}-${view.id}`} ref={node => { if (node === null) refs.current.delete(view.id); else refs.current.set(view.id, node) }} type="button" role="tab" aria-selected={view.id === active} aria-controls={panelId}
      tabIndex={view.id === active ? 0 : -1} onKeyDown={event => onKeyDown(event, index)} onClick={() => activate(view.id)}>{registry.localized(view.label, `view:${view.id}:label`)}</button>)}
  </div>
}

function ManagerCollectionHost({ registry }: { readonly registry: HostManagerCollectionPageRegistry }) {
  const snapshot = useSyncExternalStore(listener => registry.subscribe(listener), () => registry.snapshot())
  const panelId = useId()
  const section = useRef<HTMLElement>(null)
  const lastTrigger = useRef<HTMLElement | null>(null)
  const pendingFocusRestore = useRef(false)
  const registration = snapshot.registration
  const currentView = registration?.views.find(view => view.id === snapshot.view)
  const items = snapshot.source?.items ?? []
  const feedback = snapshot.feedback
  useEffect(() => {
    if (feedback === undefined) return
    const view = registry.options.document.defaultView
    const timer = view?.setTimeout(() => registry.clearFeedback(), 4_000)
    return () => { if (timer !== undefined) view?.clearTimeout(timer) }
  }, [feedback, registry])
  const rememberTrigger = (element: HTMLElement | null) => { lastTrigger.current = element }
  const restoreFocus = () => queueMicrotask(() => {
    const target = lastTrigger.current
    if (target?.isConnected && !target.matches(':disabled')) {
      target.focus({ preventScroll: true })
      lastTrigger.current = null
      pendingFocusRestore.current = false
    } else if (target?.isConnected) pendingFocusRestore.current = true
    else {
      section.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true })
      lastTrigger.current = null
      pendingFocusRestore.current = false
    }
  })
  useEffect(() => {
    if (snapshot.busy !== undefined || !pendingFocusRestore.current) return
    restoreFocus()
  }, [snapshot.busy])
  if (registration === undefined) return null
  const empty = snapshot.source?.normalizedSearch === '' ? currentView?.emptyTitle : registration.search.noMatchTitle
  const emptyDescription = snapshot.source?.normalizedSearch === '' ? currentView?.emptyDescription : registration.search.noMatchDescription
  const multipleViews = registration.views.length > 1 && snapshot.view !== undefined
  return <section ref={section} className="cxr-manager-collection" aria-label={registry.localized(registration.label, 'label')} aria-busy={snapshot.state === 'loading' || snapshot.busy !== undefined}>
    {!multipleViews ? null : <ViewSelector registry={registry} views={registration.views} active={snapshot.view!} panelId={panelId} />}
    <div className="cxr-manager-collection-search" role="search"><HostIcon token="search" /><input type="search" value={snapshot.search}
      aria-label={registry.localized(registration.search.label, 'search:label')} placeholder={registry.localized(registration.search.placeholder, 'search:placeholder')}
      onChange={event => registry.setSearch(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape' && snapshot.search !== '') { event.preventDefault(); registry.setSearch('') } }} />
      {snapshot.search === '' ? null : <button type="button" aria-label={registry.options.hostCopy('clear-search')} onClick={() => registry.setSearch('')}><HostIcon token="close" /></button>}
    </div>
    <div id={panelId} role={multipleViews ? 'tabpanel' : undefined} aria-labelledby={multipleViews ? `${panelId}-${snapshot.view}` : undefined}>
      {snapshot.state === 'loading' ? <div className="cxr-manager-collection-state" role="status">{registry.options.hostCopy('loading')}</div>
        : snapshot.state === 'error' ? <div className="cxr-manager-collection-state" role="alert"><strong>{registry.options.hostCopy('error-title')}</strong><span>{registry.options.hostCopy('error-description')}</span><button type="button" onClick={() => registry.retry()}>{registry.options.hostCopy('retry')}</button></div>
          : items.length === 0 ? <div className="cxr-manager-collection-state" role="status"><strong>{empty === undefined ? registry.options.hostCopy('empty') : registry.localized(empty, 'empty:title')}</strong>{emptyDescription === undefined ? null : <span>{registry.localized(emptyDescription, 'empty:description')}</span>}</div>
            : <div className="cxr-manager-collection-list" role="list" aria-label={registry.localized(registration.label, 'list:label')}>{items.map(item => <Row key={item.id} item={item} registry={registry} busy={snapshot.busy !== undefined} rememberTrigger={rememberTrigger} />)}</div>}
    </div>
    {feedback === undefined ? null : <div className="cxr-manager-collection-feedback" data-tone={feedback.tone} role={feedback.tone === 'error' ? 'alert' : 'status'}>
      <span>{registry.localized(feedback.message, `feedback:${feedback.id}`)}</span><button type="button" aria-label={registry.options.hostCopy('clear-feedback')} onClick={() => registry.clearFeedback()}><HostIcon token="close" /></button>
    </div>}
    {snapshot.dialog === undefined ? null : <Dialog dialog={snapshot.dialog} registry={registry} restoreFocus={restoreFocus} />}
  </section>
}

export interface MountedManagerCollectionHost {
  readonly registry: HostManagerCollectionPageRegistry
  dispose(): void
}

export function mountManagerCollectionHost(container: HTMLElement, options: HostManagerCollectionPageOptions): MountedManagerCollectionHost {
  const registry = new HostManagerCollectionPageRegistry(options)
  const root = createRoot(container)
  container.dataset.managerCollectionHost = 'true'
  flushSync(() => root.render(<ManagerCollectionHost registry={registry} />))
  let disposed = false
  return {
    registry,
    dispose: () => {
      if (disposed) return
      disposed = true
      registry.dispose()
      root.unmount()
      container.removeAttribute('data-manager-collection-host')
      container.replaceChildren()
    },
  }
}
