import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelProviderSelector,
  type NativeModelAssignment,
  type ProviderSelectionSnapshot,
} from '../packages/cli/src/renderer/model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'

const globals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Reflect.get(globalThis, key)]),
)
let root: ReturnType<typeof createRoot> | undefined
let dom: JSDOM | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  Object.assign(globalThis, globals)
})

async function setup(mode: 'commit' | 'pending') {
  dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://fixture.test' })
  Object.assign(
    globalThis,
    Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']
      .map(key => [key, key === 'window' ? dom!.window : Reflect.get(dom!.window, key)])),
    { IS_REACT_ACT_ENVIRONMENT: true },
  )
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  const registry = new ModelProviderRegistry(async () => [{
    providerId: 'deepseek',
    pluginId: 'deepseek-plugin',
    title: 'DeepSeek',
    models: [{ id: 'deepseek-b', label: 'DeepSeek B' }],
  }])
  await registry.refresh()
  const openaiAssignment: NativeModelAssignment = { providerId: 'openai', model: 'openai-a' }
  let state: ProviderSelectionSnapshot = {
    available: true,
    busy: false,
    threadId: 'thread-1',
    modelProvider: 'openai',
    model: 'openai-a',
    nativeModelsScope: 'global',
    nativeModels: [
      { id: 'deepseek-unowned', label: 'DeepSeek Unowned', disabled: false },
      { id: 'openai-a', label: 'OpenAI A', disabled: false },
      { id: 'gpt-unowned', label: 'GPT Unowned', disabled: false },
    ],
    nativeModelAssignments: [openaiAssignment],
  }
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  const select = vi.fn(async (target: { providerId: string; model: string }) => {
    if (target.providerId === 'deepseek' && mode === 'pending') {
      state = { ...state, pendingProviderId: target.providerId, pendingModel: target.model }
    } else {
      const assignment = { providerId: target.providerId, model: target.model }
      state = {
        ...state,
        modelProvider: target.providerId,
        model: target.model,
        pendingProviderId: undefined,
        pendingModel: undefined,
        nativeModelAssignments: target.providerId === 'openai'
          ? state.nativeModelAssignments
          : [...(state.nativeModelAssignments ?? []), assignment],
      }
    }
    notify()
    return 'accepted' as const
  })
  root = createRoot(document.getElementById('root')!)
  await act(async () =>
    root!.render(
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
  return { registry, select }
}

async function click(selector: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`${selector}:not(:disabled)`)
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('global native catalog provider roundtrip', () => {
  it('keeps confirmed OpenAI A available after switching to configured DeepSeek B', async () => {
    const { registry, select } = await setup('commit')
    await click('.cxmp-provider-trigger')
    await click('[data-provider-id="deepseek"]')
    await click('.cxmp-provider-trigger')
    const official = document.querySelector<HTMLButtonElement>('[data-provider-id="openai"]')!
    expect(official.disabled).toBe(false)
    await act(async () => official.click())
    expect(select).toHaveBeenLastCalledWith({ providerId: 'openai', model: 'openai-a' })
    await click('.cxmp-model-trigger')
    await click('.cxmp-model-disclosure')
    expect([...document.querySelectorAll('.cxmp-model-choice')].map(row => row.textContent)).toEqual(['OpenAI A'])
    registry.dispose()
  })

  it('cancels a pending DeepSeek switch through the confirmed OpenAI A row', async () => {
    const { registry, select } = await setup('pending')
    await click('.cxmp-provider-trigger')
    await click('[data-provider-id="deepseek"]')
    await click('.cxmp-provider-trigger')
    const official = document.querySelector<HTMLButtonElement>('[data-provider-id="openai"]')!
    expect(official.disabled).toBe(false)
    await act(async () => official.click())
    expect(select).toHaveBeenLastCalledWith({ providerId: 'openai', model: 'openai-a' })
    registry.dispose()
  })
})
