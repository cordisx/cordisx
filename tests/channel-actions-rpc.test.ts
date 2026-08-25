import { describe, expect, it } from 'vitest'
import { createChannelActionsBridgeHandler } from '../packages/cli/src/launcher/channel-actions-rpc.js'

describe('Channel action Host bridge', () => {
  it('forwards only token-bound connection and binding actions to the launcher API', async () => {
    const calls: unknown[] = []
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: {
        connections: {
          enable: async value => { calls.push(['enable', value]); return { status: 'applied' as const } },
          disable: async value => { calls.push(['disable', value]); return { status: 'applied' as const } },
          reconnect: async value => { calls.push(['reconnect', value]); return { status: 'applied' as const } },
        },
        bindings: {
          archive: async value => { calls.push(['archive', value]); return { status: 'applied' as const } },
          restore: async value => { calls.push(['restore', value]); return { status: 'applied' as const } },
          unbind: async value => { calls.push(['unbind', value]); return { status: 'applied' as const } },
        },
      } as never,
    })
    await expect(handler.handle({
      version: 1, token: handler.token, action: 'reconnect',
      ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    })).resolves.toMatchObject({ status: 'applied' })
    await expect(handler.handle({ version: 1, token: handler.token, action: 'archive', bindingId: 'binding-1' }))
      .resolves.toMatchObject({ status: 'applied' })
    expect(calls).toEqual([
      ['reconnect', { ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' } }],
      ['archive', { bindingId: 'binding-1' }],
    ])
    await expect(handler.handle({ version: 1, token: 'wrong', action: 'enable', ref: {} })).rejects.toThrow('unauthorized')
  })
})
