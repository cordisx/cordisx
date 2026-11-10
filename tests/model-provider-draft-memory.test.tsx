import { expect, it } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'
import { setup } from './fixtures/model-provider-selector-harness.js'

it('restores the exact last provider and model through the Host channel and live-catalog selector', async () => {
  const host = await harness({
    catalog: () => [{
      providerId: 'second',
      pluginId: 'q',
      label: 'Second',
      models: [{ id: 'shared', label: 'Equivalent' }, { id: 'other', label: 'Other' }],
    }],
  })
  try {
    await host.channel.selectionRead({ scope: host.draft, effective: { providerId: 'openai', model: 'native' } })
    await host.channel.selectionSelect({ scope: host.draft, providerId: 'second', model: 'other' })
    const next = { ...host.draft, navigationGeneration: 4 }
    host.setLive(next)
    const projection = await host.channel.selectionRead({
      scope: next,
      effective: { providerId: 'openai', model: 'native' },
    })
    const ui = await setup('shared', false, {
      draft: true,
      liveCatalog: true,
      draftPreference: { ...projection.draftPreference, revision: projection.revision },
    })
    expect(ui.select).toHaveBeenCalledWith({ providerId: 'second', model: 'other' }, {
      source: 'preference',
      expectedRevision: projection.revision,
    })
    expect(document.querySelector('.cxmp-model-label')?.textContent).toBe('Other')
    expect(
      await host.channel.selectionSelect({
        scope: next,
        providerId: 'second',
        model: 'other',
        source: 'preference',
        expectedRevision: projection.revision,
      }),
    ).toMatchObject({ status: 'accepted', pending: { providerId: 'second', model: 'other' } })
  } finally {
    await host.installed.dispose()
  }
})

it('waits for a remembered official model to be present in the native catalog', async () => {
  const ui = await setup('shared', false, {
    draft: true,
    liveCatalog: true,
    draftPreference: { providerId: 'openai', model: 'native-chosen', generation: 1, revision: 1 },
  })
  expect(ui.select).not.toHaveBeenCalled()
  await ui.update({ nativeModels: [{ id: 'native-chosen', label: 'Native chosen', disabled: false }] })
  expect(ui.select).toHaveBeenCalledWith({ providerId: 'openai', model: 'native-chosen' }, {
    source: 'preference',
    expectedRevision: 1,
  })
})
