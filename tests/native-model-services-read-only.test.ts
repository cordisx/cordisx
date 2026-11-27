import { expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'

it('serves the owner model snapshot without exposing or accepting a write channel', async () => {
  const read = vi.fn(async () => ({ status: 'ok' as const, revision: 'owner-revision', services: [] }))
  const h = await harness({ modelServices: { read } })
  try {
    expect(await h.channel.modelServicesRead()).toEqual({ status: 'ok', revision: 'owner-revision', services: [] })
    expect(h.channel.modelServicesSave).toBeUndefined()
    h.world.__cordisxNativeSubmissionCommand(JSON.stringify({
      requestId: 'forged-write',
      operation: 'modelServicesSave',
      input: { generation: h.draft.rendererGeneration, request: {} },
    }))
    await vi.waitFor(() =>
      expect(h.session.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({
          expression: expect.stringMatching(/"requestId":"forged-write","ok":false/u),
        }),
      )
    )
    expect(read).toHaveBeenCalledOnce()
  } finally {
    await h.installed.dispose()
  }
})
