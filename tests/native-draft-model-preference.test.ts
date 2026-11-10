import { describe, expect, it, vi } from 'vitest'
import { NativeDraftModelPreference } from '../packages/cli/src/launcher/native-draft-model-preference.js'
import { harness } from './fixtures/native-submission-channel-harness.js'

const provider = (models = ['model-default', 'model-chosen', 'model-next']) => ({
  providerId: 'provider-b',
  pluginId: 'plugin-b',
  label: 'Provider B',
  models: models.map(id => ({ id, label: id, aliases: [] })),
})

describe('last explicit model for a new native conversation', () => {
  it('uses the latest explicit choice when an earlier catalog read finishes late', async () => {
    let finish!: (value: readonly ReturnType<typeof provider>[]) => void
    const memory = new NativeDraftModelPreference({
      catalog: () =>
        new Promise(resolve => {
          finish = resolve
        }),
    })
    memory.remember({ providerId: 'provider-b', model: 'model-chosen' })
    const pending = memory.read()
    memory.remember({ providerId: 'provider-b', model: 'model-next' })
    finish([provider()])
    await expect(pending).resolves.toMatchObject({ providerId: 'provider-b', model: 'model-next' })
  })

  it('restores the user-chosen model instead of the configured launch default', async () => {
    const h = await harness({
      defaultProviderId: 'provider-b',
      defaultModelId: 'model-default',
      catalog: () => [provider()],
    })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      expect(await h.channel.selectionRead({ scope: next, effective: { providerId: 'openai', model: 'native' } }))
        .toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-chosen' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('uses a later explicit model choice in an existing conversation for the next draft', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const thread = { ...h.draft, threadId: 'thread', navigationGeneration: 4 }
      h.setLive(thread)
      await h.channel.selectionRead({ scope: thread, effective: { providerId: 'provider-b', model: 'model-chosen' } })
      await h.channel.selectionSelect({ scope: thread, providerId: 'provider-b', model: 'model-next' })
      const next = { ...h.draft, navigationGeneration: 5 }
      h.setLive(next)
      expect(await h.channel.selectionRead({ scope: next, effective: { providerId: 'openai', model: 'native' } }))
        .toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-next' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('does not let an older delayed provider switch overwrite a newer model choice', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      const first = { ...h.draft, threadId: 'first', navigationGeneration: 4 }
      h.setLive(first)
      await h.channel.selectionRead({ scope: first, effective: { providerId: 'provider-b', model: 'model-chosen' } })
      let finish!: (result: Awaited<ReturnType<typeof h.controller.commitSelection>>) => void
      vi.mocked(h.controller.commitSelection).mockImplementationOnce(async () =>
        await new Promise(resolve => {
          finish = resolve
        })
      )
      const older = h.channel.selectionSelect({ scope: first, providerId: 'openai', model: 'native-old' })
      await vi.waitFor(() => expect(h.controller.commitSelection).toHaveBeenCalledOnce())
      const second = { ...h.draft, threadId: 'second', navigationGeneration: 5 }
      h.setLive(second)
      await h.channel.selectionRead({ scope: second, effective: { providerId: 'provider-b', model: 'model-chosen' } })
      await h.channel.selectionSelect({ scope: second, providerId: 'provider-b', model: 'model-next' })
      h.setLive(first)
      finish({
        kind: 'accepted',
        projection: { available: true, revision: 3, effective: { providerId: 'openai', model: 'native-old' } },
      })
      await older
      const next = { ...h.draft, navigationGeneration: 6 }
      h.setLive(next)
      expect(await h.channel.selectionRead({ scope: next, effective: { providerId: 'openai', model: 'native' } }))
        .toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-next' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('remembers an explicitly selected OpenAI model without a plugin catalog entry', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native-old' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'openai', model: 'native-chosen' })
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      expect(
        await h.channel.selectionRead({
          scope: next,
          effective: { providerId: 'provider-b', model: 'model-default' },
        }),
      ).toMatchObject({ draftPreference: { providerId: 'openai', model: 'native-chosen' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('waits for renderer validation even when the native model already matches the preference', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native-old' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'openai', model: 'native-chosen' })
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      const projection = await h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'openai', model: 'native-chosen' },
      })
      const action = { operationId: 'draft-operation-1', operationGeneration: 1, intent: 'ordinary-send' }
      expect(await h.channel.submissionPrepare({ scope: next, action })).toMatchObject({
        status: 'reject',
        reason: 'provider-preparation-failed',
      })
      expect(h.controller.prepareSubmission).not.toHaveBeenCalled()
      await h.channel.selectionSelect({
        scope: next,
        providerId: 'openai',
        model: 'native-chosen',
        source: 'preference',
        expectedRevision: projection.revision,
      })
      await h.channel.submissionPrepare({ scope: next, action })
      expect(h.controller.prepareSubmission).toHaveBeenCalledOnce()
    } finally {
      await h.installed.dispose()
    }
  })

  it('does not treat an internal staged send as a new explicit selector choice', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const thread = { ...h.draft, threadId: 'thread', navigationGeneration: 4 }
      h.setLive(thread)
      const initial = await h.channel.selectionRead({
        scope: thread,
        effective: { providerId: 'provider-b', model: 'model-chosen' },
      })
      await h.channel.selectionSelect({
        scope: thread,
        providerId: 'openai',
        model: 'native',
        mode: 'stage-send',
        expectedRevision: initial.revision,
      })
      const next = { ...h.draft, navigationGeneration: 5 }
      h.setLive(next)
      expect(await h.channel.selectionRead({ scope: next, effective: { providerId: 'openai', model: 'native' } }))
        .toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-chosen' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('does not silently replace a removed remembered model with the configured default', async () => {
    let models = ['model-default', 'model-chosen']
    const h = await harness({
      defaultProviderId: 'provider-b',
      defaultModelId: 'model-default',
      catalog: () => [provider(models)],
    })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      models = ['model-default']
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      const projection = await h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'openai', model: 'native' },
      })
      expect(projection.draftPreference).toMatchObject({ providerId: 'provider-b' })
      expect(projection.draftPreference).not.toHaveProperty('model')
    } finally {
      await h.installed.dispose()
    }
  })

  it('retains the exact remembered startup model while its catalog is still loading', async () => {
    let models = ['model-default', 'model-chosen']
    const h = await harness({
      defaultProviderId: 'provider-b',
      defaultModelId: 'model-default',
      isStartupProvider: id => id === 'provider-b',
      catalog: () => [provider(models)],
    })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      models = []
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      const projection = await h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'openai', model: 'native' },
      })
      expect(projection.draftPreference).toMatchObject({ providerId: 'provider-b', model: 'model-chosen' })
      await expect(h.channel.selectionSelect({
        scope: next,
        providerId: 'provider-b',
        model: 'model-chosen',
        source: 'preference',
        expectedRevision: projection.revision,
      })).rejects.toThrow()
      models = ['model-default', 'model-chosen']
      expect(
        await h.channel.selectionSelect({
          scope: next,
          providerId: 'provider-b',
          model: 'model-chosen',
          source: 'preference',
          expectedRevision: projection.revision,
        }),
      ).toMatchObject({ status: 'accepted', pending: { providerId: 'provider-b', model: 'model-chosen' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('does not send through the old selection while the remembered model is being restored', async () => {
    const h = await harness({ realController: true, catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      const projection = await h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'openai', model: 'native' },
      })
      const action = { operationId: 'draft-operation-1', operationGeneration: 1, intent: 'ordinary-send' }
      expect(await h.channel.submissionPrepare({ scope: next, action })).toMatchObject({
        status: 'reject',
        reason: 'provider-preparation-failed',
      })
      expect(h.prepare).not.toHaveBeenCalled()
      await h.channel.selectionSelect({
        scope: next,
        providerId: 'provider-b',
        model: 'model-chosen',
        source: 'preference',
        expectedRevision: projection.revision,
      })
      const prepared = await h.channel.submissionPrepare({ scope: next, action })
      expect(prepared).toMatchObject({ status: 'allow-original', operationToken: expect.any(String) })
      const dispatched = await h.actual.consumeMarkedRequest({
        method: 'thread/start',
        requestId: 'native-request',
        operationToken: prepared.operationToken,
      })
      expect(dispatched).toMatchObject({
        kind: 'dispatch',
        providerId: 'provider-b',
        model: 'model-chosen',
        configOverrides: { model_provider: 'provider-b', model: 'model-chosen' },
      })
    } finally {
      await h.installed.dispose()
    }
  })

  it('rejects an automatic preference for a different model and preserves a newer manual choice', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      const projection = await h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'openai', model: 'native' },
      })
      await expect(h.channel.selectionSelect({
        scope: next,
        providerId: 'provider-b',
        model: 'model-default',
        source: 'preference',
        expectedRevision: projection.revision,
      })).rejects.toThrow()
      await h.channel.selectionSelect({ scope: next, providerId: 'provider-b', model: 'model-next' })
      await expect(h.channel.selectionSelect({
        scope: next,
        providerId: 'provider-b',
        model: 'model-chosen',
        source: 'preference',
        expectedRevision: projection.revision,
      })).rejects.toThrow()
      const following = { ...h.draft, navigationGeneration: 5 }
      h.setLive(following)
      expect(
        await h.channel.selectionRead({
          scope: following,
          effective: { providerId: 'openai', model: 'native' },
        }),
      ).toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-next' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('does not remember a rejected cross-provider switch', async () => {
    const h = await harness({ catalog: () => [provider()] })
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-chosen' })
      const thread = { ...h.draft, threadId: 'thread', navigationGeneration: 4 }
      h.setLive(thread)
      await h.channel.selectionRead({ scope: thread, effective: { providerId: 'provider-b', model: 'model-chosen' } })
      vi.mocked(h.controller.commitSelection).mockResolvedValueOnce({
        kind: 'reject',
        reason: 'provider-switch-unsupported',
      })
      expect(await h.channel.selectionSelect({ scope: thread, providerId: 'openai', model: 'native' }))
        .toMatchObject({ status: 'reject', reason: 'provider-switch-unsupported' })
      const next = { ...h.draft, navigationGeneration: 5 }
      h.setLive(next)
      expect(await h.channel.selectionRead({ scope: next, effective: { providerId: 'openai', model: 'native' } }))
        .toMatchObject({ draftPreference: { providerId: 'provider-b', model: 'model-chosen' } })
    } finally {
      await h.installed.dispose()
    }
  })
})
