import React from 'react'
import type { PluginManagementSnapshot } from '../../packages/cli/src/management/contracts.js'
import type { ManagerPluginManagementBinding } from '../../packages/cli/src/renderer/manager/model/plugin-management.js'
import { createRoot } from 'react-dom/client'
import { ManagerApp } from '../../packages/cli/src/renderer/manager/ManagerApp.js'
import type { ManagerModel, ManagerSnapshot } from '../../packages/cli/src/renderer/manager.js'
import { BrowserMarketplaceModel } from '../../packages/cli/src/renderer/marketplace.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { HostManagerNavigationController } from '../../packages/cli/src/renderer/manager/navigation-controller.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { REACT_MANAGER_STYLES } from '../../packages/cli/src/renderer/manager/styles.js'
import { catalogFixture } from '../helpers/catalog-management-fixture.js'
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
    return { status: 'applied', snapshot: state, pendingActivation: false }
  },
}
export function mutations() {
  return writes
}
const marketplace = new BrowserMarketplaceModel(
  undefined,
  async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ schemaVersion: 2, name: 'Fixture', plugins: [] }),
  }),
)
const host = catalogFixture([])
const registry = new ModelProviderRegistry(async () => [])
registry.management = host.client
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
const model = { snapshot: () => snapshot, subscribe: () => () => {}, modelProviders: registry } as ManagerModel
export async function start() {
  const seat = document.createElement('span')
  document.body.append(seat)
  const theme = new HostThemeProjection(document)
  const themeRoot = document.getElementById('manager')!
  themeRoot.className = 'cxr-root'
  const root = createRoot(themeRoot)
  theme.attach(themeRoot)
  root.render(
    <>
      <style>{REACT_MANAGER_STYLES}</style>
      <ManagerApp
        model={model}
        marketplace={marketplace}
        pluginManagement={binding}
        triggerSeat={seat}
        navigationController={navigation}
      />
    </>,
  )
  await host.client.refresh()
  await settle()
  navigation.openRoute({ kind: 'primary', page: 'marketplace' })
  await settle()
  return () => {
    root.unmount()
    marketplace.dispose()
    registry.dispose()
    theme.dispose()
    seat.remove()
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
