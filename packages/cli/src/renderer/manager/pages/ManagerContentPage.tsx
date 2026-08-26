import { useEffect, useRef, useState } from 'react'
import type { ManagerModel } from '../../manager.js'
import type { ManagerRouter } from '../model/routes.js'

export function ManagerContentPage({ model, router }: { readonly model: ManagerModel; readonly router: ManagerRouter }) {
  const seat = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const route = router.route
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
  return <section className="cxr-page">{error === undefined ? null : <div className="cxr-notice">{error}</div>}<div ref={seat} /></section>
}
