import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ChannelManagerV5 } from '@cordisx/protocol/channel-manager/v5'
import { describe, expect, it, vi } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { openReadonlyHeadlessChannel } from '../packages/cli/src/cli/readonly-headless-channel.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { CordisXChannelManagerPresentationService } from '../packages/cli/src/renderer/channel-manager-presentation.js'
import { restrictChannelManagerActions } from '../packages/cli/src/renderer/channel-manager-actions.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { ownerSnapshotPermissionStore } from '../packages/cli/src/renderer/platform/owner-snapshot-permission-store.js'
import { PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-readonly-channel-'))
  const entry = bundledPluginEntry('channel')
  const configPath = path.join(root, 'config.json')
  const configuration = {
    contract: 'cordisx.channel-service-config/v3',
    schemaVersion: 3,
    connections: SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
    pendingConnections: [{
      account: { adapterId: 'feishu', accountId: 'cli_pending' },
      adapterKind: 'feishu',
      secretRef: 'host-secret:channel/fixture-private-reference',
      displayName: 'Pending',
    }],
  }
  const home = {
    ...createDefaultHomeConfig(),
    apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
    plugins: [{
      id: 'channel',
      entry,
      services: { runtime: { profiles: { test: { revision: 1, lastGoodRevision: 1, config: configuration } } } },
    }],
  }
  await writeFile(configPath, JSON.stringify(home))
  const config = await loadConfig(configPath, { profileId: 'test', projectRoot: root })
  const plugin = config.plugins.find(item => item.id === 'channel')!
  const service = createLocalChannelService({
    artifactDirectory: path.dirname(plugin.entry),
    dataDir: path.join(root, 'runtime'),
    source: plugin.source ?? pathToFileURL(plugin.entry).href,
    environment: {},
  })
  await service.start(configuration)
  const controller = new AbortController()
  const retire = vi.fn(() => controller.abort())
  const current = vi.fn(() => !controller.signal.aborted)
  const input = {
    profileId: 'test',
    configPath,
    plugin,
    service,
    fence: { signal: controller.signal, current, retire },
  }
  return {
    input,
    service,
    controller,
    configuration,
    retire,
    current,
    async dispose() {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('read-only independent manager for an existing configured Channel', () => {
  it('keeps the read-only descriptor even when its snapshot bridge is unavailable', () => {
    const ref = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
    const connection = {
      ref,
      adapterKind: 'simulator',
      enabled: true,
      transportMode: 'simulator',
      secretState: 'ready',
    }
    const manager = new CordisXChannelManagerPresentationService(new Context(), {
      presentationMode: 'snapshot-only',
      projection: {
        contract: 'cordisx.channel-manager-projection/v1',
        schemaVersion: 1,
        status: 'verified',
        observedAt: '2025-01-01T00:00:00.000Z',
        service: {
          configurationKind: 'host',
          configApplies: 'service-restart',
          revision: 1,
          lastGoodRevision: 1,
          writable: false,
        },
        connections: [connection],
        routes: [],
        bindings: [],
        diagnostics: [],
        accounts: [{
          ...connection,
          implementationStatus: 'verified',
          connectionState: 'ready',
          generation: 1,
          inbound: { pending: 0, retrying: 0, deadLetter: 0 },
          outbound: { pending: 0, retrying: 0, deadLetter: 0 },
        }],
      },
    })
    expect(manager.presentationCapabilities().mode).toBe('snapshot-only')
    expect(manager.snapshot().accounts[0]?.connectionState).toBe('unavailable')
    expect(manager.snapshot().observedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('reads real account state through the existing service and exposes no secret or write authority', async () => {
    const f = await fixture()
    let broker: PermissionBroker | undefined
    let fiber: ReturnType<Context['plugin']> | undefined
    try {
      const view = await openReadonlyHeadlessChannel(f.input)
      expect(view).toBeDefined()
      const initial = view!.initial
      expect(initial.owner.capabilities).toEqual([{ name: 'channel.accounts.read', scope: {} }])
      expect(initial.projection.service.writable).toBe(false)
      expect(initial.projection.accounts).toContainEqual(expect.objectContaining({
        adapterKind: 'simulator',
        connectionState: 'ready',
      }))
      expect(initial.runtime.bindings).toEqual([])
      expect(JSON.stringify(initial)).not.toContain('host-secret')
      expect(JSON.stringify(initial)).not.toContain('fixture-private-reference')
      await expect(view!.snapshot()).resolves.toMatchObject({
        status: 'applied',
        projection: { accounts: [expect.objectContaining({ connectionState: 'ready' })] },
      })

      const moduleGeneration = 'fixture-module'
      const identity = { id: 'channel', source: initial.owner.source }
      broker = new PermissionBroker(
        ownerSnapshotPermissionStore([]),
        { request: async () => 'deny' },
        () => new Date(),
        100,
        'test',
        'owner-generation',
        undefined,
        undefined,
        undefined,
        [{ ...initial.owner, moduleGeneration, runtimeGeneration: 'owner-generation' }],
      )
      const manifest = normalizePluginManifest(f.input.plugin.manifest, 'channel')
      const retire = broker.register(identity, manifest, { pluginId: 'channel', moduleGeneration })
      const channelTenant = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
      const channelConversation = { ...channelTenant, conversationId: 'direct-alice', kind: 'direct' as const }
      for (
        const capability of [
          'channel.events.receive',
          'channel.events.subscribe',
          'channel.messages.send',
          'channel.attachments.read',
        ] as const
      ) {
        const scope = capability.startsWith('channel.events.') ? { channelTenant } : { channelConversation }
        expect(await broker.authorizeChannel(identity, capability, scope)).toBe(false)
        await expect(broker.setPolicyV2(identity, capability, 'allow-persistent')).rejects.toThrow()
        expect(await broker.authorizeChannel(identity, capability, scope)).toBe(false)
      }
      const firstObservedAt = '2025-01-01T00:00:00.000Z'
      const refreshedObservedAt = '2025-01-02T00:00:00.000Z'
      let available = true
      const run = vi.fn(async () =>
        available
          ? { status: 'applied' as const, projection: { ...initial.runtime, observedAt: refreshedObservedAt } }
          : { status: 'unavailable' as const }
      )
      const root = new Context()
      fiber = root.plugin(CordisXChannelManagerPresentationService, {
        projection: { ...initial.projection, observedAt: firstObservedAt },
        profileId: 'test',
        hostGeneration: 'owner-generation',
        broker,
        actions: { snapshotOnly: true, run },
      })
      await fiber
      const ctx = root.extend({
        [CORDISX_PLUGIN_ID]: identity.id,
        [CORDISX_PLUGIN_SOURCE]: identity.source,
        [CORDISX_PLUGIN_GENERATION]: moduleGeneration,
      })
      const own = (ctx.channelManager as ChannelManagerV5).forOwnService()!
      const presentationManager = (ctx.channelManager as unknown as CordisXChannelManagerPresentationService)
        .forOwnPresentationService()!
      expect(presentationManager.presentationCapabilities()).toEqual({
        contract: 'cordisx.channel-manager-presentation-capabilities/v1',
        schemaVersion: 1,
        mode: 'snapshot-only',
      })
      const beforeRefresh = own.snapshot()
      expect(beforeRefresh.observedAt).toBe(firstObservedAt)
      expect(beforeRefresh.accounts).toContainEqual(expect.objectContaining({
        adapterKind: 'simulator',
        connectionState: 'ready',
      }))
      expect(beforeRefresh.accounts.flatMap(account => account.availableOperations)).toEqual([])
      await own.refreshIdentity(new AbortController().signal)
      expect(run).toHaveBeenCalledWith('snapshot', {})
      expect(own.snapshot().observedAt).toBe(refreshedObservedAt)
      available = false
      await own.refreshIdentity(new AbortController().signal)
      expect(own.snapshot().observedAt).toBe(refreshedObservedAt)
      expect(own.snapshot().accounts[0]?.connectionState).toBe('unavailable')
      available = true
      await own.refreshIdentity(new AbortController().signal)
      expect(own.snapshot().accounts[0]?.connectionState).toBe('ready')
      run.mockResolvedValueOnce({ status: 'applied', projection: { ...initial.runtime, observedAt: 'invalid' } })
      await expect(own.refreshIdentity(new AbortController().signal)).rejects.toThrow('observedAt')
      expect(own.snapshot().accounts[0]?.connectionState).toBe('unavailable')
      expect(own.snapshot().observedAt).toBe(refreshedObservedAt)
      await own.refreshIdentity(new AbortController().signal)
      expect(own.snapshot().accounts[0]?.connectionState).toBe('ready')
      let rejectOlder!: (error: Error) => void
      run.mockImplementationOnce(async () =>
        await new Promise((_resolve, reject) => {
          rejectOlder = reject
        })
      )
      const older = own.refreshIdentity(new AbortController().signal)
      const olderRejected = expect(older).rejects.toThrow('older-read-failed')
      await own.refreshIdentity(new AbortController().signal)
      rejectOlder(new Error('older-read-failed'))
      await olderRejected
      expect(own.snapshot().accounts[0]?.connectionState).toBe('ready')
      run.mockRejectedValueOnce(new Error('fixture-transport-failed'))
      await expect(own.refreshIdentity(new AbortController().signal)).rejects.toThrow('fixture-transport-failed')
      expect(own.snapshot().accounts[0]?.connectionState).toBe('unavailable')
      await own.refreshIdentity(new AbortController().signal)
      expect(own.snapshot().accounts[0]?.connectionState).toBe('ready')
      const account = own.snapshot().accounts[0]!
      const outcome = await own.execute({
        contract: 'cordisx.channel-manager-request/v2',
        schemaVersion: 2,
        requestId: 'disable-read-only',
        profileId: beforeRefresh.profileId,
        hostGeneration: beforeRefresh.hostGeneration,
        expectedRevision: own.snapshot().revision,
        operation: 'connection.disable',
        target: { kind: 'connection', connectionToken: account.connectionToken },
      })
      expect(outcome.status).toBe('rejected')
      expect(run).toHaveBeenCalledTimes(9)
      retire()
      expect(() => presentationManager.presentationCapabilities()).toThrow('PERMISSION_DENIED')
      view!.close()
    } finally {
      await fiber?.dispose()
      broker?.dispose()
      await f.dispose()
    }
  })

  it('retires rather than reading while a service restart is uncommitted', async () => {
    const f = await fixture()
    try {
      const view = (await openReadonlyHeadlessChannel(f.input))!
      const candidate = structuredClone(f.configuration)
      candidate.connections = [{ ...candidate.connections[0]!, enabled: false }]
      const transaction = await f.service.restart(candidate, view.initial.generation)
      try {
        await expect(view.snapshot()).resolves.toEqual({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
        expect(f.retire).toHaveBeenCalledOnce()
      } finally {
        await transaction.rollback()
      }
      await expect(view.snapshot()).resolves.toEqual({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
      expect(f.retire).toHaveBeenCalledOnce()
    } finally {
      await f.dispose()
    }
  })

  it('retires on external configuration change, service restart, or a revoked owner fence', async () => {
    for (const reason of ['config', 'restart', 'fence'] as const) {
      const f = await fixture()
      try {
        const view = (await openReadonlyHeadlessChannel(f.input))!
        if (reason === 'config') {
          const config = JSON.parse(await readFile(f.input.configPath, 'utf8'))
          config.plugins[0].services.runtime.profiles.test.revision = 2
          config.plugins[0].services.runtime.profiles.test.lastGoodRevision = 2
          await writeFile(f.input.configPath, JSON.stringify(config))
        } else if (reason === 'restart') {
          const transaction = await f.service.restart(f.configuration, view.initial.generation)
          await transaction.finalize()
        } else {
          f.controller.abort()
        }
        // A configuration revision can change without changing its payload; it
        // is still a new snapshot and must invalidate an existing renderer.
        await expect(view.snapshot()).resolves.toEqual({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
        expect(f.retire).toHaveBeenCalledOnce()
      } finally {
        await f.dispose()
      }
    }
  })

  it('cannot publish a response after its owner fence is revoked during a query', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const reached = new Promise<void>(resolve => {
      entered = resolve
    })
    let checks = 0
    const fence = {
      signal: f.controller.signal,
      retire: f.retire,
      async current() {
        checks += 1
        if (checks === 4) {
          entered()
          await blocked
        }
        return !f.controller.signal.aborted
      },
    }
    try {
      const view = (await openReadonlyHeadlessChannel({ ...f.input, fence }))!
      const pending = view.snapshot()
      await reached
      f.controller.abort()
      expect(f.retire).toHaveBeenCalledOnce()
      release()
      await expect(pending).resolves.toEqual({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
      expect(f.retire).toHaveBeenCalledOnce()
    } finally {
      release()
      await f.dispose()
    }
  })

  it('does not dispatch any write, workflow, conversation or malformed snapshot through a read-only bridge', async () => {
    const run = vi.fn(async () => ({ status: 'applied' as const }))
    const bridge = restrictChannelManagerActions({ snapshotOnly: true, run })!
    for (
      const action of [
        'enable',
        'disable',
        'reconnect',
        'archive',
        'restore',
        'unbind',
        'policy',
        'policy-set',
        'continuation-defaults',
        'continuation-defaults-set',
        'execution-defaults',
        'execution-defaults-set',
        'channel-execution-defaults',
        'channel-execution-defaults-set',
        'execution-settings',
        'execution-settings-set',
        'model-list',
        'task-config',
        'task-config-set',
        'task-settings',
        'task-settings-set',
        'binding-labels',
        'conversation-page',
        'conversation-detail',
        'conversation-activity',
        'conversation-bindings',
        'binding-navigation',
      ] as const
    ) {
      await expect(bridge.run(action, {})).resolves.toEqual({ status: 'unavailable', code: 'CHANNEL_READ_ONLY' })
    }
    await expect(bridge.run('snapshot', { unexpected: true })).resolves.toEqual({
      status: 'unavailable',
      code: 'CHANNEL_READ_ONLY',
    })
    expect(run).not.toHaveBeenCalled()
    await expect(bridge.run('snapshot', {})).resolves.toEqual({ status: 'applied' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('refuses nonempty plugin config, an added capability, and a different service identity', async () => {
    const f = await fixture()
    try {
      const plugin = f.input.plugin
      await expect(openReadonlyHeadlessChannel({
        ...f.input,
        plugin: { ...plugin, config: { secret: 'must-not-cross' } },
      })).resolves.toBeUndefined()
      expect(f.retire).toHaveBeenCalledOnce()
    } finally {
      await f.dispose()
    }
    const g = await fixture()
    try {
      const plugin = g.input.plugin
      const manifest = plugin.manifest!
      expect(manifest.schemaVersion).toBe(16)
      if (manifest.schemaVersion !== 16) throw new Error('fixture manifest mismatch')
      await expect(openReadonlyHeadlessChannel({
        ...g.input,
        plugin: {
          ...plugin,
          manifest: {
            ...manifest,
            capabilities: [...manifest.capabilities, {
              name: 'channel.accounts.read',
              required: false,
              scope: {},
            }],
          },
        },
      })).resolves.toBeUndefined()
      expect(g.retire).toHaveBeenCalledOnce()
    } finally {
      await g.dispose()
    }
    const h = await fixture()
    try {
      await expect(openReadonlyHeadlessChannel({
        ...h.input,
        plugin: { ...h.input.plugin, source: 'file:///not-the-running-owner' },
      })).resolves.toBeUndefined()
      expect(h.retire).toHaveBeenCalledOnce()
    } finally {
      await h.dispose()
    }
  })
})
