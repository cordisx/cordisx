import { describe, expect, it, vi } from 'vitest'
import { withNativeManagedConnections } from '../packages/cli/src/launcher/native-managed-connections.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'

function connection(providerId: string) {
  return {
    service: { pluginId: `${providerId}-plugin`, serviceId: 'gateway', generation: 'one' },
    endpoint: { origin: 'http://127.0.0.1:43127', apiPath: '/v1' as const, auth: { scheme: 'none' as const } },
    models: {
      generation: 'catalog-one',
      defaultAlias: 'shared',
      aliases: [{ alias: 'shared', gatewayModelId: `${providerId}-model` }],
    },
    cleanup: { authorityId: `${providerId}-authority` },
  }
}

describe('native managed launcher connection cleanup', () => {
  it('disposes earlier sessions when a later provider preparation fails', async () => {
    const firstDispose = vi.fn()
    const run = vi.fn()
    const activation = {
      nativeProviderIds: ['first', 'broken', 'later'],
      prepareNativeConnection(providerId: string) {
        if (providerId === 'broken') throw new Error('preparation failed')
        return { value: connection(providerId), dispose: providerId === 'first' ? firstDispose : vi.fn() }
      },
    } as Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>

    await expect(withNativeManagedConnections(activation, run)).rejects.toThrow('preparation failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it('disposes every prepared session when Desktop preparation fails', async () => {
    const disposals = new Map(['first', 'second'].map(providerId => [providerId, vi.fn()]))
    const activation = {
      nativeProviderIds: [...disposals.keys()],
      prepareNativeConnection(providerId: string) {
        return { value: connection(providerId), dispose: disposals.get(providerId)! }
      },
    } as Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>

    await expect(withNativeManagedConnections(activation, async connections => {
      expect(connections.map(item => item.providerId)).toEqual(['first', 'second'])
      throw new Error('Desktop preparation failed')
    })).rejects.toThrow('Desktop preparation failed')
    expect([...disposals.values()].every(dispose => dispose.mock.calls.length === 1)).toBe(true)
  })
})
