import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'
import { installNotificationHost } from '../packages/cli/src/renderer/notifications/host.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
import { managerModel, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document, className?: string) => {
    const node = document.createElement('span')
    node.className = className ?? ''
    node.dataset.brandMark = 'true'
    return node
  },
}))

const menuItem = (document: Document, label: string) =>
  [...document.querySelectorAll<HTMLElement>('.t-dropdown__item')].find(item => item.textContent === label)!

async function pageAction(
  fixture: ReturnType<typeof reactManagerFixture>,
  pageId: 'export' | 'import' | 'environment',
  label: string,
): Promise<void> {
  await vi.waitFor(() =>
    expect(fixture.document.querySelector(`[data-model-transfer-page="${pageId}"]`)).not.toBeNull()
  )
  const button = [...fixture.document.querySelectorAll<HTMLButtonElement>(
    `[data-model-transfer-page="${pageId}"] .cxf-form-page-footer button`,
  )].find(item => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
  })
}

async function editFirstVariable(
  fixture: ReturnType<typeof reactManagerFixture>,
  pageId: 'export' | 'import' | 'environment',
): Promise<void> {
  await vi.waitFor(() =>
    expect(fixture.document.querySelector(`[data-model-transfer-page="${pageId}"] [aria-label="Edit item"]`))
      .not.toBeNull()
  )
  await fixture.click(`[data-model-transfer-page="${pageId}"] [aria-label="Edit item"]`)
}

async function finishVariableEdit(fixture: ReturnType<typeof reactManagerFixture>, label: string): Promise<void> {
  const page = [...fixture.document.querySelectorAll<HTMLElement>('[data-host-form-page^="array-item:"]')]
    .find(item => !item.hidden)
  expect(page).toBeDefined()
  const button = [...page!.querySelectorAll<HTMLButtonElement>('.cxf-form-subpage-actions button')]
    .find(item => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
  })
}

const registryFor = (host: ReturnType<typeof catalogFixture>, refresh = vi.fn(async () => {})) => {
  const snapshot = { loading: false, providers: [], entries: [] }
  return ({
    management: host.client,
    subscribe: () => () => {},
    refresh,
    snapshot: () => snapshot,
  }) as unknown as ModelProviderRegistry
}

const brandedProvider = {
  providerId: 'provider-a',
  pluginId: 'native',
  title: 'Provider A',
  icon: 'host:settings',
  models: [
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
    { id: 'deepseek-chat', label: 'DeepSeek Chat' },
  ],
}

describe('Manager model transfer', () => {
  it('uses the existing Manager header for environment variables and returns to the list', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    const environmentRead = vi.spyOn(host.client, 'environmentRead').mockResolvedValue({
      status: 'ok',
      entries: [{ name: 'MODEL_KEY', value: 'old-value', enabled: true }],
      applies: 'app-restart',
    })
    const seat = fixture.document.body.appendChild(fixture.document.createElement('span'))
    const model = managerModel(managerSnapshot(), { modelProviders: registryFor(host) })
    try {
      await host.client.refresh()
      const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
      await fixture.render(<ManagerApp model={model} marketplace={{} as MarketplaceModel} triggerSeat={seat} />)
      await fixture.click('[data-cordisx-manager-trigger]')
      await fixture.click('[data-tab="model-services"]')
      const list = fixture.element('.cxmp-results')
      list.scrollTop = 173
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Environment variables').click())
      await vi.waitFor(() => expect(environmentRead).toHaveBeenCalledOnce())
      expect(fixture.document.querySelectorAll('.cxr-main > .cxr-header')).toHaveLength(1)
      expect(fixture.document.querySelector('.cxr-heading')?.textContent).toContain('Model services')
      expect(fixture.document.querySelector('.cxr-heading')?.textContent).toContain('Environment variables')
      expect(fixture.document.querySelector('.cxr-header [aria-label="Back"]')).not.toBeNull()
      expect(fixture.document.querySelector('.cxms-transfer-page .cxf-form-subpage-header')).toBeNull()
      expect(fixture.document.querySelector('.cxmp-results')).toBe(list)
      expect(list.closest('.cxmp-management')?.hidden).toBe(true)
      await fixture.click('.cxr-header [aria-label="Back"]')
      expect(fixture.document.querySelector('.cxmp-results')).toBe(list)
      expect(list.scrollTop).toBe(173)
      expect(list.closest('.cxmp-management')?.hidden).toBe(false)
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"]')).not.toBeNull()
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('shares a service only after confirming every transferable present model', async () => {
    const host = catalogFixture([catalogView({
      transferAvailable: true,
      rows: [
        ...catalogView().rows,
        {
          id: 'removed',
          label: 'Removed',
          provenance: ['manual'],
          notListed: false,
          present: false,
          compatibility: 'supported',
          selectable: false,
          blocked: false,
          pinned: false,
        },
        {
          id: 'scripted',
          label: 'Scripted',
          provenance: ['script'],
          notListed: false,
          present: true,
          compatibility: 'supported',
          selectable: true,
          blocked: false,
          pinned: false,
        },
      ],
    })])
    const fixture = reactManagerFixture()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: 'Mozilla/5.0', clipboard: { writeText } })
    const prepareExport = vi.spyOn(host.client, 'prepareExport').mockResolvedValue({ status: 'ok', variables: [] })
    const exportModels = vi.spyOn(host.client, 'export').mockResolvedValue({ status: 'ok', text: 'fixture-payload' })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('[aria-label="More catalog actions: Provider A"]')
      await act(async () => menuItem(fixture.document, 'Share').click())
      await vi.waitFor(() =>
        expect(prepareExport).toHaveBeenCalledWith({
          selections: [{ bindingRef: 'binding-a', modelIds: ['Model-A', 'model-a'] }],
        })
      )
      expect(exportModels).not.toHaveBeenCalled()
      expect(writeText).not.toHaveBeenCalled()
      await vi.waitFor(() =>
        expect(fixture.document.querySelector('[data-model-transfer-page="export"]')).not.toBeNull()
      )
      expect(fixture.document.querySelector('dialog, [role="dialog"]')).toBeNull()
      expect(fixture.document.querySelector('.cxms-transfer-page > .cxf-form-subpage')).toBeNull()
      expect(fixture.document.querySelector('.cxms-transfer-page > .cxf-form-subpage-header')).toBeNull()
      expect(fixture.document.querySelector('[data-schema-form="model-transfer-export"]')).not.toBeNull()
      expect(fixture.document.querySelector('[data-model-transfer-page="export"] .cxf-form-page-footer')).not.toBeNull()
      await pageAction(fixture, 'export', 'Copy configuration')
      expect(exportModels).toHaveBeenCalledWith({
        selections: [{ bindingRef: 'binding-a', modelIds: ['Model-A', 'model-a'] }],
        includeValues: false,
        variables: [],
      })
      expect(writeText).toHaveBeenCalledWith('fixture-payload')
      expect(fixture.document.querySelector('.cxms-export-toolbar')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('exports selected services with full catalogs regardless of search and excludes plugin sources', async () => {
    const fullRows = Array.from({ length: 60 }, (_, index) => ({
      id: `model-${index}`,
      label: `Model ${index}`,
      provenance: ['auto'] as const,
      notListed: false,
      present: true,
      compatibility: 'supported' as const,
      selectable: index !== 59,
      blocked: index === 59,
      pinned: false,
    }))
    const host = catalogFixture([
      catalogView({ rows: fullRows, sourceCount: fullRows.length, selectableCount: 59, transferAvailable: true }),
      catalogView({ bindingRef: 'binding-b', providerId: 'provider-b', title: 'Provider B', transferAvailable: true }),
      catalogView({
        bindingRef: 'plugin:sample',
        providerId: 'plugin-provider',
        title: 'Plugin Provider',
        sourceKind: 'plugin',
        transferAvailable: true,
      }),
    ])
    const fixture = reactManagerFixture()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: 'Mozilla/5.0', clipboard: { writeText } })
    vi.spyOn(host.client, 'prepareExport').mockResolvedValue({ status: 'ok', variables: [] })
    const exportModels = vi.spyOn(host.client, 'export').mockResolvedValue({ status: 'ok', text: 'fixture-payload' })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.type('[aria-label="Search services or models"]', 'Model 0')
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Export model configuration').click())
      expect(fixture.document.querySelector('[data-binding-ref="plugin:sample"]')).toBeNull()
      expect(fixture.document.querySelectorAll('[data-binding-ref]')).toHaveLength(1)
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"]')).not.toBeNull()
      expect(fixture.document.querySelector('[data-binding-ref="binding-b"]')).toBeNull()
      expect(fixture.document.querySelector('[aria-label="Select model: Model 0"]')).toBeNull()
      const providerCheckbox = fixture.element('[aria-label="Select model service: Provider A"]')
      expect(providerCheckbox.querySelector('.t-checkbox__input')).not.toBeNull()
      expect(providerCheckbox.closest('.cxmc-export-binding')?.firstElementChild).toBe(providerCheckbox)
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"] .cxms-disclosure-mark')).toBeNull()
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"] .cxmc-binding-toggle[aria-expanded]'))
        .toBeNull()
      expect(fixture.element('[data-binding-ref="binding-a"] .cxmc-models').hidden).toBe(true)
      expect(fixture.element('[data-binding-ref="binding-a"] .cxms-model-count').textContent).toBe('Models: 60')
      await fixture.click('[aria-label="Select model service: Provider A"]')
      expect(fixture.element('.cxms-export-toolbar').textContent).toContain('1 model services selected')
      await fixture.click('[aria-label="Copy selected model service configuration"]')
      expect(exportModels).not.toHaveBeenCalled()
      expect(fixture.element('.cxms-export-toolbar').closest('.cxmp-management')?.hidden).toBe(true)
      await pageAction(fixture, 'export', 'Copy configuration')
      expect(exportModels).toHaveBeenCalledWith({
        selections: [{ bindingRef: 'binding-a', modelIds: fullRows.map(row => row.id) }],
        includeValues: false,
        variables: [],
      })
      expect(writeText).toHaveBeenCalledWith('fixture-payload')
      expect(fixture.document.querySelector('.cxms-export-toolbar')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('keeps the service selection after copy failure and reports through Host notifications', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      userAgent: 'Mozilla/5.0',
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })
    vi.spyOn(host.client, 'prepareExport').mockResolvedValue({ status: 'ok', variables: [] })
    const exportModels = vi.spyOn(host.client, 'export').mockResolvedValue({ status: 'ok', text: 'fixture-payload' })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('[data-binding-ref="binding-a"] .cxmc-binding-toggle')
      expect(fixture.element('[data-binding-ref="binding-a"] .cxmc-binding-toggle').getAttribute('aria-expanded'))
        .toBe('true')
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Export model configuration').click())
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"] .cxmc-binding-toggle[aria-expanded]'))
        .toBeNull()
      expect(fixture.element('[data-binding-ref="binding-a"] .cxmc-models').hidden).toBe(true)
      await fixture.click('[aria-label="Select model service: Provider A"]')
      await fixture.click('[aria-label="Copy selected model service configuration"]')
      await pageAction(fixture, 'export', 'Copy configuration')
      expect(fixture.document.querySelector('.cxms-transfer-status')).toBeNull()
      expect(fixture.document.querySelector('[data-model-transfer-page="export"]')).not.toBeNull()
      await pageAction(fixture, 'export', 'Cancel')
      expect(fixture.document.querySelector('.cxms-export-toolbar')).not.toBeNull()
      expect(fixture.element('[aria-label="Select model service: Provider A"]').classList.contains('t-is-checked'))
        .toBe(true)
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Could not copy model configuration')
      expect(exportModels).toHaveBeenCalledOnce()
      await fixture.click('[aria-label="Exit export selection"]')
      expect(fixture.element('[data-binding-ref="binding-a"] .cxmc-binding-toggle').getAttribute('aria-expanded'))
        .toBe('true')
    } finally {
      vi.unstubAllGlobals()
      await act(async () => disposeNotifications())
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('selects only the filtered export scope and preserves hidden selections', async () => {
    const host = catalogFixture([
      catalogView({ transferAvailable: true }),
      catalogView({ bindingRef: 'binding-b', providerId: 'provider-b', title: 'Provider B', transferAvailable: true }),
    ])
    const fixture = reactManagerFixture()
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Export model configuration').click())

      const selectAll = () => fixture.element('[aria-label="Select all visible model services"]')
      expect(selectAll().classList.contains('t-is-checked')).toBe(false)
      expect(selectAll().classList.contains('t-is-indeterminate')).toBe(false)
      await fixture.click('[aria-label="Select model service: Provider A"]')
      expect(selectAll().classList.contains('t-is-indeterminate')).toBe(true)

      await fixture.type('[aria-label="Search services or models"]', 'Provider B')
      expect(fixture.document.querySelector('[data-binding-ref="binding-a"]')).toBeNull()
      expect(selectAll().classList.contains('t-is-checked')).toBe(false)
      expect(selectAll().classList.contains('t-is-indeterminate')).toBe(false)
      await fixture.click('[aria-label="Select all visible model services"]')
      expect(selectAll().classList.contains('t-is-checked')).toBe(true)
      expect(fixture.element('.cxms-export-toolbar').textContent).toContain('2 model services selected')

      await fixture.type('[aria-label="Search services or models"]', 'Provider A')
      await fixture.click('[aria-label="Select all visible model services"]')
      expect(fixture.element('.cxms-export-toolbar').textContent).toContain('1 model services selected')
      await fixture.type('[aria-label="Search services or models"]', '')
      expect(selectAll().classList.contains('t-is-indeterminate')).toBe(true)

      await fixture.type('[aria-label="Search services or models"]', 'No matching service')
      expect(selectAll().classList.contains('t-is-disabled')).toBe(true)
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('prepares imports without writes, cancels safely, and confirms edited variables', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const readText = vi.fn(async () => 'fixture-payload')
    vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: 'Mozilla/5.0', clipboard: { readText } })
    const prepareImport = vi.spyOn(host.client, 'prepareImport').mockResolvedValue({
      status: 'ok',
      variables: [{
        sourceName: 'SOURCE_KEY',
        name: 'SOURCE_KEY_1',
        value: 'fixture-value',
        enabled: true,
        bindings: ['Provider A'],
        available: true,
      }],
      connections: [{ transferId: '00000000-0000-4000-8000-000000000001', title: 'Provider A' }],
    })
    const importModels = vi.spyOn(host.client, 'import').mockResolvedValue({
      status: 'applied',
      imported: 1,
      skipped: 0,
      bindingRefs: ['local-ref'],
    })
    const refresh = vi.fn(async () => {})
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host, refresh)} locale="en" />)
      expect(readText).not.toHaveBeenCalled()
      await fixture.type('[aria-label="Search services or models"]', 'Provider A')
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Import from clipboard').click())
      await vi.waitFor(() => expect(prepareImport).toHaveBeenCalledWith('fixture-payload'))
      expect(readText).toHaveBeenCalledOnce()
      expect(importModels).not.toHaveBeenCalled()
      expect(fixture.element('.cxmp-management').hidden).toBe(true)
      expect(fixture.document.querySelector('.cxms-transfer-page > .cxf-form-subpage')).toBeNull()
      await pageAction(fixture, 'import', 'Cancel')
      expect(importModels).not.toHaveBeenCalled()
      const management = fixture.element('.cxmp-management')
      expect(management.parentElement?.classList.contains('cxms-transfer-page-host')).toBe(true)
      expect((management.querySelector('[aria-label="Search services or models"]') as HTMLInputElement).value)
        .toBe('Provider A')
      expect(management.querySelector('.cxmp-results')).not.toBeNull()
      expect(management.querySelector('[data-binding-ref="binding-a"]')).not.toBeNull()

      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Import from clipboard').click())
      await vi.waitFor(() => expect(prepareImport).toHaveBeenCalledTimes(2))
      await editFirstVariable(fixture, 'import')
      await fixture.type(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="text"]',
        'DESTINATION_KEY',
      )
      await fixture.type(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
        'edited-value',
      )
      await finishVariableEdit(fixture, 'Save')
      await pageAction(fixture, 'import', 'Import')
      expect(importModels).toHaveBeenCalledWith({
        text: 'fixture-payload',
        variables: [{
          sourceName: 'SOURCE_KEY',
          name: 'DESTINATION_KEY',
          value: 'edited-value',
          enabled: true,
          bindings: ['Provider A'],
          available: true,
        }],
      })
      expect(refresh).toHaveBeenCalled()
      expect(fixture.document.querySelector('.cxms-transfer-status')).toBeNull()
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Model configuration imported')
    } finally {
      vi.unstubAllGlobals()
      await act(async () => disposeNotifications())
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('runs imported shell generators explicitly, fences stale results, and persists the current preview', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    const readText = vi.fn(async () => 'fixture-payload')
    vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: 'Mozilla/5.0', clipboard: { readText } })
    vi.spyOn(host.client, 'prepareImport').mockResolvedValue({
      status: 'ok',
      variables: [{
        sourceName: 'SOURCE_KEY',
        name: 'SOURCE_KEY',
        value: '',
        enabled: true,
        generator: { kind: 'shell', script: 'printf generated' },
        bindings: ['Provider A'],
        available: false,
      }],
      connections: [{ transferId: '00000000-0000-4000-8000-000000000001', title: 'Provider A' }],
    })
    let finish!: (value: Awaited<ReturnType<typeof host.client.environmentGenerate>>) => void
    const generate = vi.spyOn(host.client, 'environmentGenerate').mockImplementation(() =>
      new Promise(resolve => {
        finish = resolve
      })
    )
    const cancel = vi.spyOn(host.client, 'environmentGenerateCancel').mockResolvedValue({
      status: 'cancelled',
      runId: 'ignored',
    })
    const importModels = vi.spyOn(host.client, 'import').mockResolvedValue({
      status: 'applied',
      imported: 1,
      skipped: 0,
      bindingRefs: ['local-ref'],
    })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Import from clipboard').click())
      await editFirstVariable(fixture, 'import')
      expect(generate).not.toHaveBeenCalled()
      expect(fixture.document.body.textContent).toContain('not sandboxed and may have side effects')
      const textareas = fixture.document.querySelectorAll<HTMLTextAreaElement>(
        '[data-host-form-page^="array-item:"]:not([hidden]) textarea',
      )
      expect(textareas).toHaveLength(1)
      const runButton = [...fixture.document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === 'Run script')!
      await act(async () => runButton.click())
      expect(generate).toHaveBeenCalledOnce()
      const runId = generate.mock.calls[0]![0].runId
      await fixture.type(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
        'manual-value',
      )
      expect(cancel).toHaveBeenCalledWith(runId)
      await act(async () => finish({ status: 'ok', runId, value: 'stale-value' }))
      expect(
        (fixture.element(
          '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
        ) as HTMLInputElement).value,
      ).toBe('manual-value')

      const rerun = [...fixture.document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === 'Run script')!
      await act(async () => rerun.click())
      const currentRunId = generate.mock.calls[1]![0].runId
      await act(async () => finish({ status: 'ok', runId: currentRunId, value: 'generated-value' }))
      await vi.waitFor(() =>
        expect(
          (fixture.element(
            '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
          ) as HTMLInputElement).value,
        ).toBe('generated-value')
      )
      await finishVariableEdit(fixture, 'Save')
      await pageAction(fixture, 'import', 'Import')
      expect(importModels).toHaveBeenCalledWith({
        text: 'fixture-payload',
        variables: [{
          sourceName: 'SOURCE_KEY',
          name: 'SOURCE_KEY',
          value: 'generated-value',
          enabled: true,
          bindings: ['Provider A'],
          available: false,
          generator: { kind: 'shell', script: 'printf generated' },
        }],
      })
    } finally {
      vi.unstubAllGlobals()
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('shares a single model only after confirmation and includes values only when selected', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: 'Mozilla/5.0', clipboard: { writeText } })
    const prepareExport = vi.spyOn(host.client, 'prepareExport').mockResolvedValue({
      status: 'ok',
      variables: [{
        sourceName: 'SOURCE_KEY',
        name: 'SOURCE_KEY',
        value: 'fixture-value',
        enabled: true,
        bindings: ['binding-a'],
        available: true,
      }],
    })
    const exportModels = vi.spyOn(host.client, 'export').mockResolvedValue({ status: 'ok', text: 'fixture-payload' })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('[aria-label="More: Model-A"]')
      await act(async () => menuItem(fixture.document, 'Share model configuration').click())
      await vi.waitFor(() =>
        expect(prepareExport).toHaveBeenCalledWith({
          selections: [{ bindingRef: 'binding-a', modelIds: ['Model-A'] }],
        })
      )
      expect(exportModels).not.toHaveBeenCalled()
      expect(writeText).not.toHaveBeenCalled()
      await fixture.click('[data-schema-form="model-transfer-export"] input[type="checkbox"]')
      await pageAction(fixture, 'export', 'Copy configuration')
      expect(exportModels).toHaveBeenCalledWith({
        selections: [{ bindingRef: 'binding-a', modelIds: ['Model-A'] }],
        includeValues: true,
        variables: [{
          sourceName: 'SOURCE_KEY',
          name: 'SOURCE_KEY',
          value: 'fixture-value',
        }],
      })
      expect(writeText).toHaveBeenCalledWith('fixture-payload')
    } finally {
      vi.unstubAllGlobals()
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('edits CordisX environment variables and reports that an App restart is required', async () => {
    const host = catalogFixture([catalogView({ transferAvailable: true })])
    const fixture = reactManagerFixture()
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const environmentRead = vi.spyOn(host.client, 'environmentRead').mockResolvedValue({
      status: 'ok',
      entries: [{ name: 'MODEL_KEY', value: 'old-value', enabled: true, description: 'Service key' }],
      applies: 'app-restart',
    })
    const environmentSave = vi.spyOn(host.client, 'environmentSave').mockResolvedValue({
      status: 'applied',
      applies: 'app-restart',
    })
    try {
      await host.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={registryFor(host)} locale="en" />)
      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Environment variables').click())
      await vi.waitFor(() => expect(environmentRead).toHaveBeenCalledOnce())
      expect(environmentSave).not.toHaveBeenCalled()
      expect(fixture.document.querySelector('.cxh-tdesign-root')).not.toBeNull()
      expect(fixture.document.querySelector('dialog, [role="dialog"]')).toBeNull()
      expect(fixture.document.querySelector('[data-schema-form-presentation="page-body"]')).toBeNull()
      expect(fixture.document.querySelector('[data-model-transfer-page="environment"] .cxf-label-row')).not.toBeNull()
      expect(fixture.element('[data-model-transfer-page="environment"]').textContent)
        .not.toContain('Restart the CordisX App after saving')
      expect(fixture.document.querySelector('[data-model-transfer-page="environment"] .cxf-form-page-footer'))
        .not.toBeNull()
      await editFirstVariable(fixture, 'environment')
      await fixture.type(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
        'cancelled-value',
      )
      await finishVariableEdit(fixture, 'Cancel')
      await pageAction(fixture, 'environment', 'Cancel')
      expect(environmentSave).not.toHaveBeenCalled()

      await fixture.click('.cxh-search-toolbar [aria-label="More catalog actions"]')
      await act(async () => menuItem(fixture.document, 'Environment variables').click())
      await vi.waitFor(() => expect(environmentRead).toHaveBeenCalledTimes(2))
      await editFirstVariable(fixture, 'environment')
      const nameInput = fixture.element(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="text"]',
      ) as HTMLInputElement
      await act(async () => {
        nameInput.focus()
        const setValue = Object.getOwnPropertyDescriptor(fixture.dom.window.HTMLInputElement.prototype, 'value')!.set!
        for (const value of ['R', 'RE', 'REN', 'RENAMED_KEY']) {
          setValue.call(nameInput, value)
          nameInput.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }))
          nameInput.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }))
          nameInput.dispatchEvent(new fixture.dom.window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
          await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
          expect(nameInput.isConnected).toBe(true)
          expect(fixture.document.activeElement).toBe(nameInput)
          expect(nameInput.value).toBe(value)
        }
      })
      await fixture.type(
        '[data-host-form-page^="array-item:"]:not([hidden]) input[type="password"]',
        'saved-value',
      )
      await finishVariableEdit(fixture, 'Save')
      await pageAction(fixture, 'environment', 'Save')
      expect(environmentSave).toHaveBeenCalledWith([
        { name: 'RENAMED_KEY', value: 'saved-value', enabled: true, description: 'Service key' },
      ])
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Environment variables saved')
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Restart the CordisX App')
    } finally {
      await act(async () => disposeNotifications())
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('uses the existing model-brand inference in managed and legacy rows', async () => {
    const managedHost = catalogFixture([catalogView({
      rows: brandedProvider.models.map(model => ({
        ...model,
        provenance: ['native'],
        notListed: false,
        present: true,
        compatibility: 'supported',
        selectable: true,
        blocked: false,
        pinned: false,
      })),
    })])
    const fixture = reactManagerFixture()
    const managedSnapshot = { loading: false, providers: [brandedProvider], entries: [] }
    const managedRegistry = {
      management: managedHost.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => managedSnapshot,
    } as unknown as ModelProviderRegistry
    const legacySnapshot = { loading: false, providers: [brandedProvider], entries: [] }
    const legacyRegistry = {
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => legacySnapshot,
    } as unknown as ModelProviderRegistry
    try {
      await managedHost.client.refresh()
      const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
      await fixture.render(<ModelServicesPage registry={managedRegistry} locale="en" />)
      expect(
        fixture.document.querySelector('[data-model-id="claude-3-7-sonnet"] [data-selector-brand="claude"]'),
      )
        .not.toBeNull()

      await fixture.render(<ModelServicesPage registry={legacyRegistry} locale="en" />)
      await fixture.click('.cxms-provider-toggle')
      expect(fixture.document.querySelector('.cxms-provider li [data-selector-brand="claude"]')).not.toBeNull()
      expect(fixture.document.querySelector('.cxms-provider li [data-selector-brand="deepseek"]')).not.toBeNull()
    } finally {
      managedHost.client.dispose()
      await fixture.dispose()
    }
  })
})
