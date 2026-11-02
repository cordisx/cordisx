import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'tdesign-react'
import { ModelServicesPage } from '../../packages/cli/src/renderer/manager/pages/ModelServicesPage.js'
import { ModelProviderSelector } from '../../packages/cli/src/renderer/model-provider-selector.js'
import type { ProviderSelectionSnapshot } from '../../packages/cli/src/renderer/model-provider-selector.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { REACT_MANAGER_STYLES } from '../../packages/cli/src/renderer/manager/styles.js'
import type { StartupEventV1, StartupObserverV1, StartupProjectionV1 } from '@cordisx/protocol/startup/v1'

const states = ['declared', 'auth-required', 'catalog-pending', 'ready', 'failed', 'stopped', 'unknown'] as const
const entries: StartupProjectionV1[] = states.map((state, index) => ({
  identity: {
    pluginId: `preview-${index}`,
    capabilityId: 'models',
    serviceId: `service-${index}`,
    providerId: `service-${index}`,
  },
  generation: { host: 'preview-host', plugin: 'preview-plugin', service: 'preview-service' },
  state,
  service: 'unknown',
  process: state === 'ready' ? 'running' : 'not-started',
  health: 'unknown',
  authentication: state === 'auth-required' ? 'missing' : 'unknown',
  catalog: state === 'ready'
    ? { state: 'known', generation: 'catalog', modelIds: ['preview-model'] }
    : state === 'catalog-pending'
    ? { state: 'pending' }
    : { state: 'unknown' },
  provider: state === 'ready' ? 'published' : 'unpublished',
  milestones: [],
  actions: {
    execute: state === 'ready' ? { available: true } : { available: false, reason: 'not-prepared' },
    authenticate: { available: false, reason: 'unsupported' },
    retry: { available: false, reason: 'unsupported' },
  },
}))
const snapshot = {
  contract: 'cordisx.startup-snapshot/v1' as const,
  cursor: { scopeId: 'preview', hostGeneration: 'preview-host', epoch: 'preview', sequence: 1 },
  entries,
  pages: [],
}
let emit: (event: StartupEventV1) => void = () => {}
const observer: StartupObserverV1 = {
  contract: 'cordisx.startup-observer/v1',
  read: async () => snapshot,
  subscribe: async listener => {
    emit = listener
    listener({ kind: 'snapshot', reason: 'initial', snapshot })
    return { close() {} }
  },
}
const registry = new ModelProviderRegistry(async () =>
  entries.map((entry, index) => ({
    providerId: entry.identity.providerId!,
    pluginId: entry.identity.pluginId,
    title: `Example service · ${states[index]}`,
    models: entry.state === 'ready' ? [{ id: 'preview-model', label: 'Example model' }] : [],
  }))
)
registry.connectStartup(observer)
let native: ProviderSelectionSnapshot = {
  available: true,
  busy: false,
  modelProvider: 'service-3',
  model: 'preview-model',
}
const listeners = new Set<() => void>()
const publishSelection = () => {
  for (const listener of listeners) listener()
}
const transport = {
  getSnapshot: () => native,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  selectProviderIntent: async (providerId: string) => {
    native = { ...native, pendingProviderIntent: { providerId, generation: 1 } }
    publishSelection()
    return 'accepted' as const
  },
  cancelProviderIntent: async () => {
    native = { ...native, pendingProviderIntent: undefined }
    publishSelection()
    return 'accepted' as const
  },
  select: async () => 'unavailable' as const,
  selectReasoningEffort: async () => 'unavailable' as const,
  selectFastMode: async () => 'unavailable' as const,
}
let locale = 'en'
let root: ReturnType<typeof createRoot>
export async function start() {
  const seat = document.getElementById('manager')!
  seat.className = 'cxr-root'
  new HostThemeProjection(document).attach(seat)
  root = createRoot(seat)
  render()
  await registry.refresh()
}
function render() {
  root.render(
    <ConfigProvider globalConfig={{ attach: () => document.getElementById('manager')! }}>
      <style>{REACT_MANAGER_STYLES}</style>
      <div className="catalog-fixture-shell">
        <header>
          <button
            onClick={() => {
              locale = locale === 'en' ? 'zh-CN' : 'en'
              render()
            }}
          >
            EN / 中文
          </button>
          <button
            onClick={() => {
              document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark'
                ? 'light'
                : 'dark'
            }}
          >
            Theme
          </button>
          <button
            onClick={() => emit({ kind: 'connection', connection: { state: 'reconnecting', reason: 'timeout' } })}
          >
            Reconnect fixture
          </button>
          <h1>{locale === 'en' ? 'Model services' : '模型服务'}</h1>
          <small>Experimental source preview · deterministic startup fixture · no native execution</small>
        </header>
        <main className="cxr-content">
          <ModelServicesPage registry={registry} locale={locale} />
        </main>
        <footer>
          <ModelProviderSelector registry={registry} transport={transport} locale={locale} />
        </footer>
      </div>
    </ConfigProvider>,
  )
}
