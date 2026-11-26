import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { channelConfigurationApi } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { configuredChannelManager } from '../packages/cli/src/launcher/channel-connection-configuration.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { ManagerChannelCredentials } from '../packages/cli/src/launcher/manager-channel-credentials.js'
import { ChannelCredentialDraftBroker } from '../packages/cli/src/launcher/channel-credential-drafts.js'
import { ManagerChannelDraftJournal } from '../packages/cli/src/launcher/manager-channel-draft-journal.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'
import {
  handlePluginManagementRpcRequest,
  managementMailboxRoot,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import { managementMailboxPath, requestManagementMailbox } from '../packages/cli/src/launcher/management-mailbox.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import type { LocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'

const sessionId = 'a'.repeat(64)
const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant-one' }
const requestOp = (action: string, fields: Record<string, unknown> = {}) =>
  ({ kind: 'manager-channel-credentials', action, sessionId, ...fields }) as never

async function fixture(options: { coordinated?: boolean } = {}) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-manager-'))
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(
    config => ({
      ...config,
      plugins: [{ id: 'channel', entry: 'cordisx:channel', config: {} }],
      apps: {
        ...config.apps,
        codex: {
          ...config.apps.codex!,
          profiles: { ...config.apps.codex!.profiles, work: { displayName: 'Work', dataMode: 'shared' } },
        },
      },
    }),
    configPath,
  )
  const packageIdentity = { moduleGeneration: 'plugin-1', digest: `sha256:${'1'.repeat(64)}` as `sha256:${string}` }
  const plugin = {
    id: 'channel',
    enabled: true,
    entry: '/fixture/channel/index.js',
    config: {},
    source: 'file:///channel',
    package: { ...packageIdentity, version: '1.0.0', dependencies: [] },
  }
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    runtime: {} as PluginLifecycleRuntime,
    profileId: 'work',
    runtimeGeneration: 'host-1',
    activate: async () =>
      ({
        hostGeneration: 'host-1',
        authorities: [],
        sources: [],
        nativeProviderIds: [],
        subscribeNativeProviders: () => () => {},
        prepareNativeConnection: () => {
          throw new Error('unused')
        },
        dispose: async () => {},
      }) as unknown as ManagedServiceNodeActivation,
  })
  const active: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: 'work',
    revision: 1,
    lastGoodRevision: 1,
    runtimeGeneration: 'host-1',
    plugins: [{
      id: 'channel',
      enabled: true,
      version: '1.0.0',
      dependencies: [],
      ...packageIdentity,
    }],
  }
  await lifecycle.initialize(active)
  let currentGeneration = 'service-1'
  let failFinalize = false
  const restart = vi.fn(async (_value: unknown, expected?: string) => {
    if (expected !== currentGeneration) throw new Error('stale generation')
    const previous = currentGeneration
    currentGeneration = `service-${restart.mock.calls.length + 1}`
    return {
      generation: currentGeneration,
      rollback: async () => {
        currentGeneration = previous
      },
      finalize: async () => {
        if (failFinalize) throw new Error('synthetic finalize failure')
      },
    }
  })
  const service = {
    generation: () => currentGeneration,
    restart,
    manager: { snapshot: () => undefined, connections: { reconnect: async () => ({ status: 'unavailable' }) } },
  } as unknown as LocalChannelService
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
  const store = new LauncherSecretStore({
    platform: 'darwin',
    backend,
    silentReadBackend: backend,
  })
  const validateCredentials = vi.fn(async () => {})
  const discoverTenant = vi.fn(async () => 'tenant-one')
  const openService = (expectedServiceGeneration: string) =>
    channelConfigurationApi({
      token: 'c'.repeat(64),
      profileId: 'work',
      generation: 'host-1',
      configPath,
      plugin,
      service,
      persistence: new PackagePluginServiceConfigStore(homeDir, 'work', 'host-1').persistence,
      expectedServiceGeneration,
    })
  const configured = configuredChannelManager({ service, configuration: openService })
  const manager = new ManagerChannelCredentials({
    profileId: 'work',
    runtimeGeneration: 'host-1',
    generation: () => service.generation(),
    setEnabled: async ({ enabled, ...request }) =>
      await (enabled ? configured.connections.enable : configured.connections.disable)(request),
    store,
    journal: new ManagerChannelDraftJournal({
      homeDir,
      configPath,
      profileId: 'work',
      store,
      packageStore: new PackagePluginServiceConfigStore(homeDir, 'work', 'host-1'),
      packageOwnerVerified: true,
    }),
    withOwner: async action =>
      await lifecycle.withActivePlugin({ id: 'channel', version: '1.0.0', ...packageIdentity }, action),
    openService,
    validateCredentials,
    discoverTenant,
  })
  const scope = {
    homeDigest: attachmentHomeDigest(homeDir),
    ownerAppId: 'codex',
    profileId: 'work',
    generation: 'host-1',
  }
  const renderers = options.coordinated ? new ServiceRendererLifecycle({ scope }) : undefined
  const participants = renderers ? new ServiceRendererParticipants(scope) : undefined
  if (renderers && participants) {
    renderers.initialize(active)
    participants.bind(renderers)
  }
  const server = renderers && participants
    ? await openProductionPluginManagementComposition({
      mode: 'service',
      homeDir,
      appId: 'codex',
      profileId: 'work',
      configPath,
      runtimeGeneration: 'host-1',
      token: 'd'.repeat(64),
      coordinator: new PluginLifecycleCoordinator({
        homeDir,
        profileId: 'work',
        runtimeGeneration: 'host-1',
        permissionPolicies: [],
        runtime: renderers,
      }),
      rendererParticipant: participants.participant,
      rendererParticipants: participants,
      rendererLifecycle: renderers,
      managerChannelCredentials: operation => manager.handle(operation),
    })
    : await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'work',
      configPath,
      generation: 'host-1',
      processStartedAt: new Date().toISOString(),
      service: {} as PluginManagementService,
      managerChannelCredentials: operation => manager.handle(operation),
    })
  const paths = pluginManagementRpcPaths(homeDir, 'codex', 'work')
  const endpoint = (await readPluginManagementRpcEndpoint(paths))!
  const request = async (operation: never) =>
    await requestPluginManagementRpc(paths, endpoint, operation) as Record<string, any>
  return {
    request,
    manager,
    lifecycle,
    values,
    restart,
    validateCredentials,
    discoverTenant,
    setGeneration: (value: string) => {
      currentGeneration = value
    },
    failNextFinalize: () => {
      failFinalize = true
    },
    close: async () => {
      await server.close()
      participants?.close()
      await renderers?.close()
      await manager.close()
      await lifecycle.dispose()
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

describe('local manager Channel credential transactions', () => {
  it('runs user-entered credential capture, commit and enablement through HTTP and the real Host socket', async () => {
    const f = await fixture({ coordinated: true })
    const operations: Array<Record<string, unknown>> = []
    const web = await startManagerWeb(
      {
        appId: 'codex',
        profileId: 'work',
        generation: 'host-1',
        isCurrent: async () => true,
        request: async (operation: Record<string, unknown>) => {
          operations.push(operation)
          return await f.request(operation as never)
        },
      } as unknown as Parameters<typeof startManagerWeb>[0],
    )
    const url = new URL(web.url), origin = url.origin
    const post = async (route: string, data: unknown, token?: string) =>
      await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(data),
      })
    try {
      const { token } = await (await post('/api/session', { token: url.hash.slice(1) })).json() as { token: string }
      const view = await (await post('/api/channel-credentials', { action: 'view' }, token)).json()
      expect(view).toMatchObject({ status: 'available', revision: 0, writable: true })
      const mismatch = await (await post('/api/channel-credentials', {
        action: 'capture',
        purpose: 'create',
        account: { ...account, tenantId: 'wrong-tenant' },
        secret: 'synthetic-secret',
        expectedRevision: view.revision,
        serviceGeneration: view.serviceGeneration,
      }, token)).json()
      expect(mismatch).toEqual({ status: 'rejected', code: 'TENANT_MISMATCH' })
      expect(f.values.size).toBe(0)
      expect(f.restart).not.toHaveBeenCalled()
      const captured = await (await post('/api/channel-credentials', {
        action: 'capture',
        purpose: 'create',
        account,
        secret: 'synthetic-secret',
        expectedRevision: view.revision,
        serviceGeneration: view.serviceGeneration,
      }, token)).json()
      expect(captured).toMatchObject({ status: 'applied', code: 'CAPTURED', ref: account })
      const committed = await (await post('/api/channel-credentials', {
        action: 'commit',
        draftId: captured.draftId,
        draft: { displayName: 'Fixture' },
      }, token)).json()
      expect(committed).toMatchObject({ status: 'applied', code: 'APPLIED' })
      const updated = await (await post('/api/channel-credentials', { action: 'view' }, token)).json()
      expect(updated).toMatchObject({ connections: [{ ref: account, enabled: true }] })
      const disabled = await (await post('/api/channel-credentials', {
        action: 'set-enabled',
        account,
        enabled: false,
        expectedRevision: updated.revision,
        serviceGeneration: updated.serviceGeneration,
      }, token)).json()
      expect(disabled).toMatchObject({ status: 'applied' })
      const finalView = await (await post('/api/channel-credentials', { action: 'view' }, token)).json()
      expect(finalView).toMatchObject({ connections: [{ ref: account, enabled: false }] })
      const sessionId = operations[0]!.sessionId
      expect(JSON.stringify([view, captured, committed, updated, disabled, finalView]))
        .not.toMatch(/synthetic-secret|secretRef|keychain:/)
      expect(JSON.stringify([view, captured, committed, updated, disabled, finalView])).not.toContain(sessionId)
      expect([...f.values.values()]).toEqual(['synthetic-secret'])
      await web.close()
      expect(operations).toContainEqual({ kind: 'manager-channel-credentials', action: 'retire', sessionId })
    } finally {
      await web.close().catch(() => undefined)
      await f.close()
    }
  })

  it('does not expose credential actions to the renderer or sandbox mailbox', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-mailbox-'))
    const service = {} as PluginManagementService
    const handler = vi.fn(async () => ({ status: 'applied' }))
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'work',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'host-1',
      processStartedAt: new Date().toISOString(),
      service,
      sandboxMailbox: true,
      managerChannelCredentials: handler,
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'work')
      const endpoint = (await readPluginManagementRpcEndpoint(paths))!
      const operation = requestOp('capture', {
        purpose: 'create',
        account,
        secret: 'synthetic-secret',
        expectedRevision: 0,
        serviceGeneration: 'service-1',
      })
      const request = { version: 1 as const, requestId: 'test', token: endpoint.token, profileId: 'work', operation }
      await expect(handlePluginManagementRpcRequest(service, request)).rejects.toThrow(
        'Local manager credentials require the service owner',
      )
      await expect(
        requestManagementMailbox({
          directory: managementMailboxPath(managementMailboxRoot(paths), endpoint.mailboxId!),
          token: endpoint.token,
          value: request,
          timeoutMs: 3_000,
        }),
      ).rejects.toThrow('MAILBOX_REQUEST_REJECTED')
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })
  it('preserves a committed credential when finalization fails and reports an unknown result', async () => {
    const f = await fixture()
    try {
      const view = await f.request(requestOp('view'))
      const captured = await f.request(
        requestOp('capture', {
          purpose: 'create',
          account,
          secret: 'synthetic-secret',
          expectedRevision: view.revision,
          serviceGeneration: view.serviceGeneration,
        }),
      )
      f.failNextFinalize()
      expect(await f.request(requestOp('commit', { draftId: captured.draftId, draft: { displayName: 'Fixture' } })))
        .toEqual({ status: 'unknown', code: 'RESULT_UNKNOWN' })
      expect(await f.request(requestOp('retire'))).toEqual({ status: 'retired' })
      expect([...f.values.values()]).toEqual(['synthetic-secret'])
      const after = await f.request(requestOp('view', { sessionId: 'b'.repeat(64) }))
      expect(after).toMatchObject({ revision: 1, connections: [{ ref: account }] })
    } finally {
      await f.close()
    }
  })
  it('captures once and commits through the real CAS with no secret or reference in responses', async () => {
    const f = await fixture()
    try {
      const view = await f.request(requestOp('view'))
      expect(view).toMatchObject({ status: 'available', revision: 0, serviceGeneration: 'service-1', writable: true })
      const captured = await f.request(
        requestOp('capture', {
          purpose: 'create',
          account,
          secret: 'synthetic-secret',
          expectedRevision: view.revision,
          serviceGeneration: view.serviceGeneration,
        }),
      )
      expect(captured).toMatchObject({ status: 'applied', code: 'CAPTURED', ref: account })
      const committed = await f.request(
        requestOp('commit', { draftId: captured.draftId, draft: { displayName: 'Fixture' } }),
      )
      expect(committed).toMatchObject({ status: 'applied', code: 'APPLIED', ref: account })
      expect(await f.request(requestOp('commit', { draftId: captured.draftId, draft: { displayName: 'Fixture' } })))
        .toMatchObject({ code: 'DRAFT_UNAVAILABLE' })
      const after = await f.request(requestOp('view'))
      expect(after).toMatchObject({
        status: 'available',
        revision: 1,
        connections: [{ ref: account, displayName: 'Fixture' }],
      })
      expect(JSON.stringify([view, captured, committed, after])).not.toMatch(/synthetic-secret|keychain:|secretRef/)
      expect([...f.values.values()]).toEqual(['synthetic-secret'])
      expect(f.restart).toHaveBeenCalledOnce()
      expect(
        await f.request(
          requestOp('set-enabled', {
            account,
            enabled: false,
            expectedRevision: after.revision,
            serviceGeneration: after.serviceGeneration,
          }),
        ),
      ).toEqual({ status: 'applied' })
      const disabled = await f.request(requestOp('view'))
      expect(disabled).toMatchObject({
        revision: 2,
        connections: [{ ref: account, enabled: false, connectionState: 'unknown' }],
      })
      expect(
        await f.request(
          requestOp('set-enabled', {
            account,
            enabled: true,
            expectedRevision: after.revision,
            serviceGeneration: disabled.serviceGeneration,
          }),
        ),
      ).toEqual({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(f.restart).toHaveBeenCalledTimes(2)
      f.failNextFinalize()
      expect(
        await f.request(
          requestOp('set-enabled', {
            account,
            enabled: true,
            expectedRevision: disabled.revision,
            serviceGeneration: disabled.serviceGeneration,
          }),
        ),
      ).toEqual({ status: 'unknown', code: 'RESULT_UNKNOWN' })
      expect(await f.request(requestOp('view'))).toMatchObject({
        revision: 3,
        connections: [{ ref: account, enabled: true }],
      })
    } finally {
      await f.close()
    }
  })

  it('binds drafts to session, service generation and revision; retirement removes an unused capture', async () => {
    const f = await fixture()
    try {
      const view = await f.request(requestOp('view'))
      expect(
        await f.request(
          requestOp('capture', {
            purpose: 'create',
            account,
            secret: 'synthetic-secret',
            expectedRevision: 1,
            serviceGeneration: view.serviceGeneration,
          }),
        ),
      ).toMatchObject({ status: 'conflict' })
      expect(f.validateCredentials).not.toHaveBeenCalled()
      const captured = await f.request(
        requestOp('capture', {
          purpose: 'create',
          account,
          secret: 'synthetic-secret',
          expectedRevision: 0,
          serviceGeneration: view.serviceGeneration,
        }),
      )
      expect(
        await f.request(
          requestOp('commit', {
            sessionId: 'b'.repeat(64),
            draftId: captured.draftId,
            draft: { displayName: 'Fixture' },
          }),
        ),
      ).toMatchObject({ code: 'DRAFT_UNAVAILABLE' })
      f.setGeneration('service-replaced')
      expect(await f.request(requestOp('commit', { draftId: captured.draftId, draft: { displayName: 'Fixture' } })))
        .toMatchObject({ code: 'DRAFT_UNAVAILABLE' })
      expect(f.values.size).toBe(0)
      expect(f.restart).not.toHaveBeenCalled()
      expect(await f.request(requestOp('retire'))).toEqual({ status: 'retired' })
      expect(await f.request(requestOp('view'))).toMatchObject({ code: 'SESSION_RETIRED' })
    } finally {
      await f.close()
    }
  })

  it('keeps an unresolved tenant pending and supports a later explicit resolution', async () => {
    const f = await fixture()
    f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
    try {
      const initial = await f.request(requestOp('view'))
      const pendingAccount = { ...account, tenantId: '' }
      const captured = await f.request(
        requestOp('capture', {
          purpose: 'create',
          account: pendingAccount,
          secret: 'synthetic-secret',
          expectedRevision: initial.revision,
          serviceGeneration: initial.serviceGeneration,
        }),
      )
      expect(captured.ref).toEqual(pendingAccount)
      expect(await f.request(requestOp('commit', { draftId: captured.draftId, draft: { displayName: 'Pending' } })))
        .toMatchObject({ status: 'applied' })
      const view = await f.request(requestOp('view'))
      expect(view.pendingConnections).toMatchObject([{ account: { adapterId: 'feishu', accountId: 'cli_fixture' } }])
      f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
      const lookupFailure = await f.request(requestOp('resolve-tenant', {
        account: pendingAccount,
        expectedRevision: view.revision,
        serviceGeneration: view.serviceGeneration,
      }))
      expect(lookupFailure).toEqual({ status: 'rejected', code: 'TENANT_DISCOVERY_PERMISSION_DENIED' })
      const mismatch = await f.request(requestOp('resolve-tenant', {
        account: pendingAccount,
        tenantId: 'wrong-tenant',
        expectedRevision: view.revision,
        serviceGeneration: view.serviceGeneration,
      }))
      expect(mismatch).toEqual({ status: 'rejected', code: 'TENANT_MISMATCH' })
      expect(await f.request(requestOp('view'))).toMatchObject({
        revision: view.revision,
        pendingConnections: [
          { account: { adapterId: 'feishu', accountId: 'cli_fixture' } },
        ],
      })
      f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
      const resolved = await f.request(
        requestOp('resolve-tenant', {
          account: pendingAccount,
          tenantId: 'tenant-manual',
          expectedRevision: view.revision,
          serviceGeneration: view.serviceGeneration,
        }),
      )
      expect(resolved).toMatchObject({ status: 'applied', ref: { ...account, tenantId: 'tenant-manual' } })
      expect(f.values.size).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('does not trust an unmarked tenant rejection after a possible write', async () => {
    const f = await fixture()
    const forged = vi.spyOn(ChannelCredentialDraftBroker.prototype, 'handle').mockResolvedValueOnce({
      status: 'rejected',
      code: 'TENANT_MISMATCH',
    })
    try {
      const view = await f.request(requestOp('view'))
      const result = await f.request(requestOp('resolve-tenant', {
        account: { ...account, tenantId: '' },
        tenantId: 'tenant-manual',
        expectedRevision: view.revision,
        serviceGeneration: view.serviceGeneration,
      }))
      expect(result).toEqual({ status: 'unknown', code: 'RESULT_UNKNOWN' })
    } finally {
      forged.mockRestore()
      await f.close()
    }
  })
})
