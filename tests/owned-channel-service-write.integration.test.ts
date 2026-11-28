import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createConfiguredChannelOwner } from '../packages/cli/src/cli/configured-channel-owner.js'
import { channelConfigurationApi } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { SharedProfilePluginConfigFence } from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'commits an owner-verified Channel service update while its profile fence stays held',
  async () => {
    const root = await mkdtemp('/tmp/cx-owned-channel-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const profileId = 'default'
    const generation = 'fixture-owner'
    let service: ReturnType<typeof createLocalChannelService> | undefined
    let api: ReturnType<typeof channelConfigurationApi> | undefined
    let stagedDigest: `sha256:${string}` | undefined
    const fence = new SharedProfilePluginConfigFence(configPath, profileId)
    try {
      await mkdir(homeDir, { recursive: true, mode: 0o700 })
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{
            id: 'channel',
            entry: archive,
            services: {
              runtime: {
                profiles: {
                  [profileId]: {
                    revision: 0,
                    lastGoodRevision: 0,
                    config: SIMULATOR_CHANNEL_SERVICE_CONFIG,
                  },
                },
              },
            },
          }],
        }),
        { mode: 0o600 },
      )
      const plugin = (await loadConfig(configPath, { profileId, projectRoot: homeDir })).plugins[0]!
      stagedDigest = plugin.configuredArchiveDigest
      expect(plugin.source).toBeDefined()
      service = createLocalChannelService({
        artifactDirectory: path.dirname(plugin.entry),
        ...(plugin.configuredServiceEntry === undefined ? {} : { runtimeEntry: plugin.configuredServiceEntry }),
        dataDir: path.join(root, 'runtime'),
        source: plugin.source!,
        environment: {},
      })
      const priorGeneration = await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)
      const authority = createConfiguredChannelOwner({
        homeDir,
        configPath,
        profileId,
        plugin,
        service,
        ownerCurrent: () => true,
      })
      expect(authority).toBeDefined()
      api = channelConfigurationApi({
        token: 'a'.repeat(64),
        profileId,
        generation,
        configPath,
        plugin,
        service,
        persistence: authority!.persistence,
        expectedServiceGeneration: priorGeneration,
      })
      const descriptor = await api.descriptor()
      const candidate = structuredClone(descriptor.configuration) as { connections: Array<{ enabled: boolean }> }
      candidate.connections[0]!.enabled = false
      const release = await fence.acquire()
      const result = await fence.runServiceMutation({
        pluginId: 'channel',
        serviceId: 'runtime',
        isCurrent: () => true,
      }, async () =>
        await authority!.withOwner(async () =>
          await api!.mutate({
            contract: 'cordisx.service-config-mutation/v1',
            schemaVersion: 1,
            identity: descriptor.identity,
            scope: descriptor.scope,
            expectedRevision: descriptor.revision,
            configuration: candidate,
          })
        ))
      expect(result).toMatchObject({ status: 'applied', revision: 1 })
      expect(service.generation()).not.toBe(priorGeneration)
      const state = await readServiceConfigState({
        profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, configPath)
      expect(state).toMatchObject({ revision: 1, lastGoodRevision: 1, config: { connections: [{ enabled: false }] } })
      expect(
        await service.readManagementSnapshot({
          configuration: state.config,
          revision: state.revision,
          lastGoodRevision: state.lastGoodRevision,
        }),
      ).toBeDefined()
      await release()
    } finally {
      api?.dispose()
      await fence.close()
      await service?.dispose()
      if (stagedDigest) await removeStagedPluginPackage(homeDir, stagedDigest)
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
