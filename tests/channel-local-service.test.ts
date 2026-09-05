import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true })))
  temporary.clear()
})

describe('built-in local Channel service', () => {
  it('starts and restart-fences the simulator without accepting an official adapter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-'))
    temporary.add(root)
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const artifactDirectory = path.join(repo, 'packages/cli/src/plugins/channel')
    const service = createLocalChannelService({
      artifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(path.join(artifactDirectory, 'index.ts')).href,
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
    expect(service.snapshot()?.accounts).toEqual([])
    await service.dispose()
  })

  it('exposes launcher-private connection controls that rebuild the current service generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-channel-actions-'))
    temporary.add(root)
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const artifactDirectory = path.join(repo, 'packages/cli/src/plugins/channel')
    const service = createLocalChannelService({
      artifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(path.join(artifactDirectory, 'index.ts')).href,
    })
    const ref = SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!.ref
    const firstGeneration = await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)

    const disabled = await service.manager.connections.disable({ ref, generation: firstGeneration })
    expect(disabled.status).toBe('applied')
    expect(disabled.projection?.accounts).toEqual([])

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
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const artifactDirectory = path.join(repo, 'packages/cli/src/plugins/channel')
    const service = createLocalChannelService({
      artifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(path.join(artifactDirectory, 'index.ts')).href,
    })
    await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    const restarted = await service.restart({
      ...SIMULATOR_CHANNEL_SERVICE_CONFIG,
      connections: [{
        ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!,
        enabled: false,
      }],
    })
    expect(service.snapshot()?.accounts).toEqual([])
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
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const artifactDirectory = path.join(repo, 'packages/cli/src/plugins/channel')
    const configuration = structuredClone(SIMULATOR_CHANNEL_SERVICE_CONFIG)
    configuration.connections.push({
      ref: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant-test' },
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: 'host-secret:env/CORDISX_MISSING_TEST_SECRET',
    })
    const service = createLocalChannelService({
      artifactDirectory,
      dataDir: path.join(root, 'runtime'),
      source: pathToFileURL(path.join(artifactDirectory, 'index.ts')).href,
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
})
