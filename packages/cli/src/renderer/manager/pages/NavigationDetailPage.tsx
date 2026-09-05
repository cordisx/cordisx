import type { ManagerSnapshot } from '../../manager.js'
import type { ManagerRouter } from '../model/routes.js'

function values(record: unknown): string {
  return JSON.stringify(record, null, 2)
}

export function NavigationDetailPage(
  { snapshot, router }: { readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter },
) {
  const route = router.route
  const item = route.kind === 'route'
    ? snapshot.navigation.routes.find(candidate => candidate.qualifiedId === route.qualifiedId)
    : route.kind === 'page'
    ? snapshot.navigation.pages.find(candidate => candidate.qualifiedId === route.qualifiedId)
    : undefined
  if (item === undefined) return <div className="cxr-empty">导航记录已不存在</div>
  return (
    <section className="cxr-page cxr-grid">
      <section className="cxr-section">
        <h3>归属</h3>
        <p>{item.owner}</p>
        <code>{item.qualifiedId}</code>
      </section>
      <section className="cxr-section">
        <h3>产品元数据</h3>
        <p>{item.productMetadata.title ?? '未提供标题'}</p>
        <p>{item.productMetadata.description ?? '未提供说明'}</p>
      </section>
      <section className="cxr-section cxr-item-full">
        <h3>声明</h3>
        <pre className="cxr-readable-code">{values('definition' in item ? item.definition : item.metadata)}</pre>
      </section>
    </section>
  )
}
