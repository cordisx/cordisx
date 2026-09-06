import { createHostCollection, type HostCollectionView } from '.././host-collection.js'
import { HostThemeProjection } from '.././host-theme.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { HostTooltipController } from '.././tooltips.js'
import { create } from './dom.js'

export interface CollectionsDependencies {
  document: Document
  tooltips: HostTooltipController
  theme: HostThemeProjection
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createCollections(dependencies: CollectionsDependencies) {
  const hostCollections = new Set<HostCollectionView>()
  const disposeHostCollections = (): void => {
    for (const view of hostCollections) view.dispose()
    hostCollections.clear()
  }
  const mountHostCollection = (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ): HostCollectionView => {
    const search = options.search === undefined
      ? {
        icon: () => createManagerIcon(dependencies.document, 'search'),
        clearIcon: () => createManagerIcon(dependencies.document, 'close'),
      }
      : 'enabled' in options.search
      ? options.search
      : {
        icon: () => createManagerIcon(dependencies.document, 'search'),
        clearIcon: () => createManagerIcon(dependencies.document, 'close'),
        ...options.search,
      }
    const view = createHostCollection(dependencies.document, {
      ...options,
      moreIcon: options.moreIcon ?? (() => createManagerIcon(dependencies.document, 'more')),
      tooltips: options.tooltips ?? dependencies.tooltips,
      attachPortalTheme: options.attachPortalTheme ?? (portal => dependencies.theme.attach(portal)),
      search,
    })
    hostCollections.add(view)
    decorate?.(view.element)
    target.append(view.element)
    return view
  }
  const managerIconAction = (
    icon: ManagerIconToken,
    label: string,
    options: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    } = {},
  ): HTMLButtonElement => {
    const button = create(
      dependencies.document,
      'button',
      ['cxm-manager-icon-action', options.className].filter(Boolean).join(' '),
    )
    button.type = 'button'
    button.dataset.cordisxNoDrag = 'true'
    button.setAttribute('aria-label', label)
    if (options.description !== undefined) button.setAttribute('aria-description', options.description)
    if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
    button.disabled = options.disabled === true
    button.append(createManagerIcon(dependencies.document, icon))
    dependencies.tooltips.attach(
      button,
      () => options.description === undefined ? label : `${label} · ${options.description}`,
      'top',
    )
    return button
  }
  return { disposeHostCollections, mountHostCollection, managerIconAction }
}
