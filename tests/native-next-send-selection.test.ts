import { describe, expect, it, vi } from 'vitest'
import {
  NativeProviderSelectionClient,
  type NativeProviderSelectionCommandChannel,
  type NativeProviderSelectionProjection,
} from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { harness as transportHarness, message, settle } from './fixtures/native-model-provider-transport-harness.js'
import { composer } from './fixtures/native-model-provider-composer.js'

const scope = { targetId: 'target', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: 'thread' }
const effective = { providerId: 'a', model: 'model-a' }
const target = { providerId: 'b', model: 'model-b', reasoningEffort: 'high' as const }
const send = {
  target: 'local',
  thread: 'thread',
  response: false,
  followUp: 'local',
  followUpThread: 'thread',
  promptOverride: false,
}
async function clientHarness() {
  let idle = false
  let valid = true
  let projection: NativeProviderSelectionProjection = { available: true, revision: 1, effective }
  const sync = vi.fn(async () => {})
  const notice = vi.fn()
  const channel: NativeProviderSelectionCommandChannel = {
    selectionRead: vi.fn(async () => projection),
    selectionSelect: vi.fn(async input => {
      projection = {
        available: true,
        revision: projection.revision + 1,
        effective,
        pending: { providerId: input.providerId, model: input.model, generation: 2 },
      }
      return { status: 'accepted', ...projection, effective }
    }),
    selectionDiscard: vi.fn(async () => {
      projection = { available: true, revision: projection.revision + 1, effective }
      return projection
    }),
    submissionPrepare: vi.fn(async () => ({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: projection.revision,
    })),
    submissionConfirm: vi.fn(async () => {
      projection = {
        available: true,
        revision: projection.revision + 1,
        effective: { providerId: 'b', model: 'model-b' },
      }
      return { status: 'allow-original', operationToken: 'operation-token-exact', projection }
    }),
    submissionCancel: vi.fn(async () => {}),
  }
  const client = new NativeProviderSelectionClient(
    channel,
    () => ({ scope, idle, effective }),
    notice,
    sync,
    () => 'operation-id',
    () => undefined,
    async () => valid,
  )
  await client.refresh()
  return {
    client,
    channel,
    sync,
    notice,
    idle: () => {
      idle = true
    },
    invalidate: () => {
      valid = false
    },
  }
}
async function confirmation(h: Awaited<ReturnType<typeof clientHarness>>) {
  for (let i = 0; i < 20 && !h.client.confirmation(); i++) await Promise.resolve()
  expect(h.client.confirmation()).toBeDefined()
}
describe('next-send draft admission', () => {
  it('retains preselection through completion and busy Send without any selection effects', async () => {
    const h = await clientHarness()
    expect(h.client.stageNextSend(target)).toBe(true)
    expect(await h.client.submitHook(send)).toEqual({ allow: false })
    h.idle()
    await h.client.refresh()
    expect(h.client.snapshot().nextSend).toEqual(target)
    expect(h.channel.selectionSelect).not.toHaveBeenCalled()
    h.client.dispose()
    expect(h.client.snapshot().nextSend).toBeUndefined()
  })
  it.each([{ explicitAction: 'queue' }, { explicitAction: 'steer', response: true }, { edit: 0 }])(
    'does not consume or block native action %j',
    async changes => {
      const h = await clientHarness()
      h.client.stageNextSend(target)
      vi.mocked(h.channel.submissionPrepare).mockResolvedValue({ status: 'pass-through' })
      expect(await h.client.submitHook({ ...send, ...changes })).toEqual({ allow: true })
      expect(h.channel.selectionSelect).not.toHaveBeenCalled()
      expect(h.client.snapshot().nextSend).toEqual(target)
    },
  )
  it('keeps cancelled confirmation as a renderer draft and clears Host pending before queue', async () => {
    const h = await clientHarness()
    h.client.stageNextSend(target)
    h.idle()
    const result = h.client.submitHook(send)
    await confirmation(h)
    expect(h.client.stageNextSend({ ...target, model: 'other' })).toBe(false)
    expect(await h.client.submitHook(send)).toEqual({ allow: false })
    h.client.confirmSubmission(false)
    expect(await result).toEqual({ allow: false })
    expect(h.client.snapshot().nextSend).toEqual(target)
    expect(h.client.snapshot().pending).toBeUndefined()
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
    vi.mocked(h.channel.submissionPrepare).mockResolvedValue({ status: 'pass-through' })
    expect(await h.client.submitHook({ ...send, explicitAction: 'queue' })).toEqual({ allow: true })
  })
  it('confirms the captured provider and effort and projects a switch even if synchronization fails', async () => {
    const h = await clientHarness()
    h.client.stageNextSend(target)
    h.idle()
    h.sync.mockRejectedValueOnce(new Error('native readback failed'))
    const result = h.client.submitHook(send)
    await confirmation(h)
    h.client.confirmSubmission(true)
    expect(await result).toEqual({ allow: false })
    expect(h.client.snapshot().effective).toEqual({ providerId: 'b', model: 'model-b' })
    expect(h.client.snapshot().nextSend).toBeUndefined()
  })
  it('revalidates membership before staging and retains an invalid draft without submitting', async () => {
    const h = await clientHarness()
    h.client.stageNextSend(target)
    h.idle()
    h.invalidate()
    expect(await h.client.submitHook(send)).toEqual({ allow: false })
    expect(h.channel.selectionSelect).not.toHaveBeenCalled()
    expect(h.client.snapshot().nextSend).toEqual(target)
  })
  it('consumes a same-provider model/effort only after native acknowledgement, without confirmation', async () => {
    const h = await clientHarness()
    h.client.stageNextSend({ ...target, providerId: 'a' })
    h.idle()
    vi.mocked(h.channel.selectionSelect).mockResolvedValueOnce({
      status: 'accepted',
      revision: 2,
      effective,
      pending: { ...target, providerId: 'a', generation: 2, sendOnly: true },
    })
    vi.mocked(h.channel.submissionPrepare).mockResolvedValueOnce({
      status: 'allow-original',
      operationToken: 'operation-token-exact',
    })
    expect(await h.client.submitHook(send)).toMatchObject({
      allow: true,
      operationToken: 'operation-token-exact',
      reasoningEffort: 'high',
    })
    expect(h.sync).toHaveBeenLastCalledWith({ ...target, providerId: 'a' }, 'high')
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
    expect(h.client.snapshot().nextSend).toBeUndefined()
  })
  it('rolls back same-provider controls when native synchronization fails and keeps the draft', async () => {
    const h = await clientHarness()
    h.client.stageNextSend({ ...target, providerId: 'a' })
    h.idle()
    vi.mocked(h.channel.selectionSelect).mockResolvedValueOnce({
      status: 'accepted',
      revision: 2,
      effective,
      pending: { ...target, providerId: 'a', generation: 2, sendOnly: true },
    })
    h.sync.mockRejectedValueOnce(new Error('readback failed'))
    expect(await h.client.submitHook(send)).toEqual({ allow: false })
    expect(h.sync).toHaveBeenLastCalledWith(effective, undefined)
    expect(h.client.snapshot().nextSend).toMatchObject({ providerId: 'a' })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
  })
  it('supersedes an older draft edit before an asynchronous validation can publish it', async () => {
    const h = await clientHarness()
    const older = h.client.reserveDraftEdit()
    const newer = h.client.reserveDraftEdit()
    expect(h.client.stageNextSend(target, newer)).toBe(true)
    expect(h.client.stageNextSend({ ...target, model: 'old' }, older)).toBe(false)
    expect(h.client.snapshot().nextSend).toEqual(target)
  })

  it('preserves queue after a successful token admission before the native request consumes its pending choice', async () => {
    const h = await clientHarness()
    h.client.stageNextSend(target)
    h.idle()
    vi.mocked(h.channel.selectionSelect).mockResolvedValueOnce({
      status: 'accepted',
      revision: 2,
      effective,
      pending: { ...target, generation: 2, sendOnly: true },
    })
    vi.mocked(h.channel.submissionPrepare).mockResolvedValueOnce({
      status: 'allow-original',
      operationToken: 'operation-token-exact',
    })
    expect(await h.client.submitHook(send)).toMatchObject({ allow: true })
    expect(h.client.snapshot().nextSend).toBeUndefined()
    vi.mocked(h.channel.submissionPrepare).mockResolvedValueOnce({ status: 'pass-through' })
    expect(await h.client.submitHook({ ...send, explicitAction: 'queue' })).toEqual({ allow: true })
    expect(h.channel.selectionDiscard).not.toHaveBeenCalled()
  })

  it('fences navigation during staging and never migrates the draft', async () => {
    const h = await clientHarness()
    h.client.stageNextSend(target)
    h.idle()
    let resolve!: () => void
    vi.mocked(h.channel.selectionSelect).mockImplementationOnce(async () => {
      await new Promise<void>(done => {
        resolve = done
      })
      return { status: 'accepted', revision: 2, effective, pending: { ...target, generation: 2 } }
    })
    const result = h.client.submitHook(send)
    while (!resolve) await Promise.resolve()
    h.client.invalidateScope()
    resolve()
    expect(await result).toEqual({ allow: false })
    expect(h.client.snapshot().nextSend).toBeUndefined()
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
  })
})
describe('transport draft isolation', () => {
  it('stages same-provider model and effort, retains them at turn completion, and clears on navigation', async () => {
    const h = await transportHarness(undefined, () => ({ efforts: ['low', 'high'], defaultEffort: 'high' }))
    try {
      message(h.dom.window, {
        type: 'mcp-notification',
        hostId: 'local',
        message: { method: 'turn/started', params: { threadId: 'thread-1' } },
      })
      expect(await h.transport.select({ providerId: 'provider-a', model: 'model-b' })).toBe('accepted')
      expect(await h.transport.selectReasoningEffort('low')).toBe('accepted')
      expect(h.selectModel).not.toHaveBeenCalled()
      expect(h.channel.selectionSelect).not.toHaveBeenCalled()
      message(h.dom.window, {
        type: 'mcp-notification',
        hostId: 'local',
        message: { method: 'turn/completed', params: { threadId: 'thread-1' } },
      })
      await settle()
      expect(h.transport.getSnapshot()).toMatchObject({
        model: 'model-a',
        reasoningEffort: 'high',
        nextSend: { providerId: 'provider-a', model: 'model-b', reasoningEffort: 'low' },
      })
      composer(h.dom.window.document, 'thread-2')
      await settle()
      expect(h.transport.getSnapshot().nextSend).toBeUndefined()
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })
})
