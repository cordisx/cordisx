import { describe, expect, it, vi } from 'vitest'
import { configuredLaunchCleanup } from '../packages/cli/src/cli/channel-consumer-composition.js'

describe('configured Channel launch cleanup', () => {
  it('attempts all owned cleanups once even when credential cleanup fails', async () => {
    const order: string[] = []
    const dispose = configuredLaunchCleanup({
      documents: {
        walletSpend: {
          dispose: () => {
            order.push('wallet')
          },
        },
        http: {
          dispose: async () => {
            order.push('http')
          },
        },
        agentTools: {
          close: async () => {
            order.push('tools')
          },
        },
      } as never,
      credentials: {
        token: 'test',
        handle: vi.fn(),
        dispose: async () => {
          order.push('credentials')
          throw new Error('cleanup')
        },
      },
      channel: async () => {
        order.push('channel')
      },
      providers: async () => {
        order.push('providers')
      },
    })
    await expect(dispose()).rejects.toThrow('Configured launch cleanup failed')
    await expect(dispose()).rejects.toThrow('Configured launch cleanup failed')
    expect(order).toEqual(['wallet', 'http', 'tools', 'credentials', 'channel', 'providers'])
  })
})
