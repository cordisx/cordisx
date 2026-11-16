import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ChannelPermissionRequest, ChannelRuntime } from '../packages/channel-runtime/src/index.js'
import { SimulatedChannelAdapter, simulatedInput } from '../packages/channel-runtime/src/simulator.js'

describe('Channel scoped durable readback', () => {
  it('admits conversation and actor scoped filters without requiring an account-wide grant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-readback-'))
    const message = simulatedInput('scoped', 'readback')
    const event = message.source.event
    const requests: ChannelPermissionRequest[] = []
    const caller = { source: 'fixture', pluginId: 'reader', generation: 'one' }
    const runtime = await ChannelRuntime.open({
      storePath: path.join(root, 'store.json'),
      permissions: {
        authorize: async request => {
          requests.push(request)
          if (request.capability !== 'channel.events.subscribe') return 'allow'
          const source = request.source as typeof event
          return source.conversationId === event.conversationId && source.actor?.userId === event.actor?.userId
            ? 'allow'
            : 'deny'
        },
      },
    })
    try {
      const adapter = new SimulatedChannelAdapter()
      const handle = await runtime.activate(adapter, caller)
      const filter = {
        account: adapter.descriptor.ref,
        conversationId: event.conversationId,
        userId: event.actor!.userId,
      }
      const dispose = await runtime.subscribe(caller, filter, () => {})
      try {
        await handle.receive({ input: message })
        const readback = await runtime.inputsSince(caller, [filter], 'channel-input:0:empty')
        expect(readback.messages.map(row => row.input.source.event.eventId)).toEqual(['scoped'])
        expect(
          requests.filter(request => request.capability === 'channel.events.subscribe')
            .every(request => (request.source as typeof event).conversationId === event.conversationId),
        ).toBe(true)
        await expect(runtime.inputsSince(caller, [{ account: filter.account }], 'channel-input:0:empty')).rejects
          .toThrow('CHANNEL_PERMISSION_DENIED')
      } finally {
        dispose()
      }
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
