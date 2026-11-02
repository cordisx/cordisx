import { describe, expect, it } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'
import { NativeProviderSelectionClient } from '../packages/cli/src/renderer/native-provider-selection-client.js'

const effective = { providerId: 'openai', model: 'native-model' }
const descriptor = { target: 'local', response: false, promptOverride: false }
const catalog = [{
  providerId: 'provider-b',
  pluginId: 'plugin-b',
  label: 'B',
  models: [{ id: 'model-b', label: 'B' }],
}]

async function setup(initialRead = true) {
  let ready = false
  const h = await harness({ realController: true, catalog: () => ready ? catalog : [] })
  let scope = h.draft
  const client = new NativeProviderSelectionClient(
    h.channel,
    () => ({ scope, idle: true, effective }),
    () => {},
    async () => {},
  )
  if (initialRead) await client.refresh()
  return {
    ...h,
    client,
    ready: () => {
      ready = true
    },
    navigate(threadId: string) {
      scope = { ...scope, navigationGeneration: scope.navigationGeneration + 1, threadId }
      h.setLive(scope)
      client.invalidateScope()
      return scope
    },
    async close() {
      client.dispose()
      await h.installed.dispose()
      await h.actual.dispose()
    },
  }
}

describe('actual Host provider-only intent channel/client/controller', () => {
  it('keeps declared and catalog-ready intent fenced until explicit model acknowledgement', async () => {
    const h = await setup()
    try {
      expect(await h.client.selectProviderIntent('provider-b')).toBe('accepted')
      expect(h.client.snapshot()).toMatchObject({ effective, pendingProviderIntent: { providerId: 'provider-b' } })
      expect(h.client.snapshot().pending).toBeUndefined()
      expect(await h.client.submitHook(descriptor)).toEqual({ allow: false })
      expect(
        await h.actual.prepareSubmission(h.draft, {
          intent: 'ordinary-send',
          operationId: 'direct',
          operationGeneration: 1,
        }),
      ).toMatchObject({ kind: 'reject' })
      h.ready()
      await h.client.refresh()
      expect(await h.client.submitHook(descriptor)).toEqual({ allow: false })
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.switchThread).not.toHaveBeenCalled()
      expect(await h.client.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
      expect(h.client.snapshot().pendingProviderIntent).toBeUndefined()
      expect(await h.client.submitHook(descriptor)).toMatchObject({ allow: true })
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('accepts intent before the first effective read and never invents an executable selection', async () => {
    const h = await setup(false)
    try {
      expect(await h.client.selectProviderIntent('provider-b')).toBe('accepted')
      expect(h.client.snapshot()).toMatchObject({
        available: false,
        pendingProviderIntent: { providerId: 'provider-b' },
      })
      expect(h.client.snapshot().effective).toBeUndefined()
      expect(await h.client.submitHook(descriptor)).toEqual({ allow: false })
      await h.client.refresh()
      expect(h.client.snapshot()).toMatchObject({ effective, pendingProviderIntent: { providerId: 'provider-b' } })
      expect(h.prepare).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('fences failed/stale cancellation and isolates navigation and two thread scopes', async () => {
    const h = await setup()
    try {
      await h.client.selectProviderIntent('provider-b')
      const oldRevision = h.client.snapshot().revision
      await h.channel.selectionProviderIntent({
        scope: h.draft,
        providerId: 'provider-c',
        expectedRevision: oldRevision,
      })
      expect(await h.client.cancelProviderIntent()).toBe('unavailable')
      expect(await h.client.submitHook(descriptor)).toEqual({ allow: false })
      await h.client.refresh()
      expect(await h.client.cancelProviderIntent()).toBe('accepted')
      expect(h.client.snapshot().effective).toEqual(effective)
      expect(await h.client.submitHook(descriptor)).toEqual({ allow: true })
      const first = h.navigate('thread-1')
      await h.client.refresh()
      await h.client.selectProviderIntent('provider-b')
      const second = h.navigate('thread-2')
      await h.client.refresh()
      expect(h.client.snapshot().pendingProviderIntent).toBeUndefined()
      expect(h.authority.selection.snapshot(first).pendingProviderIntent?.providerId).toBe('provider-b')
      expect(h.authority.selection.snapshot(second).pendingProviderIntent).toBeUndefined()
      await expect(h.channel.selectionCancelProviderIntent({ scope: first, expectedRevision: 2 })).rejects.toThrow()
      expect(h.prepare).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('invalidates a prepared token and queued next-send when a provider-only intent is staged', async () => {
    const h = await setup()
    try {
      h.ready()
      await h.client.select({ providerId: 'provider-b', model: 'model-b' })
      const prepared = await h.actual.prepareSubmission(h.draft, {
        intent: 'ordinary-send',
        operationId: 'token',
        operationGeneration: 1,
      })
      expect(prepared.kind).toBe('allow-original')
      expect(h.client.stageNextSend({ providerId: 'openai', model: 'native-model' })).toBe(true)
      await h.client.selectProviderIntent('provider-b')
      expect(h.client.snapshot().nextSend).toBeUndefined()
      expect(h.client.stageNextSend({ providerId: 'openai', model: 'native-model' })).toBe(false)
      if (prepared.kind !== 'allow-original') throw new Error('missing token')
      expect(
        await h.actual.consumeMarkedRequest({
          operationToken: prepared.operationToken,
          method: 'thread/start',
          requestId: 'late',
        }),
      ).toMatchObject({ kind: 'reject' })
      expect(h.credentialDispose).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('ignores a successful late model acknowledgement after client navigation', async () => {
    const h = await setup()
    let scope = h.draft
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const channel = {
      ...h.channel,
      selectionSelect: async (input: unknown) => {
        const ack = await h.channel.selectionSelect(input)
        await held
        return ack
      },
    }
    const client = new NativeProviderSelectionClient(
      channel,
      () => ({ scope, idle: true, effective }),
      () => {},
      async () => {},
    )
    try {
      await client.refresh()
      await client.selectProviderIntent('provider-b')
      h.ready()
      const selected = client.select({ providerId: 'provider-b', model: 'model-b' })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      scope = { ...scope, navigationGeneration: scope.navigationGeneration + 1, threadId: 'other' }
      h.setLive(scope)
      client.invalidateScope()
      await client.refresh()
      await client.selectProviderIntent('provider-c')
      release()
      expect(await selected).toBe('unavailable')
      expect(client.snapshot().pendingProviderIntent?.providerId).toBe('provider-c')
      expect(await client.submitHook(descriptor)).toEqual({ allow: false })
      expect(h.prepare).not.toHaveBeenCalled()
    } finally {
      release()
      client.dispose()
      await h.close()
    }
  })

  it('keeps a lost model acknowledgement fenced even after a successful refresh', async () => {
    const h = await setup()
    let release!: () => void
    let lost = false
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const channel = {
      ...h.channel,
      selectionSelect: async (input: unknown) => {
        const ack = await h.channel.selectionSelect(input)
        await held
        if (lost) throw new Error('acknowledgement lost')
        return ack
      },
    }
    const client = new NativeProviderSelectionClient(
      channel,
      () => ({ scope: h.draft, idle: true, effective }),
      () => {},
      async () => {},
    )
    try {
      await client.refresh()
      await client.selectProviderIntent('provider-b')
      h.ready()
      const selection = client.select({ providerId: 'provider-b', model: 'model-b' })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(await client.submitHook(descriptor)).toEqual({ allow: false })
      lost = true
      release()
      expect(await selection).toBe('unavailable')
      await client.refresh()
      expect(await client.submitHook(descriptor)).toEqual({ allow: false })
      expect(h.prepare).not.toHaveBeenCalled()
      expect(await client.cancelProviderIntent()).toBe('accepted')
    } finally {
      release()
      client.dispose()
      await h.close()
    }
  })

  it('does not clear the guard when a real existing-thread model acknowledgement fails', async () => {
    const h = await setup()
    try {
      h.navigate('thread-1')
      await h.client.refresh()
      await h.client.selectProviderIntent('provider-b')
      h.ready()
      h.switchThread.mockRejectedValueOnce(new Error('native failure'))
      expect(await h.client.select({ providerId: 'provider-b', model: 'model-b' })).toBe('unavailable')
      await h.client.refresh()
      expect(h.client.snapshot().pendingProviderIntent?.providerId).toBe('provider-b')
      expect(await h.client.submitHook({ ...descriptor, thread: 'thread-1' })).toEqual({ allow: false })
      expect(await h.client.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
      expect(h.client.snapshot().pendingProviderIntent).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})
