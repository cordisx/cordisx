import { Context } from '@deepseek-ai/cordis'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as lark from '@larksuiteoapi/node-sdk'
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

async function removeFixtureRoot(root: string): Promise<void> {
  const writable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700)
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isDirectory()) await writable(path.join(directory, file.name))
    }
  }
  await writable(root)
  await rm(root, { recursive: true, force: true })
}

describe('actual direct Channel service ownership assembly', () => {
  it('persists lifecycle-installed Channel configuration without a legacy configured plugin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-package-service-config-'))
    const artifact = path.join(root, 'artifact')
    const configPath = path.join(root, 'config.json')
    const entry = path.join(artifact, 'module.js')
    const composition = {
      plugins: [{
        id: 'channel',
        enabled: true,
        entry,
        source: 'https://github.com/cordisx/plugin-channel',
        package: { version: '0.1.7', digest: 'sha256:fixture', moduleGeneration: 'fixture', dependencies: [] },
      }],
    } as never
    let channel: Awaited<ReturnType<typeof createRendererChannelComposition>> | undefined
    let configApi: HostServiceConfigNarrowApi | undefined
    try {
      await mkdir(path.join(artifact, 'services'), { recursive: true })
      await copyFile(
        path.join(path.dirname(bundledPluginEntry('channel')), 'service.mjs'),
        path.join(artifact, 'services/runtime.mjs'),
      )
      channel = await createRendererChannelComposition({
        composition,
        configPath,
        profileId: 'test',
        appId: 'codex',
        homeDir: root,
        generation: 'runtime-owner',
        environment: {},
      })
      configApi = createChannelLaunchBridges({
        channel,
        token: 'a'.repeat(64),
        profileId: 'test',
        generation: 'runtime-owner',
        configPath,
        consumer: undefined,
      }).configApi
      const descriptor = await configApi!.descriptor()
      expect(descriptor.revision).toBe(0)
      const result = await configApi!.mutate({
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: 0,
        configuration: SIMULATOR_CHANNEL_SERVICE_CONFIG,
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied', revision: 1 })
      configApi!.dispose()
      await channel.service!.dispose()
      channel = await createRendererChannelComposition({
        composition,
        configPath,
        profileId: 'test',
        appId: 'codex',
        homeDir: root,
        generation: 'runtime-next',
        environment: {},
      })
      configApi = createChannelLaunchBridges({
        channel,
        token: 'b'.repeat(64),
        profileId: 'test',
        generation: 'runtime-next',
        configPath,
        consumer: undefined,
      }).configApi
      expect(await configApi!.descriptor()).toMatchObject({ revision: 1, lastGoodRevision: 1 })
    } finally {
      configApi?.dispose()
      await channel?.service?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('assembles a pending connection and resolves its identity through the production credential bridge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-pending-composition-'))
    const configPath = path.join(root, 'config.json')
    const entry = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE ?? bundledPluginEntry('channel')
    const account = { adapterId: 'feishu', accountId: 'cli_pending_fixture' }
    const pending = {
      account,
      adapterKind: 'feishu',
      secretRef: 'host-secret:env/MISSING_PENDING_FIXTURE',
      displayName: 'Pending',
      selectors: ['direct'],
    }
    let channel: Awaited<ReturnType<typeof createRendererChannelComposition>> | undefined
    let bridges: ReturnType<typeof createChannelLaunchBridges> | undefined
    let onMessage: ((message: lark.NormalizedMessage) => Promise<void>) | undefined
    const createSdk = vi.spyOn(lark, 'createLarkChannel').mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      on: (event: string, listener: typeof onMessage) => {
        if (event === 'message') onMessage = listener
        return () => {}
      },
      send: async () => ({ messageId: 'fixture' }),
    } as never)
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
          plugins: [{
            id: 'channel',
            entry,
            services: {
              runtime: {
                profiles: {
                  test: {
                    revision: 1,
                    lastGoodRevision: 1,
                    config: {
                      contract: 'cordisx.channel-service-config/v3',
                      schemaVersion: 3,
                      connections: [],
                      pendingConnections: [pending],
                    },
                  },
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
        generation: 'runtime-owner',
        environment: { MISSING_PENDING_FIXTURE: 'fixture-secret' },
      })
      expect(channel.service!.snapshot()!.accounts).toEqual([])
      const received: Array<{ tenantId: string; actorTenantId?: string; persisted: boolean }> = []
      const stopObserving = channel.service!.observeInputs(async (_id, input, _mentioned, persisted) => {
        received.push({
          tenantId: input.source.event.tenantId,
          actorTenantId: input.source.event.actor?.tenantId,
          persisted,
        })
      })
      expect(channel.manager!.accounts[0]).toMatchObject({ pendingTenant: true, ref: { ...account, tenantId: '' } })
      bridges = createChannelLaunchBridges({
        channel,
        token: 'a'.repeat(64),
        profileId: 'test',
        generation: 'runtime-owner',
        configPath,
        consumer: undefined,
      })
      const mutation = vi.spyOn(bridges.configApi!, 'mutate')
      const result = await bridges.credentials!.handle({
        version: 2,
        token: bridges.credentials!.token,
        requestId: 'resolve-pending',
        operation: 'resolve-tenant',
        owner: 'test-owner',
        account: { ...account, tenantId: '' },
        tenantId: 'tenant-real',
        expectedRevision: 1,
      }, 'document')
      const mutationResult = await mutation.mock.results[0]!.value
      expect(
        mutationResult.status === 'applied' || mutationResult.status === 'staged'
          ? ''
          : JSON.stringify(mutationResult.error),
      ).toBe('')
      expect(result).toMatchObject({ status: 'applied', code: 'APPLIED', ref: { ...account, tenantId: 'tenant-real' } })
      expect(JSON.stringify(result)).not.toMatch(/host-secret|MISSING_PENDING_FIXTURE/)
      const persisted = await readServiceConfigState({
        profileId: 'test',
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: SIMULATOR_CHANNEL_SERVICE_CONFIG as never,
      }, configPath)
      expect(persisted.config).toMatchObject({
        pendingConnections: [],
        connections: [{
          ref: { ...account, tenantId: 'tenant-real' },
          secretRef: pending.secretRef,
        }],
      })
      expect(channel.service!.snapshot()!.accounts).toContainEqual(expect.objectContaining({
        ref: { ...account, tenantId: 'tenant-real' },
        connectionState: 'ready',
      }))
      expect(onMessage).toBeDefined()
      await onMessage!({
        messageId: 'om_fixture',
        chatId: 'oc_fixture',
        chatType: 'p2p',
        senderId: 'ou_fixture',
        content: 'fixture',
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
        raw: { sender: { tenant_key: 'external-tenant' } },
      })
      expect(received).toContainEqual({ tenantId: 'tenant-real', actorTenantId: 'tenant-real', persisted: true })
      stopObserving()
    } finally {
      await bridges?.credentials?.dispose?.()
      bridges?.configApi?.dispose()
      await channel?.service?.dispose()
      createSdk.mockRestore()
      await removeFixtureRoot(root)
    }
  })
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
          generation: 'runtime-owner',
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
        expect(bundle.watchFiles).toContain(
          /\.(?:tgz|tar\.gz)$/u.test(entry) ? entry : path.resolve(path.dirname(entry), '../runtime-manifest.json'),
        )
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
        await removeFixtureRoot(root)
      }
    },
    60_000,
  )
})
