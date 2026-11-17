import { describe, expect, it, vi } from 'vitest'
import { createChannelActionsBridgeHandler } from '../packages/cli/src/launcher/channel-actions-rpc.js'

describe('Channel action Host bridge', () => {
  it('projects sparse live policy without forwarding transport fields', async () => {
    const executionOperation = vi.fn(async () => ({
      status: 'ok',
      policy: { enabled: true, thresholdRatio: 0.1 },
      overrides: { thresholdRatio: 0.1 },
      defaultsRevision: 2,
      overrideRevision: 3,
      legacy: false,
    }))
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: {} as never,
      consumer: { executionOperation } as never,
    })
    expect(
      await handler.handle({
        version: 1,
        token: handler.token,
        requestId: 'r',
        generation: 'g',
        action: 'continuation-live-policy',
        sessionId: 'chat',
      }),
    ).toMatchObject({ status: 'applied', continuationLivePolicy: { overrideRevision: 3, legacy: false } })
    expect(executionOperation).toHaveBeenCalledWith('continuation-live-policy', { sessionId: 'chat' })
  })
  it('projects the continuation defaults through the token-bound action seam', async () => {
    const executionOperation = vi.fn(async () => ({
      status: 'ok',
      revision: 2,
      policy: { enabled: true, thresholdRatio: 0.9 },
    }))
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: {} as never,
      consumer: { executionOperation } as never,
    })
    expect(
      await handler.handle({
        version: 1,
        token: handler.token,
        requestId: 'one',
        action: 'continuation-defaults',
        generation: 'g',
      }),
    ).toEqual({
      status: 'applied',
      continuationDefaults: { revision: 2, policy: { enabled: true, thresholdRatio: 0.9 } },
    })
    expect(executionOperation).toHaveBeenCalledWith('continuation-defaults', {})
  })
  it('exposes the actual task-settings handler and strips transport identity from strict task arguments', async () => {
    const call = vi.fn(async () => ({ status: 'ok', revision: 2 }))
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: {} as never,
      consumer: { taskSettings: { call } } as never,
    })
    expect(
      await handler.handle({
        version: 1,
        token: handler.token,
        requestId: 'one',
        action: 'task-settings',
        sessionId: 'chat',
        generation: 'generation',
      }),
    ).toEqual({ status: 'applied', task: { status: 'ok', revision: 2 } })
    expect(call).toHaveBeenCalledWith('task-settings', { sessionId: 'chat' })
  })
  it('forwards only token-bound connection and binding actions to the launcher API', async () => {
    const calls: unknown[] = []
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: {
        connections: {
          enable: async value => {
            calls.push(['enable', value])
            return { status: 'applied' as const }
          },
          disable: async value => {
            calls.push(['disable', value])
            return { status: 'applied' as const }
          },
          reconnect: async value => {
            calls.push(['reconnect', value])
            return { status: 'applied' as const }
          },
        },
        bindings: {
          archive: async value => {
            calls.push(['archive', value])
            return { status: 'applied' as const }
          },
          restore: async value => {
            calls.push(['restore', value])
            return { status: 'applied' as const }
          },
          unbind: async value => {
            calls.push(['unbind', value])
            return { status: 'applied' as const }
          },
        },
      } as never,
    })
    await expect(handler.handle({
      version: 1,
      token: handler.token,
      action: 'reconnect',
      ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    })).resolves.toMatchObject({ status: 'applied' })
    await expect(handler.handle({ version: 1, token: handler.token, action: 'archive', bindingId: 'binding-1' }))
      .resolves.toMatchObject({ status: 'applied' })
    expect(calls).toEqual([
      ['reconnect', { ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' } }],
      ['archive', { bindingId: 'binding-1' }],
    ])
    await expect(handler.handle({ version: 1, token: 'wrong', action: 'enable', ref: {} })).rejects.toThrow(
      'unauthorized',
    )
  })
})
