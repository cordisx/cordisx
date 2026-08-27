import { useEffect, useRef, useState } from 'react'
import type { ManagerModel } from '../../manager.js'
import { HostSurfaceIcon } from '../../host-ui/HostSurfaceIcon.js'
import type { ManagerRouter } from '../model/routes.js'

export function ManagerContentPage({ model, router }: { readonly model: ManagerModel; readonly router: ManagerRouter }) {
  const seat = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const route = router.route
  const contributionId = route.kind === 'manager-content' ? route.id : undefined
  const presentation = contributionId === undefined || route.kind !== 'manager-content'
    ? undefined
    : model.managerContentPresentation?.(contributionId, route.reference)
  useEffect(() => {
    if (route.kind !== 'manager-content' || seat.current === null || model.mountManagerContent === undefined) return
    let disposed = false
    let mount: Awaited<ReturnType<NonNullable<ManagerModel['mountManagerContent']>>> | undefined
    void model.mountManagerContent(route.id, route.reference, seat.current, {
      navigate: async reference => router.navigate({ kind: 'manager-content', id: route.id, reference }),
      back: async () => router.back(),
    }).then(value => { if (disposed) value.abort(); else mount = value }).catch(error => setError(error instanceof Error ? error.message : String(error)))
    return () => { disposed = true; mount?.abort(); void model.closeManagerContent?.() }
  }, [model, route, router])
  return <section className="cxr-page">
    {presentation === undefined || contributionId === undefined || presentation.tabs.length === 0 ? null : <div className="cxr-tabs" role="tablist" aria-label={presentation.title} data-manager-content-tabs="true">
      {presentation.tabs.map(tab => <button key={tab.id} type="button" role="tab" data-manager-content-tab={tab.id} aria-selected={tab.active} onClick={() => router.navigate({ kind: 'manager-content', id: contributionId, reference: tab.route })}>
        <HostSurfaceIcon token={tab.icon} /><span>{tab.label}</span>
      </button>)}
    </div>}
    {error === undefined ? null : <div className="cxr-notice">{error}</div>}<div ref={seat} />
  </section>
}
