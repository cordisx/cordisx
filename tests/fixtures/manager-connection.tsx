import React from 'react'
import { createRoot } from 'react-dom/client'
import { ManagerApp } from '../../packages/cli/src/renderer/manager/ManagerApp.js'
import type { ManagerModel, ManagerSnapshot } from '../../packages/cli/src/renderer/manager.js'
import type { MarketplaceModel } from '../../packages/cli/src/renderer/marketplace.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { HostManagerNavigationController } from '../../packages/cli/src/renderer/manager/navigation-controller.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { REACT_MANAGER_STYLES } from '../../packages/cli/src/renderer/manager/styles.js'
import { catalogFixture, catalogView } from '../helpers/catalog-management-fixture.js'

const host = catalogFixture([])
const registry = new ModelProviderRegistry(async () => [])
registry.management = host.client
const navigation = new HostManagerNavigationController()
const snapshot: ManagerSnapshot = {
  version: 'connection-browser-fixture',
  plugins: [],
  registrations: [],
  commands: [],
  navigation: { routes: [], pages: [], outlets: [] },
  localization: { locale: 'zh-CN', direction: 'ltr', version: 1 },
  localeCatalogs: [],
  localizationDiagnostics: [],
  permissions: [],
  platform: {
    hostId: 'fixture',
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
        marketplace={{} as MarketplaceModel}
        triggerSeat={seat}
        navigationController={navigation}
      />
    </>,
  )
  await host.client.refresh()
  await settle()
  navigation.openRoute({ kind: 'primary', page: 'model-services' })
  await settle()
  return () => {
    root.unmount()
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
export async function choose(path: string, label: string) {
  const control = document.querySelector<HTMLElement>(`[data-config-path="${path}"] .t-input`)!
  control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  control.click()
  await settle()
  const option = [...document.querySelectorAll<HTMLElement>('.t-select-option')].find(node =>
    node.textContent?.trim() === label
  )!
  if (!option) {
    throw new Error(
      `Missing ${path} option ${label}: ${
        [...document.querySelectorAll('.t-select-option')].map(node => node.textContent).join(',')
      }`,
    )
  }
  option.click()
  await settle()
}
export async function showReadback() {
  const command = host.commands.at(-1)!
  if (command.operation !== 'createConnection') throw new Error('Expected creation command')
  const state = host.snapshot()
  host.publish({
    ...state,
    sequence: state.sequence + 1,
    views: [catalogView({
      title: command.settings.title,
      connection: command.settings,
    })],
  })
  await host.client.refresh()
  await settle()
}
export function commands() {
  return host.commands
}
