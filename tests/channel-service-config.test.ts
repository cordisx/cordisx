import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  channelServiceInputV1,
  createChannelHostServiceConfigContract,
  parseChannelServiceConfig,
} from '../packages/channel-runtime/src/index.js'
import { ChannelCredentialDraftBroker } from '../packages/cli/src/launcher/channel-credential-drafts.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  type HostServiceConfigContract,
  type HostServiceConfigMutation,
  HostServiceConfigNarrowApi,
} from '../packages/cli/src/launcher/service-config.js'

describe('Channel Host service configuration contract', () => {
  it('persists and resolves a pending account through the real configuration CAS without changing an existing tenant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-pending-cas-'))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(config => ({
      ...config,
      plugins: [{ id: 'channel', entry: 'cordisx:channel', config: {} }],
    }), configPath)
    const existing = {
      ref: { adapterId: 'feishu', accountId: 'cli_existing', tenantId: 'tenant-existing' },
      adapterKind: 'feishu',
      enabled: false,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/EXISTING',
    }
    const contract = createChannelHostServiceConfigContract({
      source: 'file:///channel',
      pluginId: 'channel',
      serviceId: 'runtime',
    }, { contract: 'cordisx.channel-service-config/v2', schemaVersion: 2, connections: [existing] })
    const restart = vi.fn(async () => ({ generation: 'next', rollback: async () => {} }))
    const service = new HostServiceConfigNarrowApi({
      contract: contract as unknown as HostServiceConfigContract,
      profileId: 'test',
      generation: 'generation',
      ownerToken: 'a'.repeat(64),
      configPath,
      writable: true,
      authorize: () => true,
      restartService: restart,
      secretState: () => 'ready',
    })
    const values = new Map<string, string>()
    const backend = {
      read: async (service: string, account: string) => values.get(`${service}/${account}`)!,
      upsert: async (service: string, account: string, value: string) => {
        values.set(`${service}/${account}`, value)
      },
      remove: async (service: string, account: string) => {
        values.delete(`${service}/${account}`)
      },
      status: async () => 'set' as const,
    }
    const discoverTenant = vi.fn().mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
      .mockResolvedValueOnce('tenant-resolved')
    const broker = new ChannelCredentialDraftBroker({
      profileId: 'test',
      service,
      store: new LauncherSecretStore({ platform: 'darwin', backend }),
      validateCredentials: async () => {},
      discoverTenant,
    })
    try {
      await service.descriptor()
      const account = { adapterId: 'feishu', accountId: 'cli_pending', tenantId: '' }
      const capture = await broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'create',
        account,
        secret: 'fixture-secret',
      }, 'document')
      expect(capture.code).toBe('CAPTURED')
      expect(capture).toMatchObject({ status: 'applied' })
      const create = await broker.handle({
        operation: 'commit',
        owner: 'owner',
        draftId: capture.draftId,
        draft: { displayName: 'Pending', selectors: ['direct'] },
      }, 'document')
      expect(create.status).toBe('applied')
      const pending = await service.privateConfiguration()
      const parsed = parseChannelServiceConfig(pending.configuration)
      expect(parsed.schemaVersion).toBe(3)
      expect(channelServiceInputV1(parsed).connections).toEqual([existing])
      expect(JSON.stringify((await service.descriptor()).configuration)).not.toMatch(/fixture-secret|host-secret/)
      const result = await broker.handle({
        operation: 'resolve-tenant',
        owner: 'owner',
        account,
        expectedRevision: pending.revision,
      }, 'document')
      expect(result).toMatchObject({ status: 'applied', ref: { ...account, tenantId: 'tenant-resolved' } })
      const final = parseChannelServiceConfig((await service.privateConfiguration()).configuration)
      expect(final.schemaVersion).toBe(3)
      if (final.schemaVersion !== 3) throw new Error('Expected v3')
      expect(final.pendingConnections).toEqual([])
      expect(final.connections[0]).toEqual(existing)
      expect(final.connections[1]).toMatchObject({
        ref: { ...account, tenantId: 'tenant-resolved' },
        displayName: 'Pending',
      })
      expect(values.size).toBe(1)
      expect(restart).toHaveBeenCalledTimes(2)
    } finally {
      await broker.dispose()
      service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('keeps pending accounts separate from tenant runtime input and retains their opaque secret through CAS', () => {
    const input = {
      contract: 'cordisx.channel-service-config/v3',
      schemaVersion: 3,
      connections: [],
      pendingConnections: [{
        account: { adapterId: 'feishu', accountId: 'cli_test' },
        adapterKind: 'feishu',
        secretRef: 'host-secret:channel/test/draft-a',
        displayName: 'Pending',
      }],
    }
    const contract = createChannelHostServiceConfigContract({
      source: 'file:///channel',
      pluginId: 'channel',
      serviceId: 'runtime',
    })
    const parsed = parseChannelServiceConfig(input)
    expect(parsed.schemaVersion).toBe(3)
    const redacted = contract.project(parsed, () => 'ready')
    expect(JSON.stringify(redacted.configuration)).not.toContain('host-secret:')
    expect(redacted.secrets).toEqual([{ path: ['pendingConnections', '0', 'secretRef'], set: true }])
    expect(contract.normalizeMutation(redacted.configuration, parsed)).toEqual(parsed)
    expect(() =>
      parseChannelServiceConfig({
        ...input,
        pendingConnections: [input.pendingConnections[0], input.pendingConnections[0]],
      })
    )
      .toThrow('Duplicate')
    expect(() =>
      parseChannelServiceConfig({
        ...input,
        pendingConnections: [{
          ...input.pendingConnections[0],
          account: { ...input.pendingConnections[0]!.account, tenantId: 'fake' },
        }],
      })
    ).toThrow()
  })
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
      source: 'https://github.com/cordisx/plugin-channel',
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
        id:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json',
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
