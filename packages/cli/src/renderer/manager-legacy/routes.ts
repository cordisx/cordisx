import { type CordisXIconToken } from '../../contracts.js'
import {
  createHostCollection,
  type HostCollectionItem,
  type HostCollectionStatus,
  type HostCollectionView,
} from '.././host-collection.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import type { NavigationPageSnapshot, RouteSnapshot } from '.././navigation.js'
import { managerCopy } from '.././ui-copy.js'
import { create } from './dom.js'
import { ManagerRouteState, ManagerSnapshot } from './model.js'
import { activateManagerListRow } from './widgets.js'

export interface RoutesDependencies {
  document: Document
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  rememberListScroll: () => void
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  mountHostCollection: (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ) => HostCollectionView
  content: HTMLDivElement
  routeQuery: string
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createRoutes(dependencies: RoutesDependencies) {
  const managerLanguage = (snapshot: ManagerSnapshot): string => {
    try {
      return new Intl.Locale(snapshot.localization.locale).language
    } catch {
      return 'en'
    }
  }

  const missingMetadataText = (snapshot: ManagerSnapshot, field: 'title' | 'description'): string => {
    const zh = managerLanguage(snapshot) === 'zh'
    if (field === 'title') return zh ? '未提供标题' : 'No title provided'
    return zh ? '未提供说明' : 'No description provided'
  }

  const qualifiedNavigationId = (owner: string, id: string): string => id.includes(':') ? id : `${owner}:${id}`

  const routeParameterNames = (path: string): readonly string[] => (
    [...path.matchAll(/:([a-z][a-zA-Z0-9]*)/g)].map(match => `:${match[1]}`)
  )

  const createRouteMachineMetadata = (
    items: readonly { readonly label: string; readonly value: string }[],
  ): HTMLElement => {
    const metadata = create(dependencies.document, 'dl', 'cxm-route-machine')
    for (const item of items) {
      const field = create(dependencies.document, 'div', 'cxm-route-machine-item')
      field.append(
        create(dependencies.document, 'dt', undefined, item.label),
        create(dependencies.document, 'dd', undefined, item.value),
      )
      metadata.append(field)
    }
    return metadata
  }

  const createRouteMetadataDiagnostic = (
    snapshot: ManagerSnapshot,
    item: RouteSnapshot | NavigationPageSnapshot,
  ): HTMLElement | undefined => {
    if (item.productMetadata.diagnostics.length === 0) return undefined
    const fields = item.productMetadata.diagnostics.map(diagnostic => diagnostic.field)
    const zh = managerLanguage(snapshot) === 'zh'
    const names = fields.map(field =>
      field === 'title'
        ? (zh ? '标题' : 'title')
        : (zh ? '说明' : 'description')
    )
    const diagnostic = create(dependencies.document, 'div', 'cxm-route-metadata-diagnostic')
    diagnostic.dataset.metadataDiagnostic = fields.join(',')
    diagnostic.title = item.productMetadata.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join('\n')
    diagnostic.append(
      createManagerIcon(dependencies.document, 'diagnostics'),
      create(
        dependencies.document,
        'span',
        undefined,
        zh
          ? `贡献作者应补充本地化${names.join('、')} metadata`
          : `Contribution author should add localized ${names.join(' and ')} metadata`,
      ),
    )
    return diagnostic
  }

  const routeSearchValues = (route: RouteSnapshot): readonly string[] => [
    route.productMetadata.title ?? '',
    route.productMetadata.description ?? '',
    route.qualifiedId,
    route.id,
    route.owner,
    route.definition.path,
    route.definition.outlet,
    route.definition.page,
    ...routeParameterNames(route.definition.path),
    route.error ?? '',
  ]

  const pageSearchValues = (
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
  ): readonly string[] => [
    page.productMetadata.title ?? '',
    page.productMetadata.description ?? '',
    page.qualifiedId,
    page.id,
    page.owner,
    page.metadata.chrome ?? 'standard',
    ...routes.flatMap(route => [route.definition.path, route.definition.outlet, route.qualifiedId]),
  ]

  const createRouteProductRow = (
    snapshot: ManagerSnapshot,
    route: RouteSnapshot,
    onActivate?: () => void,
  ): HTMLElement => {
    const item = create(dependencies.document, 'div', 'cxm-route-group-item')
    item.setAttribute('role', 'listitem')
    const row = onActivate === undefined
      ? create(dependencies.document, 'div', 'cxm-route-card')
      : create(dependencies.document, 'button', 'cxm-route-card')
    if (row instanceof dependencies.document.defaultView!.HTMLButtonElement) row.type = 'button'
    row.dataset.routeId = route.qualifiedId
    row.dataset.routeProductRow = route.qualifiedId
    const title = route.productMetadata.title ?? route.qualifiedId
    const description = route.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    row.setAttribute('aria-label', `${title}，${description}，${route.definition.path}，${route.definition.outlet}`)
    const body = create(dependencies.document, 'span', 'cxm-route-card-body')
    const pageId = qualifiedNavigationId(route.owner, route.definition.page)
    const identityItems = pageId === route.qualifiedId
      ? [{ label: '页面 / 贡献', value: route.qualifiedId }]
      : [{ label: '页面', value: pageId }, { label: '贡献', value: route.qualifiedId }]
    body.append(
      create(dependencies.document, 'span', 'cxm-route-card-title', title),
      create(dependencies.document, 'span', 'cxm-route-card-description', description),
      createRouteMachineMetadata([
        { label: '路径', value: route.definition.path },
        { label: '出口', value: route.definition.outlet },
        ...identityItems,
        { label: '参数', value: routeParameterNames(route.definition.path).join(', ') || '—' },
        { label: '来源插件', value: route.owner },
      ]),
    )
    const metadataDiagnostic = createRouteMetadataDiagnostic(snapshot, route)
    if (metadataDiagnostic !== undefined) body.append(metadataDiagnostic)
    if (!route.valid || !route.authorized) {
      const state = create(
        dependencies.document,
        'span',
        'cxm-route-state',
        route.error ?? (route.authorized ? '路由不可用' : '扩展点策略已拒绝'),
      )
      state.dataset.routeState = route.valid ? 'denied' : 'invalid'
      body.append(state)
    }
    row.append(createManagerIcon(dependencies.document, 'routes', 'cxm-route-card-icon'), body)
    if (onActivate !== undefined && row instanceof dependencies.document.defaultView!.HTMLButtonElement) {
      activateManagerListRow(row, onActivate)
    }
    item.append(row)
    return item
  }

  const createPageProductRow = (
    snapshot: ManagerSnapshot,
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
  ): HTMLElement => {
    const item = create(dependencies.document, 'div', 'cxm-route-group-item')
    item.setAttribute('role', 'listitem')
    const row = create(dependencies.document, 'div', 'cxm-route-card')
    row.dataset.pageProductRow = page.qualifiedId
    const title = page.productMetadata.title ?? page.qualifiedId
    const description = page.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    row.setAttribute('aria-label', `${title}，${description}`)
    const body = create(dependencies.document, 'div', 'cxm-route-card-body')
    const outlets = [...new Set(routes.map(route => route.definition.outlet))].sort()
    body.append(
      create(dependencies.document, 'span', 'cxm-route-card-title', title),
      create(dependencies.document, 'span', 'cxm-route-card-description', description),
      createRouteMachineMetadata([
        { label: '页面', value: page.qualifiedId },
        { label: '目标出口', value: outlets.join(', ') || '—' },
        { label: 'Chrome', value: page.metadata.chrome ?? 'standard' },
        { label: '来源插件', value: page.owner },
      ]),
    )
    const metadataDiagnostic = createRouteMetadataDiagnostic(snapshot, page)
    if (metadataDiagnostic !== undefined) body.append(metadataDiagnostic)
    row.append(createManagerIcon(dependencies.document, 'document', 'cxm-route-card-icon'), body)
    item.append(row)
    return item
  }

  const routeCollectionItem = (
    snapshot: ManagerSnapshot,
    route: RouteSnapshot,
    onOpen: () => void,
  ): HostCollectionItem => {
    const title = route.productMetadata.title ?? route.qualifiedId
    const description = route.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    const status: HostCollectionStatus | undefined = !route.valid || !route.authorized
      ? {
        label: route.valid ? '已拒绝' : '无效',
        tone: 'danger',
        detail: route.error ?? (route.authorized ? '路由不可用' : '扩展点策略已拒绝'),
      }
      : route.productMetadata.diagnostics.length > 0
      ? { label: '内容信息待补充', tone: 'warning', detail: '内容信息待补充' }
      : undefined
    return {
      id: `route:${route.qualifiedId}`,
      title,
      description,
      machineId: route.qualifiedId,
      searchText: routeSearchValues(route),
      icon: () => createManagerIcon(dependencies.document, 'routes'),
      ...(status === undefined ? {} : { status }),
      openLabel: `${dependencies.copy('routes.open-route')} · ${title}`,
      onOpen,
    }
  }

  const pageCollectionItem = (
    snapshot: ManagerSnapshot,
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
    onOpen: () => void,
  ): HostCollectionItem => {
    const title = page.productMetadata.title ?? page.qualifiedId
    const description = page.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    const status: HostCollectionStatus | undefined = page.productMetadata.diagnostics.length > 0
      ? { label: '内容信息待补充', tone: 'warning', detail: '内容信息待补充' }
      : undefined
    return {
      id: `page:${page.qualifiedId}`,
      title,
      description,
      machineId: page.qualifiedId,
      searchText: pageSearchValues(page, routes),
      icon: () => createManagerIcon(dependencies.document, 'document'),
      ...(status === undefined ? {} : { status }),
      openLabel: `${dependencies.copy('routes.open-page')} · ${title}`,
      onOpen,
    }
  }

  const createRoutePageSection = (
    id: string,
    title: string,
    copy: string,
    ariaLabel: string,
  ): { readonly section: HTMLElement; readonly list: HTMLElement } => {
    const section = create(dependencies.document, 'section', 'cxm-route-section')
    const headingId = `cxm-route-section-${id}`
    const heading = create(dependencies.document, 'h3', 'cxm-route-section-heading', title)
    heading.id = headingId
    section.setAttribute('aria-labelledby', headingId)
    section.append(heading, create(dependencies.document, 'p', 'cxm-route-section-copy', copy))
    const list = create(dependencies.document, 'div', 'cxm-route-group')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', ariaLabel)
    section.append(list)
    return { section, list }
  }

  const renderRouteList = (snapshot: ManagerSnapshot): void => {
    dependencies.setHeading(dependencies.copy('routes.heading'), snapshot, { icon: 'routes' })
    const items: HostCollectionItem[] = [
      ...snapshot.navigation.routes.map(route =>
        routeCollectionItem(snapshot, route, () => {
          dependencies.rememberListScroll()
          void dependencies.navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        })
      ),
      ...snapshot.navigation.pages.map(page => {
        const routes = snapshot.navigation.routes.filter(route => (
          qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
        ))
        return pageCollectionItem(snapshot, page, routes, () => {
          dependencies.rememberListScroll()
          void dependencies.navigateRoute({ kind: 'page', qualifiedId: page.qualifiedId })
        })
      }),
    ]
    dependencies.mountHostCollection(dependencies.content, {
      id: 'routes',
      label: dependencies.copy('routes.collection-label'),
      items,
      density: 'compact',
      search: {
        label: dependencies.copy('routes.search-label'),
        placeholder: dependencies.copy('routes.search-placeholder'),
        query: dependencies.routeQuery,
        onQueryChange: value => {
          dependencies.routeQuery = value
        },
      },
      emptyLabel: dependencies.copy('routes.empty'),
      noMatchesLabel: dependencies.copy('routes.no-matches'),
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const id = open.dataset.collectionOpen
        if (id?.startsWith('route:')) {
          open.dataset.routeProductRow = id.slice('route:'.length)
          open.dataset.routeId = id.slice('route:'.length)
        } else if (id?.startsWith('page:')) {
          open.dataset.pageProductRow = id.slice('page:'.length)
        }
      }
    })
  }

  const renderRouteDetail = (snapshot: ManagerSnapshot, qualifiedId: string): void => {
    const route = snapshot.navigation.routes.find(item => item.qualifiedId === qualifiedId)
    dependencies.setHeading('路由详情', snapshot)
    if (route === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '该路由已不在当前 bundle 中'))
      return
    }
    const pageId = qualifiedNavigationId(route.owner, route.definition.page)
    const page = snapshot.navigation.pages.find(item => item.qualifiedId === pageId)
    const outlet = snapshot.navigation.outlets.find(item => item.id === route.definition.outlet)
    const presentation = outlet?.activeRoute !== route.qualifiedId
      ? '未打开'
      : outlet.presentation === 'presented'
      ? '展示中'
      : outlet.presentation === 'suspended'
      ? `已暂停${outlet.suspendedBy === undefined ? '' : ` · 由 ${outlet.suspendedBy} 覆盖`}`
      : '未打开'
    const routeSection = createRoutePageSection(
      'detail-route',
      '路由',
      '本地化用途与不可翻译的导航机器信息。',
      `${route.productMetadata.title ?? route.qualifiedId}路由详情`,
    )
    routeSection.list.append(createRouteProductRow(snapshot, route))
    const statusFields = create(dependencies.document, 'div', 'cxm-detail-grid')
    for (
      const [label, value] of [
        ['路由状态', !route.valid ? '无效' : route.authorized ? '已授权' : '已拒绝'],
        ['页面注册', page === undefined ? '缺失' : '已注册'],
        ['出口状态', outlet === undefined ? '未声明' : outlet.available ? '可用' : '不可用'],
        ['展示状态', presentation],
      ]
    ) {
      const field = create(dependencies.document, 'div', 'cxm-field')
      field.append(
        create(dependencies.document, 'div', 'cxm-field-label', label),
        create(dependencies.document, 'div', 'cxm-field-value', value),
      )
      statusFields.append(field)
    }
    dependencies.content.append(routeSection.section)
    if (page !== undefined) {
      const pageRoutes = snapshot.navigation.routes.filter(item => (
        qualifiedNavigationId(item.owner, item.definition.page) === page.qualifiedId
      ))
      const pageSection = createRoutePageSection(
        'detail-page',
        '页面',
        'Host 渲染的页面信息与受控 chrome 范围。',
        `${page.productMetadata.title ?? page.qualifiedId}页面详情`,
      )
      pageSection.list.append(createPageProductRow(snapshot, page, pageRoutes))
      dependencies.content.append(pageSection.section)
    }
    dependencies.content.append(statusFields)
    if (route.error !== undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-error', route.error))
    }
    if (outlet?.error !== undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-error', outlet.error))
    }
  }

  const renderPageDetail = (snapshot: ManagerSnapshot, qualifiedId: string): void => {
    const page = snapshot.navigation.pages.find(item => item.qualifiedId === qualifiedId)
    dependencies.setHeading('页面详情', snapshot)
    if (page === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '该页面已不在当前 bundle 中'))
      return
    }
    const routes = snapshot.navigation.routes.filter(route => (
      qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
    ))
    const pageSection = createRoutePageSection(
      'detail-page',
      '页面',
      'Host 渲染的页面信息与受控 chrome 范围。',
      `${page.productMetadata.title ?? page.qualifiedId}页面详情`,
    )
    pageSection.list.append(createPageProductRow(snapshot, page, routes))
    dependencies.content.append(pageSection.section)
    if (routes.length > 0) {
      const routeSection = createRoutePageSection(
        'detail-page-routes',
        '关联路由',
        '能够导航到这个页面的结构化入口。',
        `${page.productMetadata.title ?? page.qualifiedId}关联路由`,
      )
      for (const route of routes) {
        routeSection.list.append(createRouteProductRow(snapshot, route, () => {
          void dependencies.navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        }))
      }
      dependencies.content.append(routeSection.section)
    }
  }
  return {
    qualifiedNavigationId,
    routeCollectionItem,
    pageCollectionItem,
    renderRouteList,
    renderRouteDetail,
    renderPageDetail,
  }
}
