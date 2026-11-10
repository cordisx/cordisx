import { expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'

it('carries the exact live source tuple through the authenticated native fork and child binding', async () => {
  const h = await harness()
  try {
    h.server.bindSourceConfigurationReader(async threadId =>
      threadId === 'source-fork'
        ? {
          providerId: 'provider-b',
          model: 'model-b',
          reasoningEffort: 'high',
          serviceTier: 'priority',
        }
        : undefined
    )
    h.send({ id: 'fork', method: 'thread/fork', params: { threadId: 'source-fork' } })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'fork',
      result: {
        thread: { id: 'fork-child' },
        modelProvider: 'provider-b',
        model: 'model-b',
        reasoningEffort: 'high',
        serviceTier: 'priority',
      },
    })
    expect(h.prepareThreadResume).toHaveBeenCalledWith({
      threadId: 'source-fork',
      providerId: 'provider-b',
      model: 'model-b',
    })
    expect(h.completeThreadResume).toHaveBeenCalledWith({
      threadId: 'source-fork',
      createdThreadId: 'fork-child',
      resumeToken: 'resume-token-source-fork',
      succeeded: true,
    })
  } finally {
    await h.close()
  }
})

it('releases a prepared fork lease when its authenticated intermediary disconnects', async () => {
  const h = await harness()
  try {
    h.server.bindSourceConfigurationReader(async () => ({
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'high',
      serviceTier: null,
    }))
    h.send({ id: 'pending-fork', method: 'thread/fork', params: { threadId: 'source-fork-pending' } })
    await vi.waitFor(() => expect(h.prepareThreadResume).toHaveBeenCalledOnce())
    await h.server.close()
    await vi.waitFor(() =>
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'source-fork-pending',
        resumeToken: 'resume-token-source-fork-pending',
        succeeded: false,
      })
    )
  } finally {
    await h.close()
  }
})
