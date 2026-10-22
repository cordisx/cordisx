import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { click, dom, modelTrigger, setup } from './fixtures/model-provider-selector-harness.js'

describe('pending model reasoning slider', () => {
  it('uses the pending direct-provider effort instead of the effective native effort and commits a change', async () => {
    const { update, selectReasoningEffort } = await setup('deepseek-flash', false, {
      firstProviderId: 'deepseek',
      firstModels: [{
        id: 'deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        reasoningCapabilities: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      }],
    })
    await update({
      modelProvider: 'openai',
      model: 'native-model',
      reasoningEffort: 'high',
      pendingProviderId: 'deepseek',
      pendingModel: 'deepseek-flash',
      pendingReasoningEffort: 'low',
    })
    await click(modelTrigger)
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider.disabled).toBe(false)
    expect(slider.value).toBe('0')
    expect(slider.max).toBe('2')
    selectReasoningEffort.mockImplementationOnce(async () => {
      await update({ pendingReasoningEffort: 'max' })
      return 'accepted'
    })
    await act(async () => {
      slider.value = '2'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      slider.dispatchEvent(new dom!.window.KeyboardEvent('keyup', { key: 'End', bubbles: true }))
    })
    expect(selectReasoningEffort).toHaveBeenCalledWith('max')
    expect(document.querySelector('.cxmp-announcement')?.textContent).toContain('Reasoning effort updated')
    expect(slider.value).toBe('2')
  })

  it('remounts the slider on pending target change so an unfinished drag cannot leak', async () => {
    const { update, selectReasoningEffort } = await setup('a', false, {
      firstModels: ['a', 'b'].map(id => ({
        id,
        label: id,
        reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'high' },
      })),
    })
    await update({
      modelProvider: 'openai',
      model: 'native-model',
      pendingProviderId: 'first',
      pendingModel: 'a',
      pendingReasoningEffort: 'high',
    })
    await click(modelTrigger)
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    await act(async () => {
      slider.value = '0'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    })
    await update({ pendingModel: 'b' })
    const next = document.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(next).not.toBe(slider)
    expect(next.value).toBe('1')
    expect(selectReasoningEffort).not.toHaveBeenCalled()
  })
})
