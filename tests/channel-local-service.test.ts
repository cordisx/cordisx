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
      adapterKind: 'simulator', connectionState: 'ready',
    })])
    const restarted = await service.restart({ ...SIMULATOR_CHANNEL_SERVICE_CONFIG, connections: [{
      ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!, enabled: false,
    }] })
    expect(restarted.generation).toMatch(/^channel-local-/)
    await restarted.finalize()
    expect(service.snapshot()?.accounts).toEqual([])
    await service.dispose()
  })
})
