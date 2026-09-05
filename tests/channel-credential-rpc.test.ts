import { describe, expect, it } from 'vitest'
import { createChannelCredentialBridgeHandler } from '../packages/cli/src/launcher/channel-credential-rpc.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'

describe('Channel credential Host bridge', () => {
  it('captures a Feishu secret privately and never returns its reference to the renderer', async () => {
    const values = new Map<string, string>()
    const store = new LauncherSecretStore({
      platform: 'darwin',
      backend: {
        read: async () => '',
        upsert: async (service, account, value) => {
          values.set(`${service}/${account}`, value)
        },
        remove: async () => {},
        status: async () => 'unset',
      },
    })
    let received: unknown
    const handler = createChannelCredentialBridgeHandler({
      token: 'c'.repeat(64),
      profileId: 'work',
      store,
      service: {
        mutate: async mutation => {
          received = mutation.configuration
          return {
            contract: 'cordisx.service-config-result/v1',
            schemaVersion: 1,
            identity: mutation.identity,
            scope: mutation.scope,
            revision: 5,
            status: 'applied',
            configApplies: 'service-restart',
            serviceGeneration: 'next',
          }
        },
      } as never,
    })
    const mutation = {
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation: 'test' },
      expectedRevision: 4,
      configuration: {
        connections: [{
          ref: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant' },
          adapterKind: 'feishu',
          enabled: false,
          transport: { mode: 'websocket' },
        }],
      },
    } as const
    const result = await handler.handle({
      version: 1,
      token: handler.token,
      requestId: 'capture-1',
      account: mutation.configuration.connections[0]!.ref,
      secret: 'test-only-secret',
      mutation,
    })
    expect(result.status).toBe('applied')
    expect(JSON.stringify(result)).not.toMatch(/keychain:|test-only-secret/)
    expect(JSON.stringify(received)).toContain('keychain:cordisx/channel/work/')
    expect([...values.values()]).toEqual(['test-only-secret'])
  })
})
