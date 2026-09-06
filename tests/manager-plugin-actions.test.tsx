import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerPluginSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

function plugin(): ManagerPluginSnapshot {
  return {
    id: 'demo',
    name: 'Demo',
    source: 'file:///demo.js',
    status: 'active',
    inject: [],
    config: {},
    configuration: {
      namespace: 'demo',
      schemaKind: 'none',
      applies: 'live',
      writable: false,
      revision: 1,
      lastGoodRevision: 1,
      value: {},
      fields: [],
      secrets: [],
    },
  }
}

describe('React Manager plugin actions', () => {
  it('keeps navigation separate from lifecycle actions and submits the exact confirmed dependency impact', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const request = vi.fn().mockResolvedValueOnce({
      outcome: 'planned',
      impactToken: 'exact-impact',
      affectedPluginIds: ['demo', 'consumer'],
    })
      .mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo', 'consumer'] })
    const confirm = vi.fn(() => true)
    Object.defineProperty(fixture.dom.window, 'confirm', { configurable: true, value: confirm })
    const state = managerSnapshot({
      plugins: [plugin()],
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    const router = managerRouter()
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, { requestPluginLifecycle: request })}
          snapshot={state}
          router={router}
        />,
      )
      await fixture.click('[aria-label="Disable plugin"]')
      expect(request.mock.calls).toEqual([[{ kind: 'disable', pluginId: 'demo', impactToken: '' }], [{
        kind: 'disable',
        pluginId: 'demo',
        impactToken: 'exact-impact',
      }]])
      expect(confirm).toHaveBeenCalledWith('This action affects: demo, consumer. Continue?')
      expect(router.navigate).not.toHaveBeenCalled()
      await fixture.click('[data-plugin-id="demo"]')
      expect(router.navigate).toHaveBeenCalledWith({ kind: 'plugin', pluginId: 'demo', page: 'readme' })
    } finally {
      await fixture.dispose()
    }
  })

  it('retains targeted development reload when package lifecycle is unavailable and disables busy actions', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    let complete!: (value: unknown) => void
    const request = vi.fn(() =>
      new Promise(resolve => {
        complete = resolve
      })
    )
    const state = managerSnapshot({ plugins: [{ ...plugin(), developmentReloadAvailable: true }] })
    const model = managerModel(state, { requestPluginLifecycle: request as never })
    try {
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.click('[aria-label="Disable plugin"]')
      expect(request).not.toHaveBeenCalled()
      expect(fixture.element('[aria-label="Reload plugin"]')).toHaveProperty('disabled', false)
      await fixture.click('[aria-label="Reload plugin"]')
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'reload', pluginId: 'demo' })
      expect(fixture.element('[aria-label="Reload plugin"]').classList.contains('t-is-loading')).toBe(true)
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      await act(async () => complete({ outcome: 'applied', affectedPluginIds: ['demo'] }))
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      expect(fixture.element('[aria-label="Reload plugin"]').classList.contains('t-is-loading')).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })
})
