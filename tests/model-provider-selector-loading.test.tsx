import { expect, it } from 'vitest'
import { click, modelTrigger, providerTrigger, setup } from './fixtures/model-provider-selector-harness.js'

it('does not identify an unread or failed provider projection as official Codex', async () => {
  const { update, select } = await setup()
  await update({ available: false, modelProvider: undefined, model: undefined, reasoningEffort: undefined })
  expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toBe('Model services: Choose provider')
  expect(document.querySelector(`${providerTrigger} svg`)).toBeNull()
  await click(providerTrigger)
  expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')).toBeNull()
  expect(select).not.toHaveBeenCalled()
  await update({ available: true, modelProvider: 'openai', model: 'native' })
  expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toBe('Model services: Codex')
  expect(document.querySelector(`${providerTrigger} svg`)).not.toBeNull()
})

it('shows a remembered draft provider while its exact preference is being applied', async () => {
  const { update } = await setup('shared', false, { liveCatalog: true })
  await update({
    threadId: undefined,
    available: false,
    modelProvider: 'openai',
    draftPreference: { providerId: 'second', generation: 1, revision: 1 },
  })
  expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toBe('Model services: second')
  expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('Choose model')
  await update({ draftPreference: { providerId: 'second', model: 'other', generation: 1, revision: 1 } })
  expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('Other')
  await update({
    available: false,
    threadId: 'unrelated',
    modelProvider: 'openai',
    draftPreference: { providerId: 'second', model: 'other', generation: 1, revision: 1 },
  })
  expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toBe('Model services: Codex')
})
