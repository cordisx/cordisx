import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { createManagedServiceSource } from '../packages/cli/src/launcher/managed-service-ui-source.js'
import {
  handlePluginManagementRpcRequest,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type { ManagedServiceRegistrationHandleV1 } from '@cordisx/protocol/managed-service-runtime/v1'

const session = 'a'.repeat(64)
const other = 'b'.repeat(64)
const op = (action: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'manager-service-auth', action, sessionId: session, ...extra }) as never

async function fixture(authenticationMode: 'cli' | 'host-secret' = 'cli') {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-auth-'))
  const projection = {
    binding: {
      registrationHandle: 'msr_test',
      serviceHandle: 'mss_test',
      identity: { pluginId: 'aiden', serviceId: 'gateway' },
      hostGeneration: 'runtime-1',
      serviceGeneration: 'service-1',
    },
    state: 'authentication-required',
    health: 'stopped',
    processOwnership: 'host-owned',
    configuration: { state: 'not-required' },
    authentication: { state: 'missing' },
    httpAuthorization: { state: 'not-required' },
  }
  const registration = {
    binding: projection.binding,
    inspect: vi.fn(async () => projection),
    authenticate: vi.fn(async () => ({ status: 'accepted', projection })),
  } as unknown as ManagedServiceRegistrationHandleV1
  const source = createManagedServiceSource({
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    registrationHandle: registration,
    healthIntervalMs: 250,
    displayName: 'Aiden',
    serviceKind: 'managed-backend',
    pluginId: 'aiden',
    pluginGeneration: 'plugin-1',
    serviceId: 'gateway',
    authenticationMode,
    logoutAvailable: false,
  })
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    runtime: {} as PluginLifecycleRuntime,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    activate: async () =>
      ({
        hostGeneration: 'runtime-1',
        authorities: [],
        sources: [{ pluginId: 'aiden', pluginGeneration: 'plugin-1', serviceId: 'gateway', source }],
        nativeProviderIds: [],
        subscribeNativeProviders: () => () => {},
        prepareNativeConnection: () => {
          throw new Error('unused')
        },
        dispose: async () => {},
      }) as unknown as ManagedServiceNodeActivation,
  })
  await lifecycle.initialize({
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: 'work',
    revision: 1,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'aiden',
      version: '1.0.0',
      digest: `sha256:${'1'.repeat(64)}`,
      moduleGeneration: 'plugin-1',
      enabled: true,
      dependencies: [],
    }],
  })
  const service = {} as PluginManagementService
  const server = await startPluginManagementRpcServer({
    homeDir,
    appId: 'codex',
    profileId: 'work',
    configPath: path.join(homeDir, 'config.json'),
    generation: 'runtime-1',
    processStartedAt: new Date().toISOString(),
    service,
    managerServiceAuth: operation => lifecycle.managerAuth(operation),
  })
  const paths = pluginManagementRpcPaths(homeDir, 'codex', 'work')
  const endpoint = (await readPluginManagementRpcEndpoint(paths))!
  const request = async (operation: never) =>
    await requestPluginManagementRpc(paths, endpoint, operation) as Record<string, any>
  return {
    source,
    registration,
    lifecycle,
    request,
    close: async () => {
      await server.close()
      await lifecycle.dispose()
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

describe('local manager service authentication', () => {
  it('uses the real lifecycle and private socket, scopes single-use leases, and rejects stale snapshots', async () => {
    const f = await fixture()
    try {
      const listed = await f.request(op('list'))
      expect(listed).toMatchObject({
        status: 'available',
        services: [{
          pluginId: 'aiden',
          serviceId: 'gateway',
          pluginGeneration: 'plugin-1',
          canLogin: true,
        }],
      })
      const view = listed.services[0]
      const target = {
        pluginId: 'aiden',
        serviceId: 'gateway',
        pluginGeneration: view.pluginGeneration,
        bindingId: view.bindingId,
      }
      const stale = await f.request(op('prepare-login', target))
      await f.source.snapshot()
      expect(await f.request(op('login', { leaseId: stale.leaseId }))).toEqual({
        status: 'denied',
        code: 'STALE_REVISION',
      })
      expect(f.registration.authenticate).not.toHaveBeenCalled()
      const prepared = await f.request(op('prepare-login', target))
      expect(await f.request(op('login', { sessionId: other, leaseId: prepared.leaseId }))).toMatchObject({
        code: 'LEASE_UNAVAILABLE',
      })
      expect(await f.request(op('login', { leaseId: prepared.leaseId }))).toMatchObject({ code: 'LEASE_UNAVAILABLE' })
      const ready = await f.request(op('prepare-login', target))
      expect(await f.request(op('login', { leaseId: ready.leaseId }))).toEqual({ status: 'accepted' })
      expect(f.registration.authenticate).toHaveBeenCalledOnce()
      expect(await f.request(op('login', { leaseId: ready.leaseId }))).toMatchObject({ code: 'LEASE_UNAVAILABLE' })
      expect(JSON.stringify(listed)).not.toMatch(/msr_test|mss_test|token|secret/)
    } finally {
      await f.close()
    }
  })

  it('revokes pending work and is unavailable through the renderer handler', async () => {
    const f = await fixture()
    try {
      const view = await f.request(op('view', { pluginId: 'aiden', serviceId: 'gateway' }))
      const prepared = await f.request(
        op('prepare-login', {
          pluginId: 'aiden',
          serviceId: 'gateway',
          pluginGeneration: view.pluginGeneration,
          bindingId: view.bindingId,
        }),
      )
      expect(await f.request(op('retire'))).toEqual({ status: 'retired' })
      expect(await f.request(op('login', { leaseId: prepared.leaseId }))).toMatchObject({ code: 'SESSION_RETIRED' })
      expect(f.registration.authenticate).not.toHaveBeenCalled()
      await expect(handlePluginManagementRpcRequest({} as PluginManagementService, {
        version: 1,
        requestId: 'x',
        token: 'x',
        profileId: 'work',
        operation: op('list'),
      })).rejects.toThrow('Local manager authentication requires the lifecycle owner')
    } finally {
      await f.close()
    }
  })

  it('expires leases and never treats a stale service binding as authorization', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = await fixture()
    try {
      const view = await f.request(op('view', { pluginId: 'aiden', serviceId: 'gateway' }))
      const target = {
        pluginId: 'aiden',
        serviceId: 'gateway',
        pluginGeneration: view.pluginGeneration,
        bindingId: view.bindingId,
      }
      expect(await f.request(op('prepare-login', { ...target, pluginGeneration: 'replaced' }))).toMatchObject({
        code: 'STALE_GENERATION',
      })
      expect(await f.request(op('prepare-login', { ...target, bindingId: 'replaced' }))).toMatchObject({
        code: 'STALE_GENERATION',
      })
      const prepared = await f.request(op('prepare-login', target))
      vi.setSystemTime(Date.now() + 30_001)
      expect(await f.request(op('login', { leaseId: prepared.leaseId }))).toMatchObject({ code: 'LEASE_UNAVAILABLE' })
      expect(f.registration.authenticate).not.toHaveBeenCalled()
    } finally {
      await f.close()
      vi.useRealTimers()
    }
  })

  it('does not invent login support for host-secret services or expose plugin errors', async () => {
    const unsupported = await fixture('host-secret')
    try {
      const view = await unsupported.request(op('view', { pluginId: 'aiden', serviceId: 'gateway' }))
      expect(view).toMatchObject({ status: 'available', explicitLogin: false, canLogin: false })
      expect(
        await unsupported.request(
          op('prepare-login', {
            pluginId: 'aiden',
            serviceId: 'gateway',
            pluginGeneration: view.pluginGeneration,
            bindingId: view.bindingId,
          }),
        ),
      ).toMatchObject({ code: 'LOGIN_UNAVAILABLE' })
      expect(unsupported.registration.authenticate).not.toHaveBeenCalled()
    } finally {
      await unsupported.close()
    }
    const f = await fixture()
    try {
      vi.mocked(f.registration.authenticate).mockRejectedValueOnce(new Error('synthetic-secret'))
      const view = await f.request(op('view', { pluginId: 'aiden', serviceId: 'gateway' }))
      const prepared = await f.request(
        op('prepare-login', {
          pluginId: 'aiden',
          serviceId: 'gateway',
          pluginGeneration: view.pluginGeneration,
          bindingId: view.bindingId,
        }),
      )
      const result = await f.request(op('login', { leaseId: prepared.leaseId }))
      expect(result).toEqual({ status: 'failed', code: 'LOGIN_NOT_ACCEPTED' })
      expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    } finally {
      await f.close()
    }
  })
})
