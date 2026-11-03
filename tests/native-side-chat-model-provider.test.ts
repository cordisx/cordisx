import { expect, it, vi } from 'vitest'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, settle } from './fixtures/native-model-provider-transport-harness.js'
import type { NativeProviderSelectionProjection } from '../packages/cli/src/renderer/native-provider-selection-client.js'

it('keeps main and side native controls, selections and Send scopes independent', async () => {
  const h = await harness()
  h.transport.dispose()
  const document = h.dom.window.document
  const main = h.trigger.closest<HTMLElement>('[data-codex-composer-root]')!
  const sideControl = composer(document, 'side-thread')
  const side = sideControl.trigger.closest<HTMLElement>('[data-codex-composer-root]')!
  document.body.prepend(main)
  const projections = new Map<string, NativeProviderSelectionProjection>()
  h.channel.selectionRead.mockImplementation(async input => {
    const key = input.scope.composerId!
    const prior = projections.get(key)
    const value = prior ?? { available: true, revision: 1, effective: input.effective! }
    projections.set(key, value)
    return value
  })
  h.channel.selectionSelect.mockImplementation(async input => {
    const value = {
      available: true,
      revision: projections.get(input.scope.composerId!)!.revision + 1,
      effective: { providerId: input.providerId, model: input.model },
    }
    projections.set(input.scope.composerId!, value)
    return { ...value, status: 'accepted' }
  })
  h.channel.submissionPrepare.mockResolvedValue({ status: 'pass-through' })
  const owner = { targetId: 'target', rendererGeneration: 'renderer' }
  const first = await CodexDesktopNativeModelProviderTransport.connect(true, owner, h.channel, undefined, main, 'main')
  const second = await CodexDesktopNativeModelProviderTransport.connect(true, owner, h.channel, undefined, side, 'side')
  try {
    await settle()
    expect(first?.getSnapshot()).toMatchObject({ available: true, threadId: 'thread-1', model: 'model-a' })
    expect(second?.getSnapshot()).toMatchObject({ available: true, threadId: 'side-thread', model: 'model-a' })
    expect(await second!.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(sideControl.selectModel).toHaveBeenCalledWith('model-b', undefined)
    expect(h.selectModel).not.toHaveBeenCalled()
    expect(first?.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'model-a' })
    expect(second?.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
    const hook = (globalThis as any).__cordisxNativeSubmitHook
    await expect(hook({
      target: 'local',
      thread: 'side-thread',
      response: false,
      followUp: 'local',
      followUpThread: 'side-thread',
      defaultAction: 'queue',
      explicitAction: undefined,
      edit: null,
      promptOverride: false,
    })).resolves.toEqual({ allow: true, serviceTier: 'default' })
    expect(h.channel.submissionPrepare).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ composerId: 'side', threadId: 'side-thread' }),
    }))
    // Retiring the side instance restores neither the main state nor its active submission authority.
    second!.dispose()
    side.remove()
    await settle()
    expect(first?.getSnapshot()).toMatchObject({ available: true, modelProvider: 'provider-a', model: 'model-a' })
    expect((globalThis as any).__cordisxNativeSubmissionAuthority.snapshot().scope.composerId).toBe('main')
  } finally {
    first?.dispose()
    second?.dispose()
    h.dom.window.close()
  }
})
