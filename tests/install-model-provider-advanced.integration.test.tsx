import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { installModelProviderSelector } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import { harness, install, settle } from './fixtures/native-model-provider-transport-harness.js'

it('mounts both controls for the 26.1117 advanced picker and routes each choice through its authority', async () => {
  const h = await harness()
  const { dom, trigger, selectModel, channel, transport } = h
  for (const name of ['HTMLElement', 'Element', 'Node', 'MutationObserver'] as const) install(name, dom.window[name])
  install('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  const fiber = (trigger as unknown as Record<string, unknown>)['__reactFiber$test'] as {
    return: { memoizedProps: Record<string, unknown> }
  }
  fiber.return.memoizedProps.menuView = 'advanced'
  fiber.return.memoizedProps.models = ['model-a', 'model-b'].map(model => ({
    model,
    displayName: model === 'model-a' ? 'Model A' : 'Model B',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  }))
  fiber.return.memoizedProps.modelOptions = ['model-a', 'model-b'].map(model => ({
    model: { model },
    disabledReason: null,
  }))
  fiber.return.memoizedProps.powerSelections = [{ model: 'model-a', reasoningEffort: 'high' }]
  delete fiber.return.memoizedProps.onSelectReasoningEffort
  fiber.return.memoizedProps.onSelectComplete = () => {}
  fiber.return.memoizedProps.onBeforeSelectModel = () => true
  delete trigger.dataset.codexIntelligenceTrigger
  trigger.dataset.composerNavigationTarget = 'reasoning'
  trigger.dataset.selectedReasoningEffort = 'high'
  const registry = new ModelProviderRegistry(async () => [{
    providerId: 'provider-a',
    pluginId: 'plugin-a',
    models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }],
  }, {
    providerId: 'provider-b',
    pluginId: 'plugin-b',
    title: 'Provider B',
    models: [{ id: 'model-b', label: 'Model B' }],
  }])
  vi.spyOn(CodexDesktopNativeModelProviderTransport, 'connect').mockResolvedValue(transport)
  let dispose = () => {}
  try {
    await act(async () => {
      dispose = await installModelProviderSelector(dom.window.document, registry, () => 'en', true)
      await settle()
    })
    const selector = dom.window.document.querySelector<HTMLElement>('[data-cordisx-model-provider-selector]')
    expect(selector).not.toBeNull()
    expect(trigger.hidden).toBe(true)
    const modelButton = selector!.querySelector<HTMLButtonElement>('.cxmp-model-trigger')!
    const providerButton = selector!.querySelector<HTMLButtonElement>('.cxmp-provider-trigger')!
    expect(modelButton.disabled).toBe(false)
    expect(providerButton.disabled).toBe(false)

    let allowNative!: () => void
    const nativeGate = new Promise<void>(resolve => {
      allowNative = resolve
    })
    const originalSelectModel = selectModel.getMockImplementation()!
    selectModel.mockImplementation(async (model, effort) => {
      await nativeGate
      await originalSelectModel(model, effort)
    })
    channel.selectionSelect.mockClear()
    await act(async () => modelButton.click())
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.cxmp-model-disclosure')!.click())
    const model = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.cxmp-model-choice')]
      .find(choice => choice.textContent?.includes('Model B'))!
    expect(model.disabled).toBe(false)
    await act(async () => model.click())
    expect(selectModel.mock.calls[0]?.[0]).toBe('model-b')
    expect(channel.selectionSelect).not.toHaveBeenCalled()
    expect(selector!.querySelector('.cxmp-model-label')?.textContent).toBe('Model A')
    await act(async () => {
      allowNative()
      await settle()
      await settle()
    })
    expect(channel.selectionSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'provider-a',
      model: 'model-b',
    }))
    expect(selector!.querySelector('.cxmp-model-label')?.textContent).toBe('Model B')

    let allowProvider!: () => void
    const providerGate = new Promise<void>(resolve => {
      allowProvider = resolve
    })
    const originalSelectProvider = channel.selectionSelect.getMockImplementation()!
    channel.selectionSelect.mockImplementationOnce(async input => {
      await providerGate
      return originalSelectProvider(input)
    })
    const beforeProvider = providerButton.getAttribute('aria-label')
    await act(async () => providerButton.click())
    const provider = dom.window.document.querySelector<HTMLButtonElement>('[data-provider-id="provider-b"]')!
    expect(provider.disabled).toBe(false)
    await act(async () => {
      provider.click()
      await settle()
    })
    expect(channel.selectionSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'provider-b',
      model: 'model-b',
    }))
    expect(providerButton.getAttribute('aria-label')).toBe(beforeProvider)
    await act(async () => {
      allowProvider()
      await settle()
      await settle()
    })
    expect(providerButton.getAttribute('aria-label')).toContain('Provider B')
  } finally {
    await act(async () => dispose())
    registry.dispose()
    dom.window.close()
  }
})
