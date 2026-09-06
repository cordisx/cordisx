import { type CordisXIconToken } from '../../contracts.js'
import type { ExtensionPointPluginUsageSnapshot, ExtensionPointSnapshot } from '.././extension-points.js'
import {
  createHostCollection,
  type HostCollectionItem,
  type HostCollectionStatus,
  type HostCollectionView,
} from '.././host-collection.js'
import { HostFormAdapter } from '.././host-form.js'
import { createHostSurfaceIcon, type ManagerIconToken } from '.././icons.js'
import { managerCopy } from '.././ui-copy.js'
import { create } from './dom.js'
import {
  ExtensionPointDetailTab,
  ExtensionPointRowStatus,
  LocalTabIcon,
  ManagerModel,
  ManagerRouteState,
  ManagerSnapshot,
} from './model.js'
import { EXTENSION_POINT_DETAIL_TABS, LocalizedTab } from './presentation.js'
import {
  activateManagerListRow,
  createLocalTabs,
  createPluginIcon,
  createTabPanel,
  matchesManagerSearch,
} from './widgets.js'

export interface ExtensionPointsDependencies {
  document: Document
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  rememberListScroll: () => void
  operationError: string | undefined
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
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  extensionPointQuery: string
  routeState: ManagerRouteState
  localizeTabs: <T extends string>(
    items: readonly LocalizedTab<T>[],
  ) => readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[]
  extensionPointUsageQueries: Map<string, string>
  createListSearch: (
    id: string,
    label: string,
    placeholder: string,
    value: string,
    onChange: (value: string) => void,
  ) => HTMLDivElement
  forms: HostFormAdapter
  model: ManagerModel
  renderContent: () => void
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createExtensionPoints(dependencies: ExtensionPointsDependencies) {
  const extensionPointRowStatus = (
    snapshot: ManagerSnapshot,
    point: ExtensionPointSnapshot,
    usage?: ExtensionPointPluginUsageSnapshot,
  ): ExtensionPointRowStatus | undefined => {
    const catalogText = snapshot.extensionPoints?.catalogText
    const descriptorError =
      snapshot.extensionPoints?.descriptorDiagnostics.some(item => item.pointId === point.id) === true
      || point.titleProjection.diagnostic !== undefined
      || point.descriptionProjection.diagnostic !== undefined
    if (descriptorError || usage?.authorized === false) {
      return {
        state: 'error',
        text: usage?.authorized === false
          ? catalogText?.status.denied.text ?? '[[catalog.status.denied]]'
          : catalogText?.status.error.text ?? '[[catalog.status.error]]',
        icon: 'host:error',
      }
    }
    if (point.effectiveAdapterSupport === 'unsupported') {
      return {
        state: 'unavailable',
        text: catalogText?.status.unavailable.text ?? '[[catalog.status.unavailable]]',
        icon: 'host:error',
      }
    }
    if (point.effectiveAdapterSupport === 'unverified') {
      return {
        state: 'pending',
        text: catalogText?.status.pending.text ?? '[[catalog.status.pending]]',
        icon: 'host:warning',
      }
    }
    return undefined
  }

  const createExtensionPointCatalogItem = (
    snapshot: ManagerSnapshot,
    point: ExtensionPointSnapshot,
    action: (facet: ExtensionPointDetailTab) => void,
    usage?: ExtensionPointPluginUsageSnapshot,
  ): HTMLDivElement => {
    const listItem = create(dependencies.document, 'div', 'cxm-catalog-item')
    listItem.setAttribute('role', 'listitem')
    const row = create(dependencies.document, 'button', 'cxm-catalog-row')
    row.type = 'button'
    row.dataset.extensionPointId = point.id
    const status = extensionPointRowStatus(snapshot, point, usage)
    row.dataset.extensionPointState = status?.state ?? point.effectiveAdapterSupport
    const icon = createHostSurfaceIcon(dependencies.document, point.icon)
    icon.classList.add('cxm-catalog-icon')
    const copy = create(dependencies.document, 'span', 'cxm-catalog-copy')
    const stableId = create(dependencies.document, 'code', 'cxm-catalog-id', point.id)
    stableId.dataset.copyableExtensionPointId = point.id
    copy.append(
      create(dependencies.document, 'span', 'cxm-catalog-title', point.titleProjection.text),
      create(dependencies.document, 'span', 'cxm-catalog-description', point.descriptionProjection.text),
      stableId,
    )
    row.append(icon, copy)
    if (status !== undefined) {
      const prompt = create(dependencies.document, 'span', 'cxm-catalog-status')
      prompt.dataset.tone = status.state
      prompt.setAttribute('aria-label', status.text)
      const statusIcon = createHostSurfaceIcon(dependencies.document, status.icon)
      statusIcon.classList.add('cxm-catalog-status-icon')
      prompt.append(statusIcon, create(dependencies.document, 'span', 'cxm-catalog-status-copy', status.text))
      row.append(prompt)
    }
    activateManagerListRow(row, () => action(status === undefined ? 'usage' : 'diagnostics'))
    listItem.append(row)
    return listItem
  }

  const renderExtensionPointList = (snapshot: ManagerSnapshot): void => {
    // The primary breadcrumb already says “Extension points”. Adding the old
    // heading copy below it only restated the same page subject.
    dependencies.setHeading(undefined, snapshot, { icon: 'contributions' })
    const points = snapshot.extensionPoints?.points ?? []
    const catalogText = snapshot.extensionPoints?.catalogText
    const items: HostCollectionItem[] = points.map(point => {
      const rowStatus = extensionPointRowStatus(snapshot, point)
      const status: HostCollectionStatus | undefined = rowStatus === undefined
        ? undefined
        : {
          label: rowStatus.text,
          tone: rowStatus.state === 'pending' ? 'warning' : 'danger',
          detail: rowStatus.text,
        }
      return {
        id: point.id,
        title: point.titleProjection.text,
        description: point.descriptionProjection.text,
        machineId: point.id,
        searchText: [
          point.kind,
          catalogText?.category[point.kind].text ?? '',
          catalogText?.owner.host.text ?? '',
          point.payloadFamily,
          point.maturity,
          point.adapterSupport,
          point.effectiveAdapterSupport,
          point.currentContext,
          point.currentContextCode ?? '',
          point.currentContextDetail ?? '',
          ...(point.anchors ?? []).flatMap(
            anchor => [
              anchor.id,
              anchor.adapterSupport,
              anchor.effectiveAdapterSupport,
              anchor.currentContext,
              anchor.availabilityCode ?? '',
              anchor.availabilityDetail ?? '',
            ],
          ),
          ...point.plugins.flatMap(plugin => [plugin.name, plugin.identity.id, plugin.identity.source]),
          ...point.plugins.flatMap(plugin => plugin.registrations.map(item => item.id)),
          ...point.plugins.flatMap(plugin => plugin.routes.map(item => item.qualifiedId)),
        ],
        icon: () => createHostSurfaceIcon(dependencies.document, point.icon),
        ...(status === undefined ? {} : { status }),
        onOpen: () => {
          dependencies.rememberListScroll()
          dependencies.operationError = undefined
          void dependencies.navigateRoute({
            kind: 'extension-point',
            pointId: point.id,
            facet: rowStatus === undefined ? 'usage' : 'diagnostics',
          })
        },
      }
    })
    dependencies.mountHostCollection(dependencies.content, {
      id: 'extension-points',
      label: dependencies.copy('extension.collection-label'),
      items,
      density: 'compact',
      search: {
        label: dependencies.copy('extension.search-label'),
        placeholder: dependencies.copy('extension.search-placeholder'),
        query: dependencies.extensionPointQuery,
        onQueryChange: value => {
          dependencies.extensionPointQuery = value
        },
      },
      emptyLabel: dependencies.copy('extension.empty'),
      noMatchesLabel: dependencies.copy('extension.no-matches'),
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const point = points.find(item => item.id === open.dataset.collectionOpen)
        if (point === undefined) continue
        const rowStatus = extensionPointRowStatus(snapshot, point)
        open.dataset.extensionPointId = point.id
        open.dataset.extensionPointState = rowStatus?.state ?? point.effectiveAdapterSupport
      }
    })
  }

  const renderExtensionPointDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const point = snapshot.extensionPoints?.points.find(item => item.id === id)
    dependencies.setHeading(point?.titleProjection.text ?? '扩展点当前不可用', snapshot)
    if (point === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '该扩展点已不在当前宿主目录中'))
      return
    }
    const activeFacet = dependencies.routeState.kind === 'extension-point' ? dependencies.routeState.facet : 'usage'
    dependencies.content.append(
      createLocalTabs(
        dependencies.document,
        dependencies.localizeTabs(EXTENSION_POINT_DETAIL_TABS),
        activeFacet,
        'data-extension-point-detail-tab',
        (tab) => {
          void dependencies.navigateRoute({
            kind: 'extension-point',
            pointId: id,
            facet: tab as ExtensionPointDetailTab,
          })
        },
      ),
    )

    if (activeFacet === 'usage') {
      const panel = createTabPanel(dependencies.document, '使用情况')
      const query = dependencies.extensionPointUsageQueries.get(point.id) ?? ''
      panel.append(dependencies.createListSearch(
        `extension-point-usage-${point.id}`,
        `搜索${point.titleProjection.text}的插件与贡献`,
        '搜索插件、贡献名称或 id…',
        query,
        value => {
          dependencies.extensionPointUsageQueries.set(point.id, value)
        },
      ))
      const filteredUsages = point.plugins.flatMap(usage => {
        const pluginMatches = matchesManagerSearch(query, [usage.name, usage.description ?? '', usage.identity.id])
        const registrations = usage.registrations.filter(registration =>
          pluginMatches || matchesManagerSearch(query, [
            registration.titleText,
            registration.descriptionText ?? '',
            registration.id,
            registration.qualifiedId,
          ])
        )
        const routes = usage.routes.filter(route =>
          pluginMatches || matchesManagerSearch(query, [
            route.definition.path,
            route.definition.outlet,
            route.qualifiedId,
            `${route.owner}:${route.definition.page}`,
          ])
        )
        if (!pluginMatches && registrations.length === 0 && routes.length === 0) return []
        return [{ usage, registrations, routes }]
      })
      if (point.plugins.length === 0) {
        panel.append(create(dependencies.document, 'div', 'cxm-empty', '当前没有插件使用这个扩展点'))
      } else if (filteredUsages.length === 0) {
        panel.append(create(dependencies.document, 'div', 'cxm-empty', '没有匹配的插件或贡献'))
      }
      const list = create(dependencies.document, 'div', 'cxm-usage-list')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-label', `${point.titleProjection.text}使用列表`)
      for (const { usage, registrations, routes } of filteredUsages) {
        const item = create(dependencies.document, 'div', 'cxm-usage-item')
        item.setAttribute('role', 'listitem')
        const headerRow = create(dependencies.document, 'div', 'cxm-usage-header')
        const identity = create(dependencies.document, 'div', 'cxm-usage-identity')
        const pluginCopy = create(dependencies.document, 'div', 'cxm-plugin-body')
        pluginCopy.append(
          create(dependencies.document, 'div', 'cxm-plugin-name', usage.name),
          create(dependencies.document, 'div', 'cxm-plugin-description', usage.description ?? '本地 CordisX 插件'),
          create(dependencies.document, 'code', 'cxm-catalog-id', usage.identity.id),
        )
        identity.append(createPluginIcon(dependencies.document, usage.name), pluginCopy)
        type PointPolicy = 'inherit' | 'allow' | 'deny'
        const policy = dependencies.forms.select<PointPolicy>(
          `${usage.name}使用${point.titleProjection.text}的策略`,
          (['inherit', 'allow', 'deny'] as const).map(value => ({
            value,
            label: value === 'inherit' ? '跟随宿主默认' : value === 'allow' ? '允许' : '拒绝',
          })),
          usage.policy,
          value => {
            if (value === undefined) return
            policy.setBusy(true)
            void (async () => {
              dependencies.operationError = undefined
              try {
                await dependencies.model.setExtensionPointPolicy?.(
                  usage.identity.source,
                  usage.identity.id,
                  point.id,
                  value,
                )
              } catch (error) {
                dependencies.operationError = error instanceof Error ? error.message : String(error)
              } finally {
                dependencies.renderContent()
              }
            })()
          },
          { disabled: dependencies.model.setExtensionPointPolicy === undefined },
        )
        policy.classList.add('cxm-usage-policy-select')
        headerRow.append(identity, policy)
        item.append(headerRow)
        const resources = create(dependencies.document, 'div', 'cxm-usage-resources')
        if (point.kind === 'surface') {
          for (const registration of registrations) {
            const state = !registration.valid
              ? '无效'
              : !registration.authorized
              ? '已拒绝'
              : registration.rendered
              ? '已渲染'
              : registration.pending
              ? '等待宿主锚点'
              : '已登记'
            const resource = create(dependencies.document, 'div', 'cxm-resource-row')
            resource.dataset.contributionId = registration.id
            resource.append(
              create(dependencies.document, 'span', 'cxm-resource-title', registration.titleText),
              create(
                dependencies.document,
                'span',
                'cxm-resource-description',
                `${registration.descriptionText ?? '结构化贡献'} · ${state}`,
              ),
              create(dependencies.document, 'code', 'cxm-resource-id', registration.id),
            )
            resources.append(resource)
          }
        } else {
          for (const route of routes) {
            const pageId = `${route.owner}:${route.definition.page}`
            const resource = create(dependencies.document, 'div', 'cxm-resource-row')
            resource.dataset.routeContributionId = route.qualifiedId
            resource.append(
              create(dependencies.document, 'span', 'cxm-resource-title', route.definition.path),
              create(
                dependencies.document,
                'span',
                'cxm-resource-description',
                `在 ${route.definition.outlet} 中打开 ${pageId} · ${route.authorized ? '已授权' : '已拒绝'}`,
              ),
              create(dependencies.document, 'code', 'cxm-resource-id', route.qualifiedId),
            )
            resources.append(resource)
          }
        }
        if (resources.childElementCount > 0) item.append(resources)
        list.append(item)
      }
      if (filteredUsages.length > 0) panel.append(list)
      if (dependencies.operationError !== undefined) {
        panel.append(create(dependencies.document, 'div', 'cxm-error', dependencies.operationError))
      }
      dependencies.content.append(panel)
      return
    }

    if (activeFacet === 'information') {
      const panel = createTabPanel(dependencies.document, '点位信息')
      const fields = create(dependencies.document, 'div', 'cxm-detail-grid')
      const outlet = point.kind === 'outlet'
        ? snapshot.navigation.outlets.find(item => item.id === point.id)
        : undefined
      const maturityLabel = point.maturity === 'stable'
        ? '稳定'
        : point.maturity === 'experimental'
        ? '实验性'
        : '协议保留'
      const supportLabel = point.effectiveAdapterSupport === 'supported'
        ? '已支持'
        : point.effectiveAdapterSupport === 'unverified'
        ? '尚未验证'
        : '不支持'
      const declaredSupportLabel = point.adapterSupport === 'supported'
        ? '已支持'
        : point.adapterSupport === 'unverified'
        ? '尚未验证'
        : '不支持'
      const contextLabel = point.currentContext === 'active'
        ? '当前已挂载'
        : point.currentContext === 'inactive'
        ? '当前上下文未激活'
        : '当前页面未挂载'
      const rows: readonly (readonly [string, string])[] = [
        ['稳定标识', point.id],
        ['类型', point.kind === 'surface' ? '结构化界面点位' : '覆盖页面出口'],
        ['载荷族', point.payloadFamily],
        ['宿主图标', point.icon],
        ['成熟度', maturityLabel],
        ['适配器支持', supportLabel],
        ...(point.effectiveAdapterSupport === point.adapterSupport
          ? []
          : [['目录声明支持', declaredSupportLabel]] as const),
        ['当前上下文', contextLabel],
        ...(point.currentContextCode === undefined ? [] : [['上下文代码', point.currentContextCode]] as const),
        ...(point.currentContextDetail === undefined ? [] : [['上下文详情', point.currentContextDetail]] as const),
        ...(point.anchors ?? []).map(anchor =>
          [
            `语义锚点 ${anchor.id}`,
            `${anchor.placements.join('/')} · ${anchor.effectiveAdapterSupport} · ${anchor.currentContext}${
              anchor.availabilityCode === undefined ? '' : ` · ${anchor.availabilityCode}`
            }${anchor.availabilityDetail === undefined ? '' : ` · ${anchor.availabilityDetail}`}`,
          ] as const
        ),
        ...(outlet === undefined ? [] : [
          ['覆盖方式', outlet.placement],
          ['上下文', outlet.contextKey ?? '等待宿主上下文'],
        ] as const),
      ]
      for (const [label, value] of rows) {
        const field = create(dependencies.document, 'div', 'cxm-field')
        field.append(
          create(dependencies.document, 'div', 'cxm-field-label', label),
          create(dependencies.document, 'div', 'cxm-field-value', value),
        )
        fields.append(field)
      }
      panel.append(fields)
      dependencies.content.append(panel)
      return
    }

    const panel = createTabPanel(dependencies.document, '诊断')
    const diagnostics = [
      ...(point.currentContextCode === undefined ? [] : [point.currentContextCode]),
      ...(point.currentContextDetail === undefined ? [] : [point.currentContextDetail]),
      ...(point.anchors ?? []).flatMap(anchor => [
        ...(anchor.availabilityCode === undefined ? [] : [`${anchor.id} · ${anchor.availabilityCode}`]),
        ...(anchor.availabilityDetail === undefined ? [] : [`${anchor.id} · ${anchor.availabilityDetail}`]),
      ]),
      ...(snapshot.extensionPoints?.descriptorDiagnostics.filter(item => item.pointId === point.id).map(item =>
        `${item.code} · ${item.message}`
      ) ?? []),
      ...(snapshot.extensionPoints?.policyDiagnostics.filter(item => item.identity.pointId === point.id).map(item =>
        `${item.code} · ${item.message}`
      ) ?? []),
      ...(snapshot.extensionPoints?.accessDiagnostics.filter(item => item.request.identity.pointId === point.id).map(
        item =>
          `${item.request.operation} · ${item.authorized ? '允许' : '拒绝'}${
            item.reason === undefined ? '' : ` · ${item.reason}`
          }`,
      ) ?? []),
    ]
    if (diagnostics.length === 0) {
      panel.append(create(dependencies.document, 'div', 'cxm-empty', '当前没有与这个扩展点相关的诊断'))
    }
    for (const diagnostic of diagnostics) panel.append(create(dependencies.document, 'div', 'cxm-error', diagnostic))
    dependencies.content.append(panel)
  }
  return { extensionPointRowStatus, renderExtensionPointList, renderExtensionPointDetail }
}
