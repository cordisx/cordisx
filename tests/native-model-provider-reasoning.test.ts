import { describe, expect, it, vi } from 'vitest'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, message, settle } from './fixtures/native-model-provider-transport-harness.js'
import type { NativeProviderSelectionProjection } from '../packages/cli/src/renderer/native-provider-selection-client.js'

const capabilities = { efforts: ['low', 'high', 'max'] as const, defaultEffort: 'high' as const }
const target = { providerId: 'deepseek', model: 'deepseek-flash' }
const descriptor = { target: 'local', response: false, promptOverride: false }
const hook = () => (globalThis as any).__cordisxNativeSubmitHook

describe('catalog-backed reasoning selection', () => {
  it('carries native same-model reasoning through a pending catalog with missing metadata', async () => {
    const h = await harness(undefined, provider => provider === 'gateway' ? null : undefined)
    try {
      composer(h.dom.window.document, null)
      await settle()
      expect(await h.transport.select({ providerId: 'gateway', model: 'MODEL-A' })).toBe('accepted')
      expect(await h.transport.selectReasoningEffort('low')).toBe('accepted')
      h.channel.submissionPrepare.mockResolvedValueOnce({ status: 'allow-original', operationToken: 'draft-token' })
      expect(await hook()(descriptor)).toEqual({ allow: true, operationToken: 'draft-token', reasoningEffort: 'low' })
      expect(h.channel.submissionPrepare).toHaveBeenLastCalledWith(expect.objectContaining({
        action: expect.objectContaining({ reasoningEffort: 'low' }),
      }))
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it('stages draft effort without changing the effective native model, then carries it on first Send', async () => {
    const h = await harness(undefined, provider => provider === 'deepseek' ? capabilities : undefined)
    try {
      const fresh = composer(h.dom.window.document, null)
      await settle()
      expect(await h.transport.select(target)).toBe('accepted')
      expect(await h.transport.selectReasoningEffort('max')).toBe('accepted')
      expect(await h.transport.selectReasoningEffort('ultra')).toBe('unavailable')
      expect(h.transport.getSnapshot()).toMatchObject({
        modelProvider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high',
        pendingProviderId: 'deepseek',
        pendingModel: 'deepseek-flash',
        pendingReasoningEffort: 'max',
      })
      expect(fresh.selectModel).not.toHaveBeenCalled()
      h.channel.submissionPrepare.mockResolvedValueOnce({
        status: 'allow-original',
        operationToken: 'draft-operation-token',
      })
      expect(await hook()(descriptor)).toEqual({
        allow: true,
        operationToken: 'draft-operation-token',
        reasoningEffort: 'max',
      })
      expect(h.channel.submissionPrepare).toHaveBeenLastCalledWith({
        scope: expect.not.objectContaining({ threadId: expect.any(String) }),
        action: expect.objectContaining({ intent: 'ordinary-send', reasoningEffort: 'max' }),
      })
      expect(fresh.selectModel).not.toHaveBeenCalled()
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it.each(['cancel', 'navigation', 'model'] as const)('discards staged effort after %s', async change => {
    const h = await harness(undefined, provider => provider === 'deepseek' ? capabilities : undefined)
    try {
      composer(h.dom.window.document, null)
      await settle()
      await h.transport.select(target)
      await h.transport.selectReasoningEffort('max')
      if (change === 'cancel') {
        await h.transport.select({ providerId: 'provider-a', model: 'model-a' })
        expect(h.transport.getSnapshot().pendingReasoningEffort).toBeUndefined()
        await h.transport.select(target)
      } else if (change === 'navigation') {
        composer(h.dom.window.document, 'thread-2')
        await settle()
      } else await h.transport.select({ ...target, model: 'deepseek-v4-pro' })
      expect(h.transport.getSnapshot().pendingReasoningEffort).not.toBe('max')
      expect(h.transport.getSnapshot().reasoningEffort).toBe('high')
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it.each([false, true])('applies pending existing-thread effort only after confirmation (%s)', async confirmed => {
    const h = await harness(undefined, provider => provider === 'deepseek' ? capabilities : undefined)
    let projection: NativeProviderSelectionProjection = {
      available: true,
      revision: 10,
      effective: { providerId: 'provider-a', model: 'model-a' },
      pending: { ...target, generation: 1 },
    }
    try {
      h.channel.selectionRead.mockImplementation(async () => projection)
      h.channel.selectionSelect.mockImplementation(async () => ({
        ...projection,
        status: 'accepted',
        effective: projection.effective!,
      }))
      h.channel.submissionPrepare.mockResolvedValue({
        status: 'confirm',
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 10,
      })
      h.channel.submissionConfirm.mockImplementation(async () => {
        projection = { available: true, revision: 11, effective: target }
        return { status: 'allow-original', operationToken: 'confirmed-operation-token', projection }
      })
      await h.transport.select(target)
      await h.transport.selectReasoningEffort('max')
      h.selectModel.mockClear()
      const submit = hook()({ ...descriptor, thread: 'thread-1', followUp: 'local', followUpThread: 'thread-1' })
      await settle()
      expect(h.selectModel).not.toHaveBeenCalled()
      expect(await h.transport.selectReasoningEffort('low')).toBe('busy')
      h.transport.confirmSubmission(confirmed)
      expect(await submit).toEqual(
        confirmed
          ? { allow: true, operationToken: 'confirmed-operation-token', reasoningEffort: 'max' }
          : { allow: false },
      )
      expect(h.channel.submissionPrepare).toHaveBeenLastCalledWith(expect.objectContaining({
        action: expect.objectContaining({ reasoningEffort: 'max' }),
      }))
      if (confirmed) {
        expect(h.selectModel).toHaveBeenLastCalledWith('deepseek-flash', 'max')
        expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'deepseek', reasoningEffort: 'max' })
        expect(h.transport.getSnapshot().pendingReasoningEffort).toBeUndefined()
      } else {
        expect(h.selectModel).not.toHaveBeenCalled()
        expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', reasoningEffort: 'high' })
        expect(h.channel.submissionCancel).toHaveBeenCalled()
      }
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it('allows catalog levels absent from native metadata, survives refresh and rolls back a rejected callback', async () => {
    const h = await harness(undefined, () => capabilities)
    try {
      expect(h.transport.getSnapshot().reasoningEfforts).toEqual(['low', 'high', 'max'])
      expect(await h.transport.selectReasoningEffort('max')).toBe('accepted')
      expect(h.selectModel).toHaveBeenLastCalledWith('model-a', 'max')
      const changed = vi.fn()
      h.transport.subscribe(changed)
      h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
      await settle()
      expect(changed).not.toHaveBeenCalled()
      expect(h.transport.getSnapshot().reasoningEffort).toBe('max')
      h.selectModel.mockRejectedValueOnce(new Error('native callback failed'))
      expect(await h.transport.selectReasoningEffort('low')).toBe('unavailable')
      expect(h.selectModel).toHaveBeenLastCalledWith('model-a', 'max')
      expect(h.transport.getSnapshot().reasoningEffort).toBe('max')
      message(h.dom.window, {
        type: 'mcp-notification',
        hostId: 'local',
        message: { method: 'turn/completed', params: { threadId: 'thread-1' } },
      })
      await settle()
      expect(h.transport.getSnapshot()).toMatchObject({
        reasoningEffort: 'max',
        reasoningEfforts: ['low', 'high', 'max'],
      })
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })
})
