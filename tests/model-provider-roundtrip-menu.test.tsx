import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import {
  ModelProviderSelector,
  type ProviderSelectionSnapshot,
} from '../packages/cli/src/renderer/model-provider-selector.js'

it('restores provider-scoped members, order and checkmark across roundtrip and menu reopening', async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://fixture.test' })
  for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    vi.stubGlobal(name, name === 'window' ? dom.window : Reflect.get(dom.window, name))
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  const registry = new ModelProviderRegistry(async () => [
    {
      providerId: 'provider-a',
      pluginId: 'a',
      models: [
        { id: 'shared', label: 'GPT shared from A' },
        { id: 'a-only', label: 'DeepSeek from A' },
      ],
    },
    {
      providerId: 'deepseek',
      pluginId: 'b',
      models: [
        { id: 'b-only', label: 'DeepSeek only from B' },
        { id: 'shared', label: 'DeepSeek shared from B' },
      ],
    },
  ])
  await registry.refresh()
  let state: ProviderSelectionSnapshot = {
    available: true,
    busy: false,
    threadId: 'thread',
    modelProvider: 'provider-a',
    model: 'shared',
    nativeModels: [{ id: 'shared', label: 'Native shared', disabled: false }],
  }
  const listeners = new Set<() => void>()
  const select = vi.fn(async (target: { providerId: string; model: string }) => {
    state = { ...state, modelProvider: target.providerId, model: target.model }
    for (const notify of listeners) notify()
    return 'accepted' as const
  })
  const root = createRoot(document.getElementById('root')!)
  const click = async (selector: string) =>
    act(async () => {
      const button = document.querySelector<HTMLButtonElement>(selector)
      expect(button).not.toBeNull()
      expect(button!.disabled).toBe(false)
      button!.click()
    })
  const assertMenu = (labels: string[], checked: string) => {
    const rows = [...document.querySelectorAll('.cxmp-model-choice')]
    expect(rows.map(row => row.textContent)).toEqual(labels)
    expect(rows.filter(row => row.getAttribute('aria-checked') === 'true').map(row => row.textContent)).toEqual([
      checked,
    ])
    expect(document.querySelector('.cxmp-search')).toBeNull()
  }
  try {
    await act(async () =>
      root.render(
        <ModelProviderSelector
          registry={registry}
          locale="en"
          transport={{
            getSnapshot: () => state,
            subscribe: listener => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            select,
            selectReasoningEffort: async () => 'accepted',
            selectFastMode: async () => 'accepted',
          }}
        />,
      )
    )
    await click('.cxmp-model-trigger')
    assertMenu(['GPT shared from A', 'DeepSeek from A'], 'GPT shared from A')
    await click('.cxmp-provider-trigger')
    await click('[data-provider-id="deepseek"]')
    await click('.cxmp-model-trigger')
    assertMenu(['DeepSeek only from B', 'DeepSeek shared from B'], 'DeepSeek shared from B')
    await click('.cxmp-provider-trigger')
    await click('[data-provider-id="provider-a"]')
    for (let i = 0; i < 2; i++) {
      await click('.cxmp-model-trigger')
      assertMenu(['GPT shared from A', 'DeepSeek from A'], 'GPT shared from A')
      await click('.cxmp-model-trigger')
    }
    await click('.cxmp-provider-trigger')
    await click('[role="menuitemradio"]')
    expect(select).toHaveBeenLastCalledWith({ providerId: 'openai', model: 'shared' })
    await click('.cxmp-model-trigger')
    assertMenu(['Native shared'], 'Native shared')
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    dom.window.close()
    vi.unstubAllGlobals()
  }
})
