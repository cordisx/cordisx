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
import { formPageFields } from './form-page-schema.js'
import { formPageSchema, formPageValue } from './form-page-schema.js'
import { HostSchemaFormPage, SchemaForm } from '../../packages/cli/src/renderer/host-ui/SchemaForm.js'
export { startConfigBinding } from './form-page-config-binding.js'

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
const pluginUpdates: unknown[] = []
const model = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  modelProviders: registry,
  updatePluginConfig: async (...args: unknown[]) => {
    pluginUpdates.push(args)
  },
} as ManagerModel
export async function showPluginForm() {
  navigation.openRoute({ kind: 'plugin', pluginId: 'form-page-fixture', page: 'config' })
  await settle()
}
export function pluginWrites() {
  return pluginUpdates
}
export async function openFormItem() {
  const layer = document.querySelector('.cxf-form-page-layer:not([hidden])')
    ?? document.querySelector('.cxf-form-page-root:not([hidden])')!
  layer.querySelector<HTMLElement>(
    '[data-config-path="items"] [data-array-action="add"],[data-config-path$=".children"] [data-array-action="add"]',
  )!.click()
  await settle()
}
export async function typeItemName(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    '.cxf-form-page-layer:not([hidden]) [data-config-path$=".name"] input',
  )!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
export async function finishFormItem(confirm: boolean) {
  document.querySelector<HTMLElement>(
    `.cxf-form-page-layer:not([hidden]) .cxf-form-action-buttons button:${confirm ? 'last' : 'first'}-child`,
  )!.click()
  await settle()
}
export async function startStandalone() {
  const container = document.createElement('div')
  container.style.cssText = 'display:flex;height:400px;width:min(500px,100vw);flex-direction:column'
  document.body.append(container)
  const standalone = createRoot(container)
  function Surface() {
    const [value, setValue] = React.useState<Record<string, unknown>>(formPageValue)
    return (
      <HostSchemaFormPage
        form={{ identity: 'standalone', schema: formPageSchema, value, onChange: next => setValue(next.value) }}
        footer={<button>Root action</button>}
      />
    )
  }
  standalone.render(<Surface />)
  await settle()
  return () => {
    standalone.unmount()
    container.remove()
  }
}
export async function startEmbedded() {
  const container = document.createElement('div')
  document.body.append(container)
  const embedded = createRoot(container)
  embedded.render(<SchemaForm identity="embedded" schema={formPageSchema} value={formPageValue} onChange={() => {}} />)
  await settle()
  return () => {
    embedded.unmount()
    container.remove()
  }
}
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

export async function addModel(id: string, label: string) {
  document.querySelector<HTMLElement>('[data-config-path="models"] [aria-label="添加条目"]')!.click()
  await settle()
  for (const [key, value] of [['id', id], ['label', label]]) {
    const input = document.querySelector<HTMLInputElement>(`.cxf-form-subpage [data-config-path$=".${key}"] input`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  document.querySelector<HTMLElement>('.cxf-form-subpage .cxf-form-action-buttons button:last-child')!.click()
  await settle()
}
export async function deleteLastModel() {
  const buttons = document.querySelectorAll<HTMLElement>('[data-config-path="models"] .cxf-array-delete')
  buttons[buttons.length - 1]!.click()
  await settle()
}
