import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as lark from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/index.js'
import {
  SimulatedChannelAdapter,
  SimulatedPermissionBroker,
  SIMULATOR_ADAPTER_IDENTITY,
  SIMULATOR_CHANNEL_SERVICE_CONFIG,
} from '../packages/channel-runtime/src/simulator.js'
import { createLocalChannelService, projectLocalChannelManager } from '../packages/cli/src/launcher/channel-service.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'

const temporary = new Set<string>()
const channelEntry = bundledPluginEntry('channel')
const channelArtifactDirectory = path.dirname(channelEntry)

afterEach(async () => {
  await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true })))
  temporary.clear()
})

describe('built-in local Channel service', () => {
  it('retains an authenticated pending account without registering it in the tenant runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-pending-channel-'))
    temporary.add(root)
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
    })
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v3',
        schemaVersion: 3,
        connections: SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
        pendingConnections: [{
          account: { adapterId: 'feishu', accountId: 'cli_pending' },
          adapterKind: 'feishu',
          secretRef: 'host-secret:channel/test/draft-a',
          displayName: 'Pending',
        }],
      })
      expect(service.snapshot()?.accounts).toEqual([expect.objectContaining({ adapterKind: 'simulator' })])
      expect(JSON.stringify(service.snapshot())).not.toContain('cli_pending')
    } finally {
      await service.dispose()
    }
  })
  it('starts and restart-fences the simulator without accepting an official adapter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-'))
    temporary.add(root)
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
    })
    await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    expect(service.snapshot()?.accounts).toEqual([expect.objectContaining({
      adapterKind: 'simulator',
      connectionState: 'ready',
    })])
    const restarted = await service.restart({
      ...SIMULATOR_CHANNEL_SERVICE_CONFIG,
      connections: [{
        ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!,
        enabled: false,
      }],
    })
    expect(restarted.generation).toMatch(/^channel-local-/)
    await restarted.finalize()
    expect(service.snapshot()?.accounts).toEqual([expect.objectContaining({
      adapterKind: 'simulator',
      connectionState: 'stopped',
    })])
    await service.dispose()
  })

  it('exposes launcher-private connection controls that rebuild the current service generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-actions-'))
    temporary.add(root)
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
    })
    const ref = SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!.ref
    const firstGeneration = await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)

    const disabled = await service.manager.connections.disable({ ref, generation: firstGeneration })
    expect(disabled.status).toBe('applied')
    expect(disabled.projection?.accounts).toEqual([expect.objectContaining({ ref, connectionState: 'stopped' })])

    const enabled = await service.manager.connections.enable({ ref, generation: disabled.generation })
    expect(enabled.status).toBe('applied')
    expect(enabled.projection?.accounts).toEqual([expect.objectContaining({
      ref,
      connectionState: 'ready',
    })])

    const reconnected = await service.manager.connections.reconnect({ ref, generation: enabled.generation })
    expect(reconnected.status).toBe('applied')
    await expect(service.manager.connections.reconnect({
      ref: { adapterId: 'simulator', accountId: 'missing', tenantId: 'test' },
      generation: reconnected.generation,
    })).resolves.toMatchObject({ status: 'not-found' })
    await expect(service.manager.connections.disable({ ref, generation: firstGeneration })).resolves.toMatchObject({
      status: 'unavailable',
    })
    await service.dispose()
  })

  it('restores the prior configuration when a service restart is rolled back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-rollback-'))
    temporary.add(root)
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
    })
    await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    const restarted = await service.restart({
      ...SIMULATOR_CHANNEL_SERVICE_CONFIG,
      connections: [{
        ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!,
        enabled: false,
      }],
    })
    expect(service.snapshot()?.accounts).toEqual([expect.objectContaining({
      adapterKind: 'simulator',
      connectionState: 'stopped',
    })])
    await restarted.rollback()
    expect(service.snapshot()?.accounts).toEqual([expect.objectContaining({
      adapterKind: 'simulator',
      connectionState: 'ready',
    })])
    await service.dispose()
  })

  it('keeps the launcher alive and projects an official account unavailable when its private secret is absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-feishu-'))
    temporary.add(root)
    const configuration = structuredClone(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    configuration.connections.push({
      ref: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant-test' },
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/CORDISX_MISSING_TEST_SECRET',
    })
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
      environment: {},
    })
    await service.start(configuration)
    expect(service.snapshot()?.accounts).toContainEqual(expect.objectContaining({
      adapterKind: 'feishu',
      connectionState: 'unavailable',
      secretState: 'missing',
    }))
    await service.dispose()
  })

  it('projects a failed official reconnect as unavailable after an interrupted owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-interrupted-'))
    temporary.add(root)
    const dataDir = path.join(root, 'runtime')
    const file = path.join(dataDir, 'transport.json')
    const ref = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant-test' }
    const configuration = structuredClone(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    configuration.connections.push({
      ref,
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/CORDISX_MISSING_TEST_SECRET',
    })

    const prior = await ChannelRuntime.open({ permissions: new SimulatedPermissionBroker(), storePath: file })
    const adapter = new SimulatedChannelAdapter({ ref })
    await prior.activate({
      descriptor: { ...adapter.descriptor, kind: 'feishu', secretState: 'ready' },
      start: adapter.start.bind(adapter),
    }, SIMULATOR_ADAPTER_IDENTITY)
    const interruptedStore = await readFile(file)
    await prior.dispose()
    await writeFile(file, interruptedStore)

    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir,
      source: pathToFileURL(channelEntry).href,
      environment: {},
    })
    try {
      await service.start(configuration)
      const snapshot = service.snapshot()
      expect(snapshot?.accounts).toContainEqual(expect.objectContaining({
        ref,
        connectionState: 'unavailable',
        secretState: 'missing',
      }))
      expect(service.manager.snapshot()?.accounts).toContainEqual(expect.objectContaining({
        ref,
        connectionState: 'unavailable',
      }))
      expect(
        projectLocalChannelManager({
          configuration,
          revision: 1,
          lastGoodRevision: 1,
          writable: false,
          runtime: snapshot,
        }).accounts,
      ).toContainEqual(expect.objectContaining({ ref, connectionState: 'unavailable' }))
    } finally {
      await service.dispose()
    }
  })

  it('projects the current official transport state as it disconnects and recovers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-health-'))
    temporary.add(root)
    const ref = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant-test' }
    const configuration = structuredClone(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    configuration.connections.push({
      ref,
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/CORDISX_TEST_SECRET',
    })
    let transportState: string | undefined = 'connected'
    let statusFails = false
    const createSdk = vi.spyOn(lark, 'createLarkChannel').mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      on: () => () => {},
      send: async () => ({ messageId: 'fixture' }),
      getConnectionStatus: () => {
        if (statusFails) throw new Error('fixture-status-failed')
        return transportState === undefined ? undefined : { state: transportState, reconnectAttempts: 0 }
      },
    } as never)
    const service = createLocalChannelService({
      artifactDirectory: channelArtifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(channelEntry).href,
      environment: { CORDISX_TEST_SECRET: 'fixture-only' },
    })
    const expectState = async (expected: string) => {
      const view = await service.readManagementSnapshot({ configuration, revision: 1, lastGoodRevision: 1 })
      expect(view?.runtime.accounts).toContainEqual(expect.objectContaining({ ref, connectionState: expected }))
      expect(view?.projection.accounts).toContainEqual(expect.objectContaining({ ref, connectionState: expected }))
    }
    try {
      const generation = await service.start(configuration)
      await expectState('ready')
      transportState = 'reconnecting'
      await expectState('retrying')
      transportState = 'connecting'
      await expectState('retrying')
      transportState = 'failed'
      await expectState('unavailable')
      transportState = 'idle'
      await expectState('unavailable')
      transportState = undefined
      await expectState('unavailable')
      transportState = 'unexpected'
      await expectState('unavailable')
      statusFails = true
      await expectState('unavailable')
      statusFails = false
      transportState = 'connected'
      await expectState('ready')
      expect(createSdk).toHaveBeenCalledOnce()
      await expect(service.manager.connections.disable({ ref, generation })).resolves.toMatchObject({
        status: 'applied',
      })
      expect(service.snapshot()?.accounts).toContainEqual(expect.objectContaining({ ref, connectionState: 'disabled' }))
    } finally {
      await service.dispose()
      createSdk.mockRestore()
    }
  })
})
