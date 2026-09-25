import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'tdesign-react'
import { ModelServicesPage } from '../../packages/cli/src/renderer/manager/pages/ModelServicesPage.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { REACT_MANAGER_STYLES } from '../../packages/cli/src/renderer/manager/styles.js'
import { catalogFixture, catalogView } from '../helpers/catalog-management-fixture.js'

const supportedCompatibility = { compatibility: 'supported' as const }

const longRows = Array.from({ length: 180 }, (_, index) => ({
  id: index === 179 ? 'openrouter/final-search-target' : `openrouter/model-${String(index + 1).padStart(3, '0')}`,
  label: index === 179 ? 'Final search target' : `OpenRouter model ${index + 1}`,
  provenance: ['auto' as const],
  notListed: false,
  present: true,
  selectable: true,
  blocked: false,
  pinned: index === 0,
  ...supportedCompatibility,
}))

const host = catalogFixture([
  catalogView({
    providerId: 'openrouter',
    title: 'OpenRouter',
    scopeLabel: 'OpenRouter connection',
    rows: longRows,
    sourceCount: longRows.length,
    selectableCount: longRows.length,
  }),
  catalogView({
    bindingRef: 'binding-b',
    providerId: 'provider-b',
    title: 'Personal endpoint',
    scopeLabel: 'Personal connection',
    sourceKind: 'manual',
    mode: 'replace',
    rows: [{
      id: `custom/${'long-exact-model-id-'.repeat(12)}`,
      label: 'Long model identifier',
      provenance: ['manual-supplement'],
      notListed: true,
      present: true,
      selectable: true,
      blocked: false,
      pinned: false,
      ...supportedCompatibility,
    }],
    sourceCount: 1,
    selectableCount: 1,
    capabilities: ['setOverlay', 'editManual', 'refresh'],
  }),
  catalogView({
    bindingRef: 'binding-c',
    providerId: 'provider-c',
    title: 'Local model script',
    scopeLabel: 'Local connection',
    sourceKind: 'script',
    mode: 'replace',
    rows: [],
    sourceCount: 0,
    selectableCount: 0,
    freshness: 'unknown',
    outcome: 'unsupported',
    capabilities: [],
  }),
])
const registry = new ModelProviderRegistry(async () => [])
registry.management = host.client
let locale = 'en'
let root: ReturnType<typeof createRoot>
let theme: HostThemeProjection
export async function start() {
  const seat = document.getElementById('manager')!
  seat.className = 'cxr-root'
  theme = new HostThemeProjection(document)
  theme.attach(seat)
  root = createRoot(seat)
  render()
  await host.client.refresh()
  await settle()
  return () => {
    root.unmount()
    registry.dispose()
    theme.dispose()
  }
}
function render() {
  root.render(
    <ConfigProvider globalConfig={{ attach: () => document.getElementById('manager')! }}>
      <style>{REACT_MANAGER_STYLES}</style>
      <div className="catalog-fixture-shell">
        <header>
          <h1>{locale === 'en' ? 'Model services' : '模型服务'}</h1>
        </header>
        <main className="cxr-content">
          <ModelServicesPage registry={registry} locale={locale} />
        </main>
      </div>
    </ConfigProvider>,
  )
}
export async function setLocale(value: string) {
  locale = value
  render()
  await settle()
}
export async function setTheme(value: string) {
  document.documentElement.dataset.theme = value
  await settle()
}
export async function refreshState(kind: 'error' | 'empty' | 'restore' | 'slow') {
  const state = host.snapshot()
  host.publish({
    ...state,
    sequence: state.sequence + 1,
    views: state.views.map((view, index) =>
      index > 0 ? view : {
        ...view,
        revision: String(Number(view.revision) + 1),
        ...(kind === 'empty'
          ? {
            rows: view.rows.map(row => ({ ...row, present: false, selectable: false })),
            sourceCount: 0,
            selectableCount: 0,
            outcome: 'empty' as const,
          }
          : {}),
        ...(kind === 'restore'
          ? {
            rows: catalogView().rows,
            sourceCount: 2,
            selectableCount: 2,
            activity: 'idle' as const,
            outcome: 'ok' as const,
          }
          : {}),
        ...(kind === 'error'
          ? {
            freshness: 'stale' as const,
            outcome: 'error' as const,
            diagnostics: { ...view.diagnostics, code: 'temporary' as const },
          }
          : {}),
        ...(kind === 'slow' ? { activity: 'loading' as const } : {}),
      }
    ),
  })
  await host.client.refresh()
  await settle()
}
export async function settle() {
  await new Promise(resolve => setTimeout(resolve, 60))
}
export function commands() {
  return host.commands
}

export async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search services or models"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
