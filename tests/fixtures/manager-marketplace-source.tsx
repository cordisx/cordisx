import { mountManagerCollectionHost } from '../../packages/cli/src/renderer/manager/components/ManagerCollection.js'
import React from 'react'
import type { PluginManagementSnapshot } from '../../packages/cli/src/management/contracts.js'
import type { ManagerPluginManagementBinding } from '../../packages/cli/src/renderer/manager/model/plugin-management.js'
import { createRoot } from 'react-dom/client'
import { ManagerApp } from '../../packages/cli/src/renderer/manager/ManagerApp.js'
import type { ManagerModel, ManagerSnapshot } from '../../packages/cli/src/renderer/manager.js'
import { BrowserMarketplaceModel } from '../../packages/cli/src/renderer/marketplace.js'
import { HostManagerNavigationController } from '../../packages/cli/src/renderer/manager/navigation-controller.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { REACT_MANAGER_STYLES } from '../../packages/cli/src/renderer/manager/styles.js'
import { formPageFields } from './form-page-schema.js'

const writes: unknown[] = []
let fail = true
let state: PluginManagementSnapshot = {
  profileId: 'fixture',
  revision: 1,
  sources: [],
  hiddenCatalogEntries: [],
  migrations: { legacyBrowserSourcesV2: true },
  plugins: [],
  runtime: { kind: 'active', runtimeGeneration: 'fixture' },
  activationRevision: 1,
}
const listeners = new Set<(snapshot: PluginManagementSnapshot) => void>()
const binding: ManagerPluginManagementBinding = {
  query: async () => state,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  migrateLegacySources: async () => ({ migrated: false, clearLegacyStorage: false, snapshot: state }),
  mutate: async (request) => {
    writes.push(request)
    if (fail) {
      fail = false
      throw new Error('Fixture save failed')
    }
    if (request.kind !== 'source-add' && request.kind !== 'source-edit') throw new Error('Unexpected fixture mutation')
    state = {
      ...state,
      revision: state.revision + 1,
      sources: [...state.sources.filter(source => request.kind !== 'source-edit' || source.url !== request.url), {
        ...request.source,
        official: false,
        removable: true,
      }],
    }
    listeners.forEach(listener => listener(state))
    await settle()
    return { status: 'applied', snapshot: state, pendingActivation: false }
  },
}
export function mutations() {
  return writes
}
let withSearchRecords = false
let browseRecordCount = 1
let browseFetchGate: Promise<void> | undefined
const marketplace = new BrowserMarketplaceModel(
  undefined,
  async () => {
    await browseFetchGate
    return ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
          homepage: 'https://plugins.example/',
          schemaVersion: 2,
          name: 'Fixture',
          fallbackLocale: 'en',
          plugins: withSearchRecords
            ? Array.from({ length: browseRecordCount }, (_, index) => ({
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json',
              compatibility: { cordisx: '^0.1.0' },
              schemaVersion: 2,
              id: index === 0 ? 'search-permissions' : `search-permissions-${String(index).padStart(2, '0')}`,
              fallbackLocale: 'en',
              name: 'Search permissions',
              description: 'Permission search fixture',
              version: '1.0.0',
              license: 'MIT',
              source: 'https://plugins.example/search',
              authors: [{ name: 'Fixture' }],
              keywords: [],
            }))
            : [],
        }),
    })
  },
)
const navigation = new HostManagerNavigationController()
const snapshot: ManagerSnapshot = {
  version: 'connection-browser-fixture',
  plugins: [
    {
      id: 'form-page-fixture',
      source: 'fixture:form-pages',
      name: 'Form pages fixture',
      status: 'active',
      inject: [],
      config: {},
      configuration: { fields: formPageFields(), revision: 1, writable: true },
    } as ManagerSnapshot['plugins'][number],
  ],
  registrations: [],
  commands: [],
  navigation: { routes: [], pages: [], outlets: [] },
  localization: { locale: 'zh-CN', direction: 'ltr', version: 1 },
  localeCatalogs: [],
  localizationDiagnostics: [],
  permissions: [],
  platform: {
    hostId: 'codex-desktop',
    hostName: 'fixture',
    mode: 'unavailable',
    supportedCapabilities: [],
    diagnostics: [],
    secondConnectionCreated: false,
    rawBridgeExposed: false,
  },
}
const model = { snapshot: () => snapshot, subscribe: () => () => {} } as ManagerModel
export function prepareModelEmptyState() {
  const state = { providers: [], entries: [], loading: false }
  const catalog = {
    epoch: 'fixture',
    sequence: 1,
    views: [],
    connected: true,
    loading: false,
    canCreateConnection: true,
  }
  Object.assign(model, {
    modelProviders: {
      snapshot: () => state,
      subscribe: () => () => {},
      refresh: async () => {},
      management: { snapshot: () => catalog, subscribe: () => () => {}, refresh: async () => {} },
    },
  })
}

let releaseQuery: (() => void) | undefined
export async function receiveSnapshot() {
  releaseQuery?.()
  await settle()
}
export async function refreshSource() {
  state = {
    ...state,
    revision: state.revision + 1,
    sources: state.sources.map(source => ({ ...source, local: { name: 'Server refreshed name' } })),
  }
  listeners.forEach(listener => listener(state))
  await settle()
}
export async function start(delayed = false, nativePane = false) {
  const seat = document.createElement('span')
  document.body.append(seat)
  const theme = new HostThemeProjection(document)
  const themeRoot = document.getElementById('manager')!
  themeRoot.className = 'cxr-root'
  const navigationSeat = document.createElement('div')
  const titlebarSeat = document.createElement('div')
  if (nativePane) {
    themeRoot.dataset.managerSurface = 'pane'
    Object.assign(themeRoot.style, {
      left: '200px',
      top: '44px',
      width: 'calc(100% - 200px)',
      height: 'calc(100% - 44px)',
    })
    navigationSeat.className = 'cxr-root cxr-native-navigation-seat'
    Object.assign(navigationSeat.style, { top: '44px', width: '200px', height: 'calc(100% - 44px)' })
    titlebarSeat.className = 'cxr-root cxr-titlebar-root'
    titlebarSeat.dataset.managerSurface = 'pane'
    Object.assign(titlebarSeat.style, { left: '200px', top: '0px', width: 'calc(100% - 200px)', height: '44px' })
    document.body.append(navigationSeat, titlebarSeat)
    theme.attach(navigationSeat)
    theme.attach(titlebarSeat)
  }
  const root = createRoot(themeRoot)
  theme.attach(themeRoot)
  root.render(
    <>
      <style>{REACT_MANAGER_STYLES}</style>
      <ManagerApp
        model={model}
        marketplace={marketplace}
        pluginManagement={delayed
          ? {
            ...binding,
            query: () =>
              new Promise(resolve => {
                releaseQuery = () => resolve(state)
              }),
          }
          : binding}
        triggerSeat={seat}
        navigationSeat={nativePane ? navigationSeat : undefined}
        titlebarSeat={nativePane ? titlebarSeat : undefined}
        activatePane={nativePane ? () => true : undefined}
        navigationController={navigation}
      />
    </>,
  )
  await settle()
  navigation.openRoute(
    delayed
      ? { kind: 'marketplace-source-edit', url: state.sources[0]!.url }
      : { kind: 'primary', page: 'marketplace' },
  )
  await settle()
  return () => {
    root.unmount()
    theme.dispose()
    seat.remove()
    navigationSeat.remove()
    titlebarSeat.remove()
    delete themeRoot.dataset.managerSurface
    themeRoot.removeAttribute('style')
  }
}
export async function settle() {
  await new Promise(resolve => setTimeout(resolve, 70))
}
export async function type(path: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-config-path="${path}"] input,[data-config-path="${path}"] textarea`,
  )!
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

/** Exercise the same production router from focused Manager regression suites. */
export async function openSearchRoute(
  route: import('../../packages/cli/src/renderer/manager/model/routes.js').ManagerRoute,
) {
  navigation.openRoute(route)
  await settle()
}
export async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('.cxr-content input[type="search"],.cxr-content input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

export function prepareSearchRecords() {
  withSearchRecords = true
  snapshot.pluginBundles = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle-manager-snapshot.v1.schema.json',
    schemaVersion: 1,
    profileId: 'fixture',
    revision: 1,
    pluginRevision: 1,
    runtimeGeneration: 'fixture',
    operationsAvailable: false,
    bundles: [{
      id: 'search-bundle',
      name: 'Search bundle',
      description: 'Search fixture',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      authors: [],
      sourceLabel: 'fixture',
      installedAt: '2026-09-26T00:00:00Z',
      updatedAt: '2026-09-26T00:00:00Z',
      status: 'active',
      enabled: true,
      availableOperations: [],
      members: [],
      permissions: [],
      claims: [],
      dependencies: [],
      records: [],
    }],
  }
}

export async function openMarketplacePermissionSearch() {
  await marketplace.setSources(['https://plugins.example/fixture.json'])
  await marketplace.reload()
  const plugin = marketplace.snapshot().plugins[0]!
  navigation.openRoute({ kind: 'marketplace-plugin', identity: plugin.identity })
  await settle()
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item =>
    item.textContent?.includes('权限')
  )!
  tab.click()
  await settle()
}

export async function openCollectionSearch() {
  await openSearchRoute({ kind: 'primary', page: 'about' })
  const container = document.createElement('div')
  if (document.querySelector('.cxr-root[data-manager-surface="pane"]')) {
    container.className = 'cxr-manager-content-panel'
  }
  document.querySelector('.cxr-content')!.append(container)
  const host = mountManagerCollectionHost(container, {
    document,
    owner: 'fixture',
    routeId: 'fixture:list',
    pageId: 'fixture:list',
    resolveText: value => value.fallback ?? value.key,
    clearTextSite() {},
    navigate: async () => {},
    deepLink: () => 'https://plugins.example/fixture',
    executeCommand: async () => {},
    writeClipboard: async () => {},
    hostCopy: key => key,
  })
  const text = (label: string) => ({ key: label.toLowerCase().replaceAll(' ', '-'), fallback: label })
  host.registry.register({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json',
    contract: 'cordisx.manager-collection-registration/v1',
    schemaVersion: 1,
    id: 'list',
    label: text('List'),
    description: text('Fixture list'),
    views: [{ id: 'all', label: text('All'), emptyTitle: text('Empty'), emptyDescription: text('No records') }],
    defaultView: 'all',
    search: {
      fields: ['title', 'summary'],
      normalization: 'nfkc-casefold',
      label: text('Search collection'),
      placeholder: text('Search'),
      noMatchTitle: text('No matches'),
      noMatchDescription: text('Try again'),
    },
  }, {
    snapshot: query => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json',
      contract: 'cordisx.manager-collection-snapshot/v1',
      schemaVersion: 1,
      collectionId: 'list',
      queryRevision: query.queryRevision,
      view: query.view,
      normalizedSearch: query.search.normalized,
      revision: 1,
      items: [],
    }),
    subscribe: () => () => {},
    dispose() {},
  })
  await settle()
  return () => {
    host.dispose()
    container.remove()
  }
}

/** In-memory records exercise production browse pages without provider writes. */
export async function prepareBrowseRecords() {
  browseRecordCount = 81
  snapshot.plugins = Array.from({ length: 81 }, (_, index) => ({
    ...snapshot.plugins[0]!,
    id: `scroll-plugin-${index}`,
    name: `Scroll plugin ${index}`,
  }))
  snapshot.navigation.routes = Array.from({ length: 81 }, (_, index) => ({
    owner: 'fixture',
    id: `scroll-${index}`,
    qualifiedId: `fixture:scroll-${index}`,
    definition: { id: `scroll-${index}`, path: `/scroll/${index}`, outlet: 'main', page: 'fixture' },
    productMetadata: { title: `Scroll route ${index}` },
    valid: true,
    authorized: true,
    pointPolicy: 'inherit',
    effectivePointPolicy: 'allow',
  })) as ManagerSnapshot['navigation']['routes']
  snapshot.extensionPoints = {
    points: Array.from({ length: 81 }, (_, index) => ({
      id: `fixture.point.${index}`,
      titleProjection: { text: `Scroll point ${index}` },
      descriptionProjection: { text: 'Browse scroll fixture' },
      plugins: [],
    })),
  } as unknown as ManagerSnapshot['extensionPoints']
  state = {
    ...state,
    revision: state.revision + 1,
    sources: Array.from({ length: 81 }, (_, index) => ({
      url: `https://scroll-${index}.example/marketplace.json`,
      enabled: true,
      trusted: false,
      official: false,
      removable: true,
      local: { name: `Scroll source ${index}` },
    })),
  }
  listeners.forEach(listener => listener(state))
  await settle()
  await marketplace.setExternalSourceRecords(state.sources)
  await marketplace.reload()
  await settle()
}

export async function openBrowseLoading() {
  let release!: () => void
  browseFetchGate = new Promise<void>(resolve => {
    release = resolve
  })
  const pending = marketplace.setExternalSourceRecords([{ url: 'https://loading.example/feed.json', enabled: true }])
  await openSearchRoute({ kind: 'primary', page: 'plugins' })
  await openSearchRoute({ kind: 'primary', page: 'marketplace' })
  return async () => {
    browseFetchGate = undefined
    release()
    await pending
  }
}
