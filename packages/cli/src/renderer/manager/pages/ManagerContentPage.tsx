import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ManagerModel } from '../../manager.js'
import { HostSurfaceIcon } from '../../host-ui/HostSurfaceIcon.js'
import { managerCopy } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'

export function ManagerContentPage({ model, router, locale }: { readonly model: ManagerModel; readonly router: ManagerRouter; readonly locale: string }) {
  const seat = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const route = router.route
  const contributionId = route.kind === 'manager-content' ? route.id : undefined
  const presentation = contributionId === undefined || route.kind !== 'manager-content'
    ? undefined
    : model.managerContentPresentation?.(contributionId, route.reference)
  const activeTab = presentation?.tabs.find(tab => tab.active)
  useEffect(() => {
    if (route.kind !== 'manager-content' || seat.current === null) return
    if (model.mountManagerContent === undefined) { setState('error'); return }
    setState('loading')
    let disposed = false
    let mount: Awaited<ReturnType<NonNullable<ManagerModel['mountManagerContent']>>> | undefined
    void model.mountManagerContent(route.id, route.reference, seat.current, {
      navigate: async reference => router.navigate({ kind: 'manager-content', id: route.id, reference }),
      back: async () => router.back(),
    }).then(value => {
      if (disposed) value.abort()
      else { mount = value; setState('ready') }
    }).catch(() => { if (!disposed) setState('error') })
    return () => { disposed = true; mount?.abort(); void model.closeManagerContent?.() }
  }, [model, route, router])
  const activateTab = (index: number) => {
    if (presentation === undefined || contributionId === undefined) return
    const tab = presentation.tabs[index]
    if (tab === undefined) return
    tabs.current.get(tab.id)?.focus({ preventScroll: true })
    router.replace({ kind: 'manager-content', id: contributionId, reference: tab.route })
  }
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (presentation === undefined || presentation.tabs.length === 0) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateTab(index)
      return
    }
    const next = event.key === 'ArrowRight' ? (index + 1) % presentation.tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + presentation.tabs.length) % presentation.tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? presentation.tabs.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    activateTab(next)
  }
  return <section className="cxr-page">
    {presentation === undefined || contributionId === undefined || presentation.tabs.length === 0 ? null : <div className="cxr-tabs" role="tablist" aria-label={presentation.title} data-manager-content-tabs="true">
      {presentation.tabs.map((tab, index) => <button key={tab.id} id={`${panelId}-${tab.id}`} ref={node => { if (node === null) tabs.current.delete(tab.id); else tabs.current.set(tab.id, node) }} type="button" role="tab" data-manager-content-tab={tab.id} aria-selected={tab.active} aria-controls={panelId} tabIndex={tab.active ? 0 : -1}
        onKeyDown={event => onTabKeyDown(event, index)} onClick={() => router.replace({ kind: 'manager-content', id: contributionId, reference: tab.route })}>
        <HostSurfaceIcon token={tab.icon} /><span>{tab.label}</span>
      </button>)}
    </div>}
    <div id={panelId} role={activeTab === undefined ? undefined : 'tabpanel'} aria-labelledby={activeTab === undefined ? undefined : `${panelId}-${activeTab.id}`}>
      {state === 'loading' ? <div className="cxr-notice" role="status">{managerCopy(locale, 'manager.content.loading')}</div> : null}
      {state === 'error' ? <div className="cxr-notice" role="alert">{managerCopy(locale, 'manager.content.failed')}</div> : null}
      <div ref={seat} hidden={state === 'error'} />
    </div>
  </section>
}
