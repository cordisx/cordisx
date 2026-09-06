import { type CordisXIconToken } from '../../contracts.js'
import { createHostSurfaceIcon, createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { managerCopy } from '.././ui-copy.js'
import { projectManagerBreadcrumbs } from './breadcrumbs.js'
import { create, createAdaptiveBrandMark } from './dom.js'
import { BreadcrumbProjection, ManagerPageRoute, ManagerRouteState, ManagerSnapshot } from './model.js'

export interface HeadingDependencies {
  breadcrumbCleanup: () => void
  document: Document
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  listScrollPositions: Map<string, number>
  activePrimary: (route?: ManagerRouteState) => string
  content: HTMLDivElement
  renderContent: () => void
  heading: HTMLDivElement
  resolvePageRoute: (snapshot: ManagerSnapshot) => ManagerPageRoute
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  navigateBack: () => Promise<void>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createHeading(dependencies: HeadingDependencies) {
  const renderBreadcrumbs = (route: ManagerPageRoute): HTMLElement => {
    dependencies.breadcrumbCleanup()
    dependencies.breadcrumbCleanup = () => {}
    const breadcrumbs = create(dependencies.document, 'nav', 'cxm-breadcrumbs')
    breadcrumbs.setAttribute('aria-label', '面包屑')
    breadcrumbs.dataset.managerPageRoute = route.id
    const list = create(dependencies.document, 'ol', 'cxm-breadcrumb-list')
    breadcrumbs.append(list)

    const renderProjection = (projection: BreadcrumbProjection): void => {
      list.replaceChildren()
      breadcrumbs.dataset.breadcrumbOverflowCount = String(projection.overflow.length)
      const visible = new Set(projection.visible)
      const firstOverflow = projection.overflow[0]
      const appendSeparator = (item: HTMLElement): void => {
        if (list.childElementCount > 0) {
          item.append(create(dependencies.document, 'span', 'cxm-breadcrumb-separator', '/'))
        }
      }
      for (const [index, segment] of route.segments.entries()) {
        if (index === firstOverflow) {
          const item = create(dependencies.document, 'li', 'cxm-breadcrumb-item')
          appendSeparator(item)
          const overflow = create(dependencies.document, 'details', 'cxm-breadcrumb-overflow')
          const summary = create(dependencies.document, 'summary', undefined, '…')
          summary.setAttribute('aria-label', '显示省略的上级页面')
          const menu = create(dependencies.document, 'div', 'cxm-breadcrumb-menu')
          menu.setAttribute('role', 'menu')
          for (const hiddenIndex of projection.overflow) {
            const hidden = route.segments[hiddenIndex]
            if (hidden?.target === undefined) continue
            const action = create(dependencies.document, 'button', 'cxm-breadcrumb-action', hidden.label)
            action.type = 'button'
            action.dataset.breadcrumbTarget = hidden.id
            action.setAttribute('role', 'menuitem')
            action.addEventListener('click', () => {
              overflow.open = false
              void dependencies.navigateRoute(hidden.target!)
            })
            menu.append(action)
          }
          overflow.append(summary, menu)
          item.append(overflow)
          list.append(item)
        }
        if (!visible.has(index)) continue
        const item = create(dependencies.document, 'li', 'cxm-breadcrumb-item')
        item.dataset.breadcrumbIndex = String(index)
        appendSeparator(item)
        if (index === route.segments.length - 1) {
          const current = create(dependencies.document, 'span', 'cxm-breadcrumb-current', segment.label)
          current.dataset.breadcrumbCurrent = segment.id
          current.setAttribute('aria-current', 'page')
          item.append(current)
        } else if (segment.target !== undefined) {
          const action = create(dependencies.document, 'button', 'cxm-breadcrumb-action', segment.label)
          action.type = 'button'
          action.dataset.breadcrumbTarget = segment.id
          action.addEventListener('click', () => {
            void dependencies.navigateRoute(segment.target!)
          })
          item.append(action)
        }
        list.append(item)
      }
    }

    const full: BreadcrumbProjection = { visible: route.segments.map((_, index) => index), overflow: [] }
    renderProjection(full)
    const view = dependencies.document.defaultView
    const recalculate = (): void => {
      if (!breadcrumbs.isConnected || breadcrumbs.clientWidth <= 0) return
      renderProjection(full)
      const widths = route.segments.map((_, index) => {
        const item = list.querySelector<HTMLElement>(`[data-breadcrumb-index="${index}"]`)
        if (item === null) return 0
        // The current item fills free flex space, so its outer rectangle is
        // not its content width. Project from its label and separator instead:
        // a comfortable header keeps every segment, while only real pressure
        // introduces the explicit overflow menu.
        const label = item.querySelector<HTMLElement>('.cxm-breadcrumb-action, .cxm-breadcrumb-current')
        const separator = item.querySelector<HTMLElement>('.cxm-breadcrumb-separator')
        const naturalWidth = (label?.scrollWidth ?? 0) + (separator?.getBoundingClientRect().width ?? 0)
        // JSDOM has no layout width for leaf inline elements; its Host DOM
        // regression harness supplies the item geometry instead.
        return naturalWidth > 0 ? naturalWidth : Math.max(item.getBoundingClientRect().width, item.scrollWidth)
      })
      const projection = projectManagerBreadcrumbs(widths, breadcrumbs.clientWidth)
      renderProjection(projection)
    }
    const ResizeObserverConstructor = view?.ResizeObserver
    const resizeObserver = ResizeObserverConstructor === undefined
      ? undefined
      : new ResizeObserverConstructor(recalculate)
    resizeObserver?.observe(breadcrumbs)
    view?.addEventListener('resize', recalculate)
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(recalculate)
    else queueMicrotask(recalculate)
    dependencies.breadcrumbCleanup = () => {
      resizeObserver?.disconnect()
      view?.removeEventListener('resize', recalculate)
    }
    return breadcrumbs
  }

  const rememberListScroll = (): void => {
    dependencies.listScrollPositions.set(dependencies.activePrimary(), dependencies.content.scrollTop)
  }

  const restoreListScroll = (): void => {
    dependencies.content.scrollTop = dependencies.listScrollPositions.get(dependencies.activePrimary()) ?? 0
  }

  const createListSearch = (
    id: string,
    label: string,
    placeholder: string,
    value: string,
    onChange: (value: string) => void,
  ): HTMLDivElement => {
    const root = create(dependencies.document, 'div', 'cxm-list-search')
    root.dataset.listSearch = id
    root.setAttribute('role', 'search')
    root.append(createManagerIcon(dependencies.document, 'search', 'cxm-list-search-icon'))
    const input = create(dependencies.document, 'input', 'cxm-search')
    input.type = 'search'
    input.placeholder = placeholder
    input.value = value
    input.setAttribute('aria-label', label)
    const clear = create(dependencies.document, 'button', 'cxm-list-search-clear')
    clear.type = 'button'
    clear.setAttribute('aria-label', `清除${label}`)
    clear.append(createManagerIcon(dependencies.document, 'close'))
    clear.hidden = value.length === 0
    const update = (next: string): void => {
      onChange(next)
      dependencies.renderContent()
      const replacement = dependencies.content.querySelector<HTMLInputElement>(`[data-list-search="${id}"] .cxm-search`)
      replacement?.focus()
      replacement?.setSelectionRange(next.length, next.length)
    }
    input.addEventListener('input', () => update(input.value))
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (input.value.length > 0) update('')
      else input.blur()
    })
    clear.addEventListener('click', () => update(''))
    root.append(input, clear)
    return root
  }

  const setHeading = (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean } = {},
  ): void => {
    dependencies.heading.replaceChildren()
    delete dependencies.heading.dataset.headingActions
    const pageRoute = dependencies.resolvePageRoute(snapshot)
    const row = create(dependencies.document, 'div', 'cxm-heading-row')
    if (pageRoute.segments.length > 1) {
      const back = create(dependencies.document, 'button', 'cxm-heading-leading cxm-back')
      back.type = 'button'
      back.setAttribute('aria-label', dependencies.copy('manager.back'))
      back.append(createManagerIcon(dependencies.document, 'back', 'cxm-back-icon'))
      back.addEventListener('click', () => {
        void dependencies.navigateBack()
      })
      // History owns the one stable leading seat. Do not place a decorative
      // icon next to Back: it shifts the title and creates duplicate chrome.
      row.append(back)
    } else {
      const icon = options.brand === true
        ? createAdaptiveBrandMark(dependencies.document)
        : String(options.icon ?? 'plugins').startsWith('host:')
        ? createHostSurfaceIcon(dependencies.document, options.icon as CordisXIconToken)
        : createManagerIcon(
          dependencies.document,
          options.icon === undefined ? 'plugins' : options.icon as ManagerIconToken,
        )
      icon.classList.add('cxm-heading-leading', 'cxm-heading-icon')
      icon.setAttribute('aria-hidden', 'true')
      row.append(icon)
    }
    const title = create(dependencies.document, 'div', 'cxm-heading-title')
    const current = pageRoute.segments.at(-1)?.label ?? ''
    title.append(
      create(dependencies.document, 'h2', 'cxm-heading-current-heading', current),
      renderBreadcrumbs(pageRoute),
    )
    row.append(title)
    dependencies.heading.append(row)
    // Breadcrumbs already identify a detail page. Repeating generic wording
    // such as “Plugin details” or “Configuration” expands shared chrome
    // without adding context; primary pages may retain a distinct purpose.
    const description = headingCopy?.trim()
    if (
      pageRoute.segments.length <= 1 && description !== undefined && description !== ''
      && description !== current.trim()
    ) {
      dependencies.heading.append(create(dependencies.document, 'p', undefined, description))
    }
  }

  const setDirectManagerNavigationHeading = (title: string, icon: CordisXIconToken): void => {
    dependencies.breadcrumbCleanup()
    dependencies.breadcrumbCleanup = () => {}
    dependencies.heading.replaceChildren()
    delete dependencies.heading.dataset.headingActions
    const row = create(dependencies.document, 'div', 'cxm-heading-row')
    const leading = createHostSurfaceIcon(dependencies.document, icon)
    leading.classList.add('cxm-heading-leading', 'cxm-heading-icon')
    leading.setAttribute('aria-hidden', 'true')
    row.append(leading, create(dependencies.document, 'h2', 'cxm-heading-direct-title', title))
    dependencies.heading.append(row)
  }
  return { rememberListScroll, restoreListScroll, createListSearch, setHeading, setDirectManagerNavigationHeading }
}
