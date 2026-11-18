import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelManagerV5 } from '@cordisx/protocol/channel-manager/v5'
import type { ChannelManagerV10 } from '@cordisx/protocol/channel-manager/v10'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import {
  createChannelLaunchBridges,
  createRendererChannelComposition,
} from '../packages/cli/src/cli/renderer-channel-composition.js'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import type { HostServiceConfigNarrowApi } from '../packages/cli/src/launcher/service-config.js'
import type { ChannelCredentialBridgeHandler } from '../packages/cli/src/launcher/channel-credential-rpc.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import { CordisXChannelManagerService } from '../packages/cli/src/renderer/channel-manager.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

describe('actual direct Channel service ownership assembly', () => {
  it(
    'carries the started service through bundle metadata to the public management control with no user grant',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'channel-service-owner-composition-'))
      const configPath = path.join(root, 'config.json')
      const entry = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE ?? bundledPluginEntry('channel')
      let channel: Awaited<ReturnType<typeof createRendererChannelComposition>> | undefined
      let broker: PermissionBroker | undefined, fiber: ReturnType<Context['plugin']> | undefined
      let configApi: HostServiceConfigNarrowApi | undefined, credentials: ChannelCredentialBridgeHandler | undefined
      try {
        await writeFile(
          configPath,
          JSON.stringify({
            ...createDefaultHomeConfig(),
            apps: {
              codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } },
            },
            plugins: [{
              id: 'channel',
              entry,
              services: {
                runtime: {
                  profiles: {
                    test: { revision: 0, lastGoodRevision: 0, config: SIMULATOR_CHANNEL_SERVICE_CONFIG },
                  },
                },
              },
            }],
          }),
        )
        const config = await loadConfig(configPath)
        channel = await createRendererChannelComposition({
          composition: config,
          configPath,
          profileId: 'test',
          appId: 'codex',
          homeDir: root,
          environment: {},
        })
        expect(channel.serviceCapabilityOwners).toHaveLength(1)
        const activeOwner = channel.serviceCapabilityOwners![0]!
        const bundle = await buildRendererCompositionSource(config, {
          profileId: 'test',
          generation: 'runtime-owner',
          serviceCapabilityOwners: channel.serviceCapabilityOwners!,
          channelManager: channel.manager!,
          channelActionsBridgeToken: channel.actionsBridgeToken!,
        })
        // Read data emitted by the production assembly, without manufacturing ownership.
        const metadata = Function(`return (${bundle.metadataSource})`)()
        expect(metadata.channelActionsBridgeToken).toBe(channel.actionsBridgeToken)
        const plugin = Function(`return (${bundle.pluginsSource})`)()[0]
        const manifest = normalizePluginManifest(plugin.manifest, plugin.id)
        expect(metadata.serviceCapabilityOwners[0]).toMatchObject({
          source: plugin.source,
          moduleGeneration: plugin.package?.moduleGeneration ?? plugin.artifactGeneration,
          runtimeGeneration: 'runtime-owner',
          serviceGeneration: activeOwner.serviceGeneration,
        })
        expect(bundle.watchFiles).toContain(/\.(?:tgz|tar\.gz)$/u.test(entry) ? entry : path.resolve(path.dirname(entry), '../runtime-manifest.json'))
        const store = new MemoryPermissionPolicyStore(), prompt = vi.fn(async () => undefined)
        broker = new PermissionBroker(
          store,
          { request: prompt },
          () => new Date(),
          100,
          'test',
          'runtime-owner',
          undefined,
          undefined,
          { request: prompt },
          metadata.serviceCapabilityOwners,
        )
        const retire = broker.register({ id: plugin.id, source: plugin.source }, manifest, {
          pluginId: plugin.id,
          moduleGeneration: plugin.package?.moduleGeneration ?? plugin.artifactGeneration,
        })
        const ctx = new Context()
        const bridges = createChannelLaunchBridges({
          channel,
          token: 'a'.repeat(64),
          profileId: 'test',
          generation: 'runtime-owner',
          configPath,
          consumer: undefined,
        })
        configApi = bridges.configApi
        credentials = bridges.credentials
        const actions = bridges.actions!
        fiber = ctx.plugin(CordisXChannelManagerService, {
          projection: channel.manager!,
          profileId: 'test',
          hostGeneration: 'runtime-owner',
          broker,
          actions: {
            run: async (action, input) => actions.handle({ version: 1, token: actions.token, action, ...input }),
          },
        })
        await fiber
        const caller = ctx.extend({
          [CORDISX_PLUGIN_ID]: plugin.id,
          [CORDISX_PLUGIN_SOURCE]: plugin.source,
          [CORDISX_PLUGIN_GENERATION]: plugin.package?.moduleGeneration ?? plugin.artifactGeneration,
        })
        const manager = (caller.channelManager as ChannelManagerV10).forOwnConversationService()!
        const snapshot = manager.snapshot(), account = snapshot.accounts[0]!
        const signal = new AbortController().signal
        await expect(manager.conversationPage({ connectionToken: account.connectionToken }, signal)).resolves
          .toMatchObject({
            contract: 'cordisx.channel-manager-conversation-page/v1',
            conversations: [],
            total: 0,
          })
        const ref = SIMULATOR_CHANNEL_SERVICE_CONFIG.connections[0]!.ref
        expect(account.availableOperations).toContain('connection.disable')
        await expect(manager.execute({
          contract: 'cordisx.channel-manager-request/v2',
          schemaVersion: 2,
          requestId: 'disable-own-simulator',
          profileId: snapshot.profileId,
          hostGeneration: snapshot.hostGeneration,
          expectedRevision: snapshot.revision,
          operation: 'connection.disable',
          target: { kind: 'connection', connectionToken: account.connectionToken },
        })).resolves.toMatchObject({ status: 'applied' })
        expect(manager.snapshot().accounts[0]!.connectionState).toBe('stopped')
        // The production button must persist its preference before a later config save can restart the service.
        const readStored = () =>
          readServiceConfigState({
            profileId: 'test',
            pluginId: 'channel',
            serviceId: 'runtime',
            initialConfig: SIMULATOR_CHANNEL_SERVICE_CONFIG as never,
          }, configPath)
        expect(await readStored()).toMatchObject({
          revision: 1,
          lastGoodRevision: 1,
          config: { connections: [expect.objectContaining({ enabled: false })] },
        })
        const descriptor = await configApi!.descriptor()
        const secondRef = { adapterId: 'feishu', accountId: 'cli_second_fixture', tenantId: 'test' }
        const withSecond = await configApi!.mutate({
          contract: 'cordisx.service-config-mutation/v1',
          schemaVersion: 1,
          identity: descriptor.identity,
          scope: descriptor.scope,
          expectedRevision: descriptor.revision,
          configuration: {
            ...descriptor.configuration as object,
            connections: [
              ...(descriptor.configuration as { connections: [] }).connections,
              {
                ref: secondRef,
                adapterKind: 'feishu',
                enabled: false,
                transport: { mode: 'websocket' },
                secretRef: 'host-secret:env/CHANNEL_SECOND_FIXTURE',
              },
            ],
          },
        })
        expect(withSecond.status).toBe('applied')
        expect(channel.service!.manager.snapshot()!.accounts).toEqual([
          expect.objectContaining({ ref, connectionState: 'stopped' }),
        ])
        expect(await readStored()).toMatchObject({
          revision: 2,
          config: { connections: [expect.objectContaining({ enabled: false }), expect.anything()] },
        })
        const enabled = await actions.handle({
          version: 1,
          token: actions.token,
          action: 'enable',
          ref,
          generation: channel.service!.generation(),
        })
        expect(enabled).toMatchObject({ status: 'applied' })
        expect(await readStored()).toMatchObject({
          revision: 3,
          config: { connections: [expect.objectContaining({ enabled: true }), expect.anything()] },
        })
        expect(channel.service!.manager.snapshot()!.accounts[0]!.connectionState).toBe('ready')
        await expect(actions.handle({
          version: 1,
          token: actions.token,
          action: 'disable',
          ref,
          generation: 'stale-service-generation',
        })).resolves.toMatchObject({ status: 'unavailable', code: 'STALE_GENERATION' })
        expect((await readStored()).revision).toBe(3)
        // Reconnect must not create a configuration revision.
        await expect(actions.handle({
          version: 1,
          token: actions.token,
          action: 'reconnect',
          ref,
        })).resolves.toMatchObject({ status: 'applied' })
        expect((await readStored()).revision).toBe(3)
        const restart = channel.service!.restart.bind(channel.service)
        const restartSpy = vi.spyOn(channel.service!, 'restart')
        try {
          restartSpy.mockRejectedValueOnce(new Error('fixture restart failed'))
          await expect(actions.handle({
            version: 1,
            token: actions.token,
            action: 'disable',
            ref,
          })).resolves.toMatchObject({ status: 'unavailable', code: 'SERVICE_RESTART_FAILED' })
          const failedRestartState = await readStored()
          expect(failedRestartState.revision).toBe(3)
          expect(failedRestartState.candidate).toBeUndefined()
          expect(channel.service!.manager.snapshot()!.accounts[0]!.connectionState).toBe('ready')
          // A reconnect between descriptor read and the owning restart must not bypass the generation fence.
          restartSpy.mockImplementationOnce(async (candidate, expectedGeneration) => {
            await channel.service!.manager.connections.reconnect({ ref })
            return restart(candidate, expectedGeneration)
          })
          await expect(actions.handle({
            version: 1,
            token: actions.token,
            action: 'disable',
            ref,
          })).resolves.toMatchObject({ status: 'unavailable', code: 'STALE_GENERATION' })
          const staleRestartState = await readStored()
          expect(staleRestartState.revision).toBe(3)
          expect(staleRestartState.candidate).toBeUndefined()
          expect(channel.service!.manager.snapshot()!.accounts[0]!.connectionState).toBe('ready')
        } finally {
          restartSpy.mockRestore()
        }
        expect(channel.service!.managementOwner()!.serviceGeneration).toBe(activeOwner.serviceGeneration)
        expect(prompt).not.toHaveBeenCalled()
        expect(store.records).toHaveLength(0)
        retire()
        expect(() => manager.snapshot()).toThrow('PERMISSION_DENIED')
      } finally {
        await fiber?.dispose()
        broker?.dispose()
        await credentials?.dispose?.()
        configApi?.dispose()
        await channel?.service?.dispose()
        expect(channel?.service?.managementOwner()).toBeUndefined()
        async function writable(directory: string): Promise<void> {
          await chmod(directory, 0o700)
          for (const file of await readdir(directory, { withFileTypes: true })) {
            if (file.isDirectory()) await writable(path.join(directory, file.name))
          }
        }
        await writable(root)
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
