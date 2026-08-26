import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  createChannelHostServiceConfigContract,
  parseChannelServiceConfig,
} from '../packages/channel-runtime/src/index.js'
import {
  ensureHomeConfig,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import {
  HostServiceConfigNarrowApi,
  type HostServiceConfigContract,
  type HostServiceConfigMutation,
} from '../packages/cli/src/launcher/service-config.js'

describe('Channel Host service configuration contract', () => {
  it('uses service-restart CAS, preserves Host secret refs, and projects no renderer credential', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-service-config-'))
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(config => ({
      ...config,
      plugins: [{ id: 'channel', entry: 'cordisx:channel', config: {} }],
    }), configPath)

    const initial = parseChannelServiceConfig({
      ...CHANNEL_SERVICE_CONFIG_INITIAL,
      connections: [{
        ref: { adapterId: 'feishu', accountId: 'app-a', tenantId: 'tenant-a' },
        adapterKind: 'feishu',
        enabled: false,
        transport: { mode: 'websocket' },
        secretRef: 'host-secret:env/FEISHU_APP_SECRET',
      }],
    })
    const contract = createChannelHostServiceConfigContract({
      source: 'https://github.com/cordisx/cordisx/tree/main/packages/cli/src/plugins/channel',
      pluginId: 'channel',
      serviceId: 'runtime',
    }, initial) as unknown as HostServiceConfigContract
    const restart = vi.fn(async (candidate: unknown) => ({
      generation: 'channel-runtime-2',
      rollback: async () => undefined,
      candidate,
    }))
    const api = new HostServiceConfigNarrowApi({
      contract,
      profileId: 'default',
      generation: 'channel-runtime-1',
      ownerToken: 'a'.repeat(64),
      configPath,
      writable: true,
      authorize: () => true,
      secretState: secretRef => secretRef === undefined ? 'missing' : 'ready',
      restartService: restart,
    })

    const descriptor = await api.descriptor()
    expect(descriptor).toMatchObject({
      identity: { pluginId: 'channel', serviceId: 'runtime' },
      schema: {
        id: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json',
        projection: { kind: 'schemastery' },
      },
      configApplies: 'service-restart',
      revision: 0,
      lastGoodRevision: 0,
      writable: true,
      secrets: [{ path: ['connections', '0', 'secretRef'], set: true }],
    })
    expect(JSON.stringify(descriptor.configuration)).not.toContain('secretRef')
    expect(JSON.stringify(descriptor)).not.toContain('host-secret:env/FEISHU_APP_SECRET')

    const configuration = structuredClone(descriptor.configuration) as Record<string, unknown>
    const connections = configuration.connections as Array<Record<string, unknown>>
    connections[0] = { ...connections[0], enabled: true }
    const request: HostServiceConfigMutation = {
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: contract.identity,
      scope: { profileId: 'default', generation: 'channel-runtime-1' },
      expectedRevision: 0,
      configuration,
    }
    expect(await api.mutate(request)).toMatchObject({
      status: 'applied',
      revision: 1,
      configApplies: 'service-restart',
      serviceGeneration: 'channel-runtime-2',
    })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(restart.mock.calls[0]?.[0])).toContain('host-secret:env/FEISHU_APP_SECRET')
    const updated = await api.descriptor()
    expect(updated).toMatchObject({ revision: 1, lastGoodRevision: 1, secrets: [{ set: true }] })
    expect(JSON.stringify(updated.configuration)).not.toContain('secretRef')
    expect(JSON.stringify(updated)).not.toContain('host-secret:env/FEISHU_APP_SECRET')
    api.dispose()
  })
})
