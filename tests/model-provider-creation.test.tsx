import { describe, expect, it } from 'vitest'
import { setup } from './fixtures/model-provider-selector-harness.js'

describe('model selection while creating a native chat', () => {
  it('shows captured model/effort through a provider-only draft preference without enabling interaction', async () => {
    const h = await setup('native-default', false, {
      draft: true,
      liveCatalog: true,
      draftPreference: { providerId: 'second', generation: 1, revision: 1 },
      secondModels: [{ id: 'chosen', label: 'Chosen model' }],
    })
    await h.update({
      available: false,
      busy: true,
      pendingCreation: { clientThreadId: 'own', model: 'chosen', reasoningEffort: 'ultra' },
    })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Chosen model')
    expect(document.querySelector('.cxmp-effort-label')?.textContent).toBe('Ultra')
    expect(document.querySelector<HTMLButtonElement>('.cxmp-model-trigger')?.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('.cxmp-provider-trigger')?.disabled).toBe(true)
    expect(document.querySelector('.cxmp-selector')?.getAttribute('data-cordisx-model-send-eligible')).toBe('false')
    expect(h.select).not.toHaveBeenCalled()
    await h.update({
      available: true,
      busy: false,
      threadId: 'created',
      modelProvider: 'second',
      model: 'chosen',
      reasoningEffort: 'ultra',
      pendingCreation: undefined,
      draftPreference: undefined,
    })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Chosen model')
    expect(document.querySelector<HTMLButtonElement>('.cxmp-model-trigger')?.disabled).toBe(false)
  })

  it('clears creation display on cancel and never applies another provider model', async () => {
    const h = await setup('native-default', false, {
      draft: true,
      liveCatalog: true,
      draftPreference: { providerId: 'second', generation: 1, revision: 1 },
    })
    await h.update({
      available: false,
      pendingCreation: { clientThreadId: 'own', model: 'not-in-second', reasoningEffort: 'max' },
    })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Choose model')
    await h.update({ pendingCreation: { clientThreadId: 'own', model: 'shared', reasoningEffort: 'max' } })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Equivalent')
    await h.update({ pendingCreation: undefined })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Choose model')
    expect(h.select).not.toHaveBeenCalled()
  })
})
