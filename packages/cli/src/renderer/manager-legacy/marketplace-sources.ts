import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import { type CordisXIconToken } from '../../contracts.js'
import { createHostCollection, type HostCollectionItem, type HostCollectionView } from '.././host-collection.js'
import { HostFormAdapter } from '.././host-form.js'
import { HostThemeProjection } from '.././host-theme.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import {
  type MarketplaceModel,
  type MarketplaceSourceRecord,
  type MarketplaceSourceSnapshot,
  normalizeMarketplaceSource,
  OFFICIAL_MARKETPLACE_SOURCE,
  projectMarketplaceSource,
} from '.././marketplace.js'
import { setTDesignDisabled, setTDesignProps, type TDesignElement } from '.././tdesign-form.js'
import { HostTooltipController } from '.././tooltips.js'
import { managerCopy } from '.././ui-copy.js'
import { create } from './dom.js'
import type { ManagerSourceState } from './interaction-state.js'
import { ManagerRouteState, ManagerSnapshot } from './model.js'

export interface MarketplaceSourcesDependencies {
  marketplace: MarketplaceModel
  renderContent: () => void
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  forms: HostFormAdapter
  document: Document
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  managerIconAction: (
    icon: ManagerIconToken,
    label: string,
    options?: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    },
  ) => HTMLButtonElement
  marketplaceCollectionView: HostCollectionView | undefined
  tooltips: HostTooltipController
  theme: HostThemeProjection
  content: HTMLDivElement
  sourceState: Pick<
    ManagerSourceState,
    'sourcesBusy' | 'sourceOperationError' | 'sourceOperationDiagnostic' | 'sourceOperationNotice' | 'sourceQuery'
  >
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createMarketplaceSources(dependencies: MarketplaceSourcesDependencies) {
  const marketplaceSourceState = (
    record: MarketplaceSourceRecord,
    snapshot = dependencies.marketplace.snapshot(),
  ): MarketplaceSourceSnapshot =>
    snapshot.sourceStates.find(item => item.url === record.url) ?? {
      url: record.url,
      enabled: record.enabled,
      official: record.url === OFFICIAL_MARKETPLACE_SOURCE,
      ...(record.local === undefined ? {} : { local: record.local }),
      status: 'loading',
      phase: record.enabled ? 'idle' : 'disabled',
      stale: false,
      revalidating: false,
      attempts: 0,
    }

  const runMarketplaceSourceOperation = async (
    operation: () => Promise<void>,
    success: string,
  ): Promise<boolean> => {
    dependencies.sourceState.sourcesBusy = true
    dependencies.sourceState.sourceOperationError = undefined
    dependencies.sourceState.sourceOperationDiagnostic = undefined
    dependencies.sourceState.sourceOperationNotice = undefined
    dependencies.renderContent()
    try {
      await operation()
      dependencies.sourceState.sourceOperationNotice = success
      return true
    } catch (error) {
      dependencies.sourceState.sourceOperationError = dependencies.copy('marketplace.source.operation-failed')
      dependencies.sourceState.sourceOperationDiagnostic = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      dependencies.sourceState.sourcesBusy = false
      dependencies.renderContent()
    }
  }

  const sourceErrorAlert = (): HTMLElement | undefined => {
    if (dependencies.sourceState.sourceOperationError === undefined) return undefined
    const alert = dependencies.forms.alert(dependencies.sourceState.sourceOperationError, 'error')
    if (
      dependencies.sourceState.sourceOperationDiagnostic !== undefined
      && dependencies.sourceState.sourceOperationDiagnostic !== ''
    ) {
      alert.title = dependencies.sourceState.sourceOperationDiagnostic
    }
    return alert
  }

  const importMarketplaceSourceFromClipboard = async (): Promise<void> => {
    let value: string | null | undefined
    const navigator = dependencies.document.defaultView?.navigator as Navigator & {
      clipboard?: { readText(): Promise<string> }
    }
    try {
      value = typeof navigator?.clipboard?.readText === 'function'
        ? await navigator.clipboard.readText()
        : dependencies.document.defaultView?.prompt(dependencies.copy('marketplace.source.clipboard-prompt'))
    } catch (error) {
      dependencies.sourceState.sourceOperationError = dependencies.copy('marketplace.source.clipboard-unavailable')
      dependencies.sourceState.sourceOperationDiagnostic = error instanceof Error ? error.message : String(error)
      dependencies.sourceState.sourceOperationNotice = undefined
      dependencies.renderContent()
      return
    }
    if (value === undefined || value === null) return
    const imported = await runMarketplaceSourceOperation(
      async () => {
        await dependencies.marketplace.importSource(value!)
      },
      dependencies.copy('marketplace.source.imported'),
    )
    if (imported) await dependencies.navigateRoute({ kind: 'marketplace-source', page: 'index' })
  }

  const renderMarketplaceSourceIndex = (managerSnapshot: ManagerSnapshot): void => {
    const snapshot = dependencies.marketplace.snapshot()
    dependencies.setHeading(dependencies.copy('marketplace.source.index-heading'), managerSnapshot)
    const page = create(dependencies.document, 'section', 'cxm-marketplace-source-page')
    page.dataset.marketplaceSourcePage = 'index'
    const toolbar = create(dependencies.document, 'div', 'cxm-marketplace-source-toolbar')
    const add = dependencies.managerIconAction('marketplace-source-add', dependencies.copy('marketplace.source.add'), {
      disabled: dependencies.sourceState.sourcesBusy,
    })
    add.dataset.marketplaceSourceCreate = 'true'
    add.addEventListener('click', () => {
      void dependencies.navigateRoute({ kind: 'marketplace-source', page: 'create' })
    })
    const clipboard = dependencies.managerIconAction(
      'marketplace-source-copy',
      dependencies.copy('marketplace.source-menu.clipboard'),
      {
        disabled: dependencies.sourceState.sourcesBusy,
      },
    )
    clipboard.dataset.marketplaceSourceClipboard = 'true'
    clipboard.addEventListener('click', () => {
      void importMarketplaceSourceFromClipboard()
    })
    toolbar.append(add, clipboard)
    page.append(toolbar)
    if (dependencies.sourceState.sourceOperationNotice !== undefined) {
      page.append(dependencies.forms.alert(dependencies.sourceState.sourceOperationNotice, 'info'))
    }
    const errorAlert = sourceErrorAlert()
    if (errorAlert !== undefined) page.append(errorAlert)

    const items: HostCollectionItem[] = snapshot.sourceRecords.map((record, index) => {
      const state = marketplaceSourceState(record, snapshot)
      const projection = projectMarketplaceSource(state, managerSnapshot.localization.locale)
      const status = !record.enabled
        ? { label: dependencies.copy('marketplace.source.disabled'), tone: 'neutral' as const }
        : state.status === 'failed'
        ? { label: dependencies.copy('marketplace.source.failed'), tone: 'danger' as const }
        : state.revalidating
        ? { label: dependencies.copy('marketplace.source.updating'), tone: 'progress' as const }
        : state.stale
        ? { label: dependencies.copy('marketplace.source.cached'), tone: 'warning' as const }
        : undefined
      return {
        id: record.url,
        title: projection.name,
        description: projection.description ?? dependencies.copy('marketplace.source.no-description'),
        machineId: record.url,
        searchText: projection.searchValues,
        icon: () =>
          createManagerIcon(
            dependencies.document,
            record.url === OFFICIAL_MARKETPLACE_SOURCE ? 'marketplace-official' : 'marketplace',
          ),
        ...(status === undefined ? {} : { status }),
        openLabel: `${dependencies.copy('marketplace.source.open')} · ${projection.name}`,
        onOpen: () => {
          void dependencies.navigateRoute({ kind: 'marketplace-source', page: 'edit', url: record.url })
        },
        actions: [
          {
            id: record.enabled ? 'disable' : 'enable',
            label: record.enabled
              ? dependencies.copy('marketplace.source.disable')
              : dependencies.copy('marketplace.source.enable'),
            icon: () => createManagerIcon(dependencies.document, record.enabled ? 'disable-plugin' : 'enable-plugin'),
            placement: 'direct',
            disabled: dependencies.sourceState.sourcesBusy,
            onInvoke: async () => {
              await runMarketplaceSourceOperation(
                async () => {
                  await dependencies.marketplace.setSourceEnabled(record.url, !record.enabled)
                },
                record.enabled
                  ? dependencies.copy('marketplace.source.disabled-notice')
                  : dependencies.copy('marketplace.source.enabled-notice'),
              )
            },
          },
          {
            id: 'edit',
            label: dependencies.copy('marketplace.source.edit'),
            icon: () => createManagerIcon(dependencies.document, 'marketplace-source-edit'),
            placement: 'overflow',
            disabled: dependencies.sourceState.sourcesBusy,
            onInvoke: () => {
              void dependencies.navigateRoute({ kind: 'marketplace-source', page: 'edit', url: record.url })
            },
          },
          {
            id: 'move-up',
            label: dependencies.copy('marketplace.source.move-up'),
            icon: () => createManagerIcon(dependencies.document, 'marketplace-source-move-up'),
            placement: 'overflow',
            disabled: dependencies.sourceState.sourcesBusy || index === 0,
            onInvoke: async () => {
              await runMarketplaceSourceOperation(async () => {
                await dependencies.marketplace.moveSource(record.url, index - 1)
              }, dependencies.copy('marketplace.source.moved-notice'))
            },
          },
          {
            id: 'move-down',
            label: dependencies.copy('marketplace.source.move-down'),
            icon: () => createManagerIcon(dependencies.document, 'marketplace-source-move-down'),
            placement: 'overflow',
            disabled: dependencies.sourceState.sourcesBusy || index === snapshot.sourceRecords.length - 1,
            onInvoke: async () => {
              await runMarketplaceSourceOperation(async () => {
                await dependencies.marketplace.moveSource(record.url, index + 1)
              }, dependencies.copy('marketplace.source.moved-notice'))
            },
          },
          {
            id: 'remove',
            label: dependencies.copy('marketplace.source.remove'),
            icon: () => createManagerIcon(dependencies.document, 'uninstall-plugin'),
            placement: 'overflow',
            tone: 'danger',
            disabled: dependencies.sourceState.sourcesBusy || record.url === OFFICIAL_MARKETPLACE_SOURCE,
            ...(record.url === OFFICIAL_MARKETPLACE_SOURCE
              ? { unavailableReason: dependencies.copy('marketplace.source.official-remove-unavailable') }
              : {}),
            onInvoke: async () => {
              await runMarketplaceSourceOperation(async () => {
                await dependencies.marketplace.removeSource(record.url)
              }, dependencies.copy('marketplace.source.removed-notice'))
            },
          },
        ],
      }
    })
    dependencies.marketplaceCollectionView?.dispose()
    dependencies.marketplaceCollectionView = createHostCollection(dependencies.document, {
      id: 'marketplace-sources',
      label: dependencies.copy('marketplace.source.collection-label'),
      layout: 'rows',
      items,
      search: {
        label: dependencies.copy('marketplace.source.search-label'),
        placeholder: dependencies.copy('marketplace.source.search-placeholder'),
        clearLabel: dependencies.copy('marketplace.source.search-clear'),
        query: dependencies.sourceState.sourceQuery,
        onQueryChange: query => {
          dependencies.sourceState.sourceQuery = query
        },
        icon: () => createManagerIcon(dependencies.document, 'search'),
        clearIcon: () => createManagerIcon(dependencies.document, 'close'),
      },
      emptyLabel: dependencies.copy('marketplace.source.empty'),
      noMatchesLabel: dependencies.copy('marketplace.source.no-matches'),
      moreLabel: dependencies.copy('marketplace.source.more-actions'),
      moreIcon: () => createManagerIcon(dependencies.document, 'more'),
      tooltips: dependencies.tooltips,
      attachPortalTheme: portal => dependencies.theme.attach(portal),
    })
    page.append(dependencies.marketplaceCollectionView.element)
    dependencies.content.append(page)
  }

  const renderMarketplaceSourceForm = (
    managerSnapshot: ManagerSnapshot,
    mode: 'create' | 'edit',
    existing?: MarketplaceSourceRecord,
  ): void => {
    const isCreate = mode === 'create'
    const state = existing === undefined ? undefined : marketplaceSourceState(existing)
    const projection = state === undefined
      ? undefined
      : projectMarketplaceSource(state, managerSnapshot.localization.locale)
    dependencies.setHeading(
      isCreate
        ? dependencies.copy('marketplace.source.create-heading')
        : dependencies.copy('marketplace.source.edit-heading'),
      managerSnapshot,
    )
    const page = create(dependencies.document, 'section', 'cxm-marketplace-source-page cxf-scope')
    page.dataset.marketplaceSourcePage = mode
    const form = dependencies.forms.form(`marketplace-source-${mode}`)
    let urlValue = existing?.url ?? ''
    let nameValue = existing?.local?.name ?? ''
    let descriptionValue = existing?.local?.description ?? ''
    let noteValue = existing?.local?.note ?? ''
    let sourceUrlItem: ReturnType<HostFormAdapter['item']> | undefined
    const identitySection = dependencies.forms.section(
      isCreate
        ? dependencies.copy('marketplace.source.url-section')
        : projection?.name ?? dependencies.copy('marketplace.source.edit-heading'),
      isCreate
        ? dependencies.copy('marketplace.source.url-help')
        : dependencies.copy('marketplace.source.readonly-url-help'),
    )
    if (isCreate) {
      const urlItem = dependencies.forms.item({
        id: 'cxm-marketplace-source-url',
        label: dependencies.copy('marketplace.source.url-label'),
        required: true,
        fullWidth: true,
      })
      sourceUrlItem = urlItem
      const field: CordisXConfigFieldSnapshot = {
        namespace: 'cordisx.host',
        path: ['marketplaceSource', 'url'],
        type: 'string',
        role: 'url',
        value: urlValue,
        disabled: dependencies.sourceState.sourcesBusy,
        required: true,
      }
      const control = dependencies.forms.control(field, 'cxm-marketplace-source-url', value => {
        urlValue = typeof value === 'string' ? value.trim() : ''
        urlItem.setError(
          urlValue === '' || /^https:\/\//iu.test(urlValue)
            ? undefined
            : dependencies.copy('marketplace.source.url-invalid'),
        )
      })
      setTDesignProps(control.focusTarget as TDesignElement, {
        placeholder: 'https://example.com/cordisx-marketplace.json',
      })
      dependencies.forms.connect(urlItem, control)
      urlItem.control.append(control.root)
      identitySection.content.append(urlItem.root)
    } else {
      const urlItem = dependencies.forms.item({
        id: 'cxm-marketplace-source-url-readonly',
        label: dependencies.copy('marketplace.source.url-label'),
        fullWidth: true,
      })
      const value = create(dependencies.document, 'div', 'cxm-marketplace-source-readonly', existing!.url)
      value.dataset.marketplaceSourceCanonicalUrl = existing!.url
      urlItem.control.append(value)
      identitySection.content.append(urlItem.root)
    }
    form.append(identitySection.root)

    const localSection = dependencies.forms.section(
      dependencies.copy('marketplace.source.local-section'),
      dependencies.copy('marketplace.source.local-help'),
    )
    const appendTextField = (
      id: string,
      label: string,
      role: 'url' | 'textarea' | undefined,
      value: string,
      onChange: (value: string) => void,
      help: string,
    ): void => {
      const item = dependencies.forms.item({ id, label, help, fullWidth: role === 'textarea' })
      const field: CordisXConfigFieldSnapshot = {
        namespace: 'cordisx.host',
        path: ['marketplaceSource', 'local', id],
        type: 'string',
        value,
        disabled: dependencies.sourceState.sourcesBusy,
        required: false,
        ...(role === undefined ? {} : { role }),
      }
      const control = dependencies.forms.control(field, id, next => onChange(typeof next === 'string' ? next : ''))
      dependencies.forms.connect(item, control)
      item.control.append(control.root)
      localSection.content.append(item.root)
    }
    appendTextField(
      'cxm-marketplace-source-name',
      dependencies.copy('marketplace.source.name-label'),
      undefined,
      nameValue,
      value => {
        nameValue = value
      },
      dependencies.copy('marketplace.source.name-help'),
    )
    appendTextField(
      'cxm-marketplace-source-description',
      dependencies.copy('marketplace.source.description-label'),
      'textarea',
      descriptionValue,
      value => {
        descriptionValue = value
      },
      dependencies.copy('marketplace.source.description-help'),
    )
    appendTextField(
      'cxm-marketplace-source-note',
      dependencies.copy('marketplace.source.note-label'),
      'textarea',
      noteValue,
      value => {
        noteValue = value
      },
      dependencies.copy('marketplace.source.note-help'),
    )
    form.append(localSection.root)

    const submit = dependencies.forms.button(
      isCreate ? dependencies.copy('marketplace.source.create') : dependencies.copy('marketplace.source.save'),
      {
        type: 'submit',
        variant: 'primary',
      },
    )
    setTDesignDisabled(submit, dependencies.sourceState.sourcesBusy)
    const actions = create(dependencies.document, 'div', 'cxf-actions')
    actions.append(submit)
    form.append(actions)
    form.addEventListener('submit', event => {
      event.preventDefault()
      let normalized = existing?.url
      if (isCreate) {
        if (urlValue === '') {
          sourceUrlItem?.setError(dependencies.copy('marketplace.source.url-required'))
          return
        }
        try {
          normalized = normalizeMarketplaceSource(urlValue)
        } catch {
          sourceUrlItem?.setError(dependencies.copy('marketplace.source.url-invalid'))
          return
        }
        if (dependencies.marketplace.snapshot().sourceRecords.some(item => item.url === normalized)) {
          sourceUrlItem?.setError(dependencies.copy('marketplace.source.duplicate'))
          return
        }
      }
      if (normalized === undefined) return
      const name = nameValue.trim()
      const description = descriptionValue.trim()
      const note = noteValue.trim()
      const local = {
        ...(name === '' ? {} : { name }),
        ...(description === '' ? {} : { description }),
        ...(note === '' ? {} : { note }),
      }
      const source: MarketplaceSourceRecord = {
        url: normalized,
        enabled: existing?.enabled ?? true,
        ...(Object.keys(local).length === 0 ? {} : { local }),
      }
      void runMarketplaceSourceOperation(
        async () => {
          await dependencies.marketplace.upsertSource(source)
        },
        isCreate ? dependencies.copy('marketplace.source.added') : dependencies.copy('marketplace.source.saved'),
      ).then(saved => {
        if (saved) void dependencies.navigateRoute({ kind: 'marketplace-source', page: 'index' })
      })
    })
    page.append(form)
    const errorAlert = sourceErrorAlert()
    if (errorAlert !== undefined) page.append(errorAlert)
    dependencies.content.append(page)
  }

  const renderMarketplaceSourcePage = (
    managerSnapshot: ManagerSnapshot,
    route: Extract<ManagerRouteState, { kind: 'marketplace-source' }>,
  ): void => {
    if (route.page === 'index') return renderMarketplaceSourceIndex(managerSnapshot)
    if (route.page === 'create') return renderMarketplaceSourceForm(managerSnapshot, 'create')
    const source = dependencies.marketplace.snapshot().sourceRecords.find(item => item.url === route.url)
    if (source === undefined) return renderMarketplaceSourceIndex(managerSnapshot)
    renderMarketplaceSourceForm(managerSnapshot, 'edit', source)
  }
  return { importMarketplaceSourceFromClipboard, renderMarketplaceSourcePage }
}
