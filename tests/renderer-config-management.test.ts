import { runInNewContext } from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { parseRendererConfigOperation } from '../packages/cli/src/launcher/renderer-config-management.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

function fixture() {
  let revision = 1
  let value = 'before'
  const config = () => ({
    namespace: 'demo',
    schemaKind: 'schemastery',
    applies: 'live',
    writable: true,
    revision,
    lastGoodRevision: revision,
    value: { greeting: value },
    fields: [],
    secrets: [],
  })
  const renderer = {
    snapshot: () => ({
      plugins: [{
        id: 'demo',
        name: 'Demo',
        status: 'active',
        configuration: config(),
        config: { token: 'not-projected' },
      }],
    }),
    updatePluginConfig: vi.fn(async (_plugin: string, expected: number, operations: { value: string }[]) => {
      if (expected !== revision) throw new Error('stale')
      value = operations[0]!.value
      revision++
    }),
    listServiceConfigs: vi.fn(async () => []),
    updateServiceConfig: vi.fn(async () => ({ status: 'applied', revision: 3 })),
  }
  const session = {
    async send(method: string, params: { expression: string }) {
      expect(method).toBe('Runtime.evaluate')
      return { result: { value: await runInNewContext(params.expression, { __cordisxRuntime: renderer }) } }
    },
  }
  return { renderer, session }
}

describe('external plugin configuration authority', () => {
  it('preserves the existing schema transaction and projects only the requested safe descriptor', async () => {
    const { renderer, session } = fixture()
    const runtime = new CdpPluginLifecycleRuntime()
    const remove = runtime.register(session as never)
    const kind = 'plugin-configuration' as const
    const listed = await runtime.pluginConfiguration({ kind, action: 'list' })
    expect(listed).toEqual({ status: 'ok', plugins: [{ id: 'demo', name: 'Demo', status: 'active', writable: true }] })
    expect(JSON.stringify(listed)).not.toContain('not-projected')
    expect(await runtime.pluginConfiguration({ kind, action: 'read', pluginId: 'demo' })).toMatchObject({
      status: 'ok',
      configuration: { revision: 1, value: { greeting: 'before' } },
    })
    const hostile = `"});globalThis.EXECUTED=true;//`
    expect(
      await runtime.pluginConfiguration({
        kind,
        action: 'update',
        pluginId: 'demo',
        expectedRevision: 1,
        operations: [{ op: 'set', path: ['greeting'], value: hostile }],
      }),
    ).toMatchObject({ status: 'ok', configuration: { revision: 2, value: { greeting: hostile } } })
    expect(renderer.updatePluginConfig).toHaveBeenCalledOnce()
    expect(
      await runtime.pluginConfiguration({
        kind,
        action: 'update',
        pluginId: 'demo',
        expectedRevision: 1,
        operations: [{ op: 'unset', path: ['greeting'] }],
      }),
    ).toEqual({ status: 'rejected', reason: 'revision-conflict' })
    expect(renderer.updatePluginConfig).toHaveBeenCalledOnce()
    remove()
  })

  it('never selects an ambiguous renderer and fences lifecycle changes while a mutation is pending', async () => {
    const { renderer, session } = fixture()
    const runtime = new CdpPluginLifecycleRuntime()
    const kind = 'plugin-configuration' as const
    expect(await runtime.pluginConfiguration({ kind, action: 'list' })).toEqual({
      status: 'unavailable',
      reason: 'renderer-unavailable',
    })
    const removeFirst = runtime.register(session as never)
    const removeSecond = runtime.register({ ...session } as never)
    expect(await runtime.pluginConfiguration({ kind, action: 'list' })).toEqual({
      status: 'unavailable',
      reason: 'renderer-ambiguous',
    })
    removeSecond()
    let finish!: () => void
    const blocked = new Promise<void>(resolve => {
      finish = resolve
    })
    renderer.updatePluginConfig.mockImplementationOnce(async () => await blocked)
    const pending = runtime.pluginConfiguration({
      kind,
      action: 'update',
      pluginId: 'demo',
      expectedRevision: 1,
      operations: [{ op: 'set', path: ['greeting'], value: 'after' }],
    })
    expect(() => runtime.prepare('other-transaction')).toThrow('another plugin generation transaction')
    expect(await runtime.pluginConfiguration({ kind, action: 'list' })).toEqual({
      status: 'unavailable',
      reason: 'renderer-busy',
    })
    finish()
    await pending
    removeFirst()
  })

  it('treats a disconnected write as unknown and preserves explicit profile scope', async () => {
    const { session } = fixture()
    const runtime = new CdpPluginLifecycleRuntime()
    const remove = runtime.register(session as never)
    const pending = runtime.pluginConfiguration({
      kind: 'plugin-configuration',
      action: 'update',
      pluginId: 'demo',
      expectedRevision: 1,
      operations: [{ op: 'set', path: ['greeting'], value: 'after' }],
    })
    remove()
    expect(await pending).toEqual({ status: 'unknown', reason: 'renderer-disconnected' })
    expect(() =>
      parseRendererConfigOperation({
        kind: 'plugin-configuration',
        action: 'update-service',
        pluginId: 'demo',
        mutation: {
          contract: 'cordisx.service-config-mutation/v1',
          schemaVersion: 1,
          identity: { source: 'file:///demo', pluginId: 'other', serviceId: 'main' },
          scope: { profileId: 'different', generation: 'generation' },
          expectedRevision: 0,
          configuration: {},
        },
      }, 'default')
    ).toThrow('invalid service configuration mutation')
  })

  it('routes service configuration through the existing scoped service authority', async () => {
    const { renderer, session } = fixture()
    const runtime = new CdpPluginLifecycleRuntime()
    const remove = runtime.register(session as never)
    const kind = 'plugin-configuration' as const
    const mutation = {
      contract: 'cordisx.service-config-mutation/v1' as const,
      schemaVersion: 1 as const,
      identity: { source: 'file:///demo', pluginId: 'demo', serviceId: 'main' },
      scope: { profileId: 'default', generation: 'generation' },
      expectedRevision: 2,
      configuration: { enabled: true },
    }
    try {
      expect(await runtime.pluginConfiguration({ kind, action: 'services', pluginId: 'demo' })).toEqual({
        status: 'ok',
        services: [],
      })
      const request = parseRendererConfigOperation(
        { kind, action: 'update-service', pluginId: 'demo', mutation },
        'default',
      )
      expect(await runtime.pluginConfiguration(request)).toEqual({
        status: 'ok',
        result: { status: 'applied', revision: 3 },
      })
      expect(renderer.updateServiceConfig).toHaveBeenCalledOnce()
      expect(renderer.updateServiceConfig).toHaveBeenCalledWith(mutation)
    } finally {
      remove()
    }
  })

  it('routes authenticated management socket requests to the admitted owner', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-renderer-config-'))
    const { session } = fixture()
    const runtime = new CdpPluginLifecycleRuntime()
    const remove = runtime.register(session as never)
    const processStartedAt = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'generation',
      processStartedAt: processStartedAt!,
      service: {} as PluginManagementService,
      rendererConfiguration: operation => runtime.pluginConfiguration(operation),
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(paths))!
      expect(
        await requestPluginManagementRpc(paths, endpoint, {
          kind: 'plugin-configuration',
          action: 'read',
          pluginId: 'demo',
        }),
      )
        .toMatchObject({ status: 'ok', configuration: { revision: 1 } })
      await expect(requestPluginManagementRpc(paths, { ...endpoint, token: '0'.repeat(64) }, {
        kind: 'plugin-configuration',
        action: 'list',
      })).rejects.toThrow('scope is invalid')
    } finally {
      remove()
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
