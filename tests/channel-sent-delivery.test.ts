import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime, UncertainChannelSendError } from '../packages/channel-runtime/src/runtime.js'

it('only observes confirmed sends, never enqueue, denied or unknown delivery, and fences stale guarded outbox on restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sent-observe-'))
  const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
  const target = {
    ...ref,
    conversationId: 'chat',
    threadId: 'chat',
    kind: 'direct' as const,
    semantics: 'conversation' as const,
  }
  const caller = { source: 'test', pluginId: 'test', generation: 'test' }
  const options = { storePath: path.join(root, 'state.json'), permissions: { authorize: async () => 'allow' as const } }
  let runtime = await ChannelRuntime.open(options)
  const send = vi.fn(async () => ({ externalMessageId: 'received' }))
  const descriptor = {
    ref,
    kind: 'feishu' as const,
    implementationStatus: 'experimental' as const,
    configurationRevision: 1,
    secretState: 'ready' as const,
  }
  const definition = { descriptor, start: async () => ({ send, stop: async () => {} }) }
  try {
    let adapter = await runtime.activate(definition, caller)
    const observed = vi.fn()
    runtime.observeSentDelivery(observed)
    await runtime.notifyOnce({ target, kind: 'reply', text: 'message' }, caller, 'delivery:sent')
    expect(observed).not.toHaveBeenCalled()
    await adapter.drainOutbound(1)
    expect(observed).toHaveBeenCalledOnce()
    expect(observed.mock.calls[0]![0]).toMatchObject({ target, caller, deliveryId: 'delivery:sent' })
    send.mockRejectedValueOnce(new UncertainChannelSendError())
    await runtime.notifyOnce({ target, kind: 'reply', text: 'uncertain' }, caller, 'delivery:unknown')
    await adapter.drainOutbound(1)
    expect(observed).toHaveBeenCalledOnce()
    let current = true
    await runtime.notifyGuardedOnce(
      { target, kind: 'reply', text: 'obsolete' },
      caller,
      'delivery:guarded',
      () => current,
    )
    current = false
    await adapter.drainOutbound(1)
    expect(runtime.deliverySnapshot('delivery:guarded', caller)?.state).toBe('cancelled')
    expect(observed).toHaveBeenCalledOnce()
    await runtime.notifyGuardedOnce(
      { target, kind: 'reply', text: 'old process' },
      caller,
      'delivery:restart',
      () => true,
    )
    await runtime.dispose()
    runtime = await ChannelRuntime.open(options)
    adapter = await runtime.activate(definition, caller)
    await adapter.drainOutbound(5)
    expect(send).toHaveBeenCalledTimes(2)
    expect(runtime.deliverySnapshot('delivery:restart', caller)?.state).toBe('cancelled')
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
