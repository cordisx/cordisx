import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { ServiceRendererIdentityProjection } from '../packages/cli/src/cli/service-renderer-identity.js'
import { projectManagementRequest } from '../packages/cli/src/cli/service-renderer-management-projection.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import type { ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const origin = 'http://127.0.0.1:43123'
const secret = () => randomBytes(32).toString('hex')

function project(graph: ServiceRendererPrivateGraph) {
  const baseUrl = `${origin}/api/renderer/graphs/${secret()}/`
  return {
    leaseId: secret(),
    pluginId: graph.pluginId,
    moduleGeneration: graph.moduleGeneration,
    baseUrl,
    entryUrl: baseUrl + graph.entryUrl.slice(graph.baseUrl.length),
    initialStyleUrls: graph.initialStyleUrls.map(url => baseUrl + url.slice(graph.baseUrl.length)),
  }
}

it('keeps a supported installed plugin available without loading an unsupported installed plugin', async () => {
  const f = await fixture({ protectProfileInputs: true, browserManagement: true })
  const privateConfig = 'fixture-private-configuration'
  try {
    expect(await f.install('healthy-plugin', 0)).toMatchObject({ outcome: 'applied' })
    expect(
      await f.install(
        'unsupported-plugin',
        1,
        true,
        'export const unavailableMarker = "private-unsupported-plugin-code"; export function apply() {}',
        undefined,
        'https://example.test/fixtures',
      ),
    ).toMatchObject({ outcome: 'applied' })
    const configs = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
    const token = secret()
    await configs.stage('unsupported-plugin', 0, { value: privateConfig }, token)
    await configs.commit('unsupported-plugin', 1, token)
    const prepared = await f.call({ action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    expect(prepared.value.privateGraphs.map((graph: ServiceRendererPrivateGraph) => graph.pluginId))
      .toEqual(['healthy-plugin'])
    const completed = await f.call({
      action: 'complete',
      managerOrigin: origin,
      graphs: prepared.value.privateGraphs.map(project),
    }) as any
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    try {
      const bundle = bytes.toString('utf8')
      expect(bundle).toContain('unsupported-plugin')
      expect(bundle).toMatch(/standaloneUnavailable\s*:\s*(?:true|!0)/u)
      expect(bundle).not.toContain('private-unsupported-plugin-code')
      expect(bundle).not.toContain(privateConfig)
      expect(bundle).not.toContain('https://example.test/fixtures')
      expect(bundle).not.toContain(f.homeDir)
    } finally {
      bytes.fill(0)
    }
    const management = JSON.stringify({
      version: 1,
      requestId: secret(),
      token: 'renderer-binding-placeholder',
      profileId: f.profileId,
      operation: { kind: 'query' },
    })
    const query = await f.sessions.call(f.invocation, 'plugin-management', management) as any
    expect(query).toMatchObject({ status: 'ok', value: { ok: true } })
    expect(query.value.value.plugins.find((item: any) => item.id === 'unsupported-plugin').availableOperations)
      .toEqual([])

    const active = f.lifecycle.snapshot().active
    const store = new PluginActivationStore(f.homeDir, f.profileId, f.generation)
    const plugins = await loadPluginComposition(store, active)
    const context = {
      profileId: f.profileId,
      ownerGeneration: f.generation,
      rendererId: secret(),
      signal: new AbortController().signal,
      admitted: true,
    } as any
    const identity = new ServiceRendererIdentityProjection({ homeDir: f.homeDir, context, isCurrent: () => true })
    try {
      const aliases = new Map<string, string>()
      for (const item of active.plugins) {
        aliases.set(
          item.id,
          await identity.issueInstalled(
            context,
            plugins.find(plugin => plugin.id === item.id)!,
            item,
            item.id === 'unsupported-plugin' ? { unavailable: true } : {},
          ),
        )
      }
      const item = active.plugins.find(plugin => plugin.id === 'unsupported-plugin')!
      const alias = aliases.get(item.id)!
      const source = plugins.find(plugin => plugin.id === item.id)!.source!
      identity.assertInstalledProjection(context, alias, item)
      expect(identity.projectActivation(context, active).plugins).toHaveLength(active.plugins.length)
      expect(() => identity.resolve(context, alias, item.id)).toThrow('renderer-identity-unavailable')
      expect(() => identity.resolveLifecycle(context, alias, item.id)).toThrow('renderer-identity-unavailable')
      expect(identity.resolveLifecycle(context, alias, item.id, item)).toEqual({
        pluginId: item.id,
        source,
        digest: item.digest,
      })
      expect(() => identity.resolveLifecycle(context, alias, item.id, { ...item, version: '2.0.0' }))
        .toThrow('renderer-identity-unavailable')
      expect(() => identity.projectManagerPolicies(context, alias, item.id, []))
        .toThrow('renderer-identity-unavailable')
      const catalog = await projectManagementRequest({
        context,
        operation: { kind: 'query-catalog' },
        dispatch: async () => ({
          plugins: [{ identity: { pluginId: item.id }, canonicalSource: source, installable: true }],
        }),
        entry: () => ({
          confirmed: true,
          current: () => true,
          unchanged: async () => true,
          identity,
          aliases,
          snapshot: f.lifecycle.snapshot(),
          scopedLifecycle: true,
          restricted: undefined,
        }),
        ownerSnapshot: () => f.lifecycle.snapshot(),
      }) as any
      expect(catalog.plugins[0]).toMatchObject({ canonicalSource: alias, installable: false })
      expect(JSON.stringify(catalog)).not.toContain(source)
      const dependent = {
        ...item,
        id: 'new-dependent',
        dependencies: [{ id: item.id, version: item.version }],
      }
      await expect(identity.prepareCandidate(context, {
        transactionId: 'fixture-transaction',
        targetId: dependent.id,
        affectedPluginIds: [dependent.id],
        previous: active,
        candidate: {
          ...active,
          recordKind: 'candidate',
          transactionId: 'fixture-transaction',
          revision: active.revision + 1,
          lastGoodRevision: active.revision,
          plugins: [...active.plugins, dependent],
        },
      })).rejects.toThrow('renderer-identity-unavailable')
    } finally {
      identity.close()
    }
  } finally {
    await f.close()
  }
}, 60_000)

it('isolates dependent graphs in both pages while preserving unrelated management', async () => {
  const f = await fixture({ protectProfileInputs: true, browserManagement: true })
  const secondId = secret()
  const handle = (await f.sessions.open(f.gateway, secondId))!
  const second = { gateway: f.gateway, browserSessionId: secondId, handle }
  try {
    expect(await f.install('unsupported-plugin', 0, true, undefined, undefined, 'https://example.test/fixtures'))
      .toMatchObject({ outcome: 'applied' })
    expect(
      await f.install('dependent-plugin', 1, false, undefined, [
        { id: 'unsupported-plugin', version: '1.0.0' },
      ]),
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await f.install('transitive-plugin', 2, false, undefined, [
        { id: 'dependent-plugin', version: '1.0.0' },
      ]),
    ).toMatchObject({ outcome: 'applied' })
    expect(await f.install('healthy-plugin', 3)).toMatchObject({ outcome: 'applied' })
    const boot = async (invocation: typeof f.invocation) => {
      const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      expect(prepared.status).toBe('ok')
      expect(prepared.value.privateGraphs.map((graph: ServiceRendererPrivateGraph) => graph.pluginId))
        .toEqual(['healthy-plugin'])
      const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
        action: 'complete',
        managerOrigin: origin,
        graphs: prepared.value.privateGraphs.map(project),
      }) as any
      expect(completed.status).toBe('ok')
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle.match(/standaloneUnavailable\s*:\s*(?:true|!0)/gu)).toHaveLength(3)
        return new Set(bundle.match(/https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}/gu))
      } finally {
        bytes.fill(0)
      }
    }
    const firstAliases = await boot(f.invocation)
    const secondAliases = await boot(second)
    expect(firstAliases.size).toBe(4)
    expect(secondAliases.size).toBe(4)
    expect([...secondAliases].some(alias => firstAliases.has(alias))).toBe(false)
    await f.sessions.close(f.invocation)
    expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
      .toMatchObject({ status: 'ok', value: { current: true } })
  } finally {
    await f.sessions.close(second).catch(() => undefined)
    await f.close()
  }
}, 60_000)

it('keeps an owner-managed service available beside an unsupported installed plugin', async () => {
  const f = await fixture({ managedUiVersion: 15, protectProfileInputs: true, browserManagement: true })
  const projections = vi.spyOn(f.managedUI, 'projectInitial')
  try {
    const revision = f.lifecycle.snapshot().active.revision
    expect(await f.install('unsupported-plugin', revision, true)).toMatchObject({ outcome: 'applied' })
    const prepared = await f.call({ action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    expect(prepared.value.privateGraphs.map((graph: ServiceRendererPrivateGraph) => graph.pluginId))
      .toEqual(['fixture-service'])
    const completed = await f.call({
      action: 'complete',
      managerOrigin: origin,
      graphs: prepared.value.privateGraphs.map(project),
    }) as any
    expect(completed.status).toBe('ok')
    const capability = projections.mock.results.at(-1)?.value?.[0]
    expect(capability).toBeDefined()
    const request = JSON.stringify({
      version: 1,
      token: capability!.token,
      requestId: 'managed-read',
      operation: 'get',
      scope: {
        profileId: f.profileId,
        runtimeGeneration: f.generation,
        pluginGeneration: capability!.pluginGeneration,
      },
      serviceId: 'gateway',
    })
    expect(await f.sessions.call(f.invocation, 'managed-service-ui', request))
      .toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
  } finally {
    await f.close()
  }
}, 60_000)

it('isolates service-free packages with unprojected configuration and their dependents', async () => {
  const f = await fixture({ protectProfileInputs: true, browserManagement: true })
  const privateValue = 'fixture-unprojected-private-value'
  try {
    expect(
      await f.install(
        'configured-plugin',
        0,
        false,
        'export const privateCodeMarker = "fixture-configured-code"; export function apply() {}',
      ),
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await f.install('dependent-plugin', 1, false, undefined, [
        { id: 'configured-plugin', version: '1.0.0' },
      ]),
    ).toMatchObject({ outcome: 'applied' })
    expect(await f.install('healthy-plugin', 2)).toMatchObject({ outcome: 'applied' })
    const configs = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
    const token = secret()
    await configs.stage('configured-plugin', 0, { value: privateValue }, token)
    await configs.commit('configured-plugin', 1, token)
    const prepared = await f.call({ action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    expect(prepared.value.privateGraphs.map((graph: ServiceRendererPrivateGraph) => graph.pluginId))
      .toEqual(['healthy-plugin'])
    const completed = await f.call({
      action: 'complete',
      managerOrigin: origin,
      graphs: prepared.value.privateGraphs.map(project),
    }) as any
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    try {
      const bundle = bytes.toString('utf8')
      expect(bundle.match(/standaloneUnavailable\s*:\s*(?:true|!0)/gu)).toHaveLength(2)
      expect(bundle).not.toContain(privateValue)
      expect(bundle).not.toContain('fixture-configured-code')
    } finally {
      bytes.fill(0)
    }
    const management = JSON.stringify({
      version: 1,
      requestId: secret(),
      token: 'renderer-binding-placeholder',
      profileId: f.profileId,
      operation: { kind: 'query' },
    })
    const query = await f.sessions.call(f.invocation, 'plugin-management', management) as any
    expect(query.value.value.plugins.find((item: any) => item.id === 'configured-plugin').availableOperations)
      .toEqual([])
  } finally {
    await f.close()
  }
}, 60_000)

it('still refuses an unprojected configuration when the package owns a service', async () => {
  const f = await fixture({ managedUiVersion: 15, protectProfileInputs: true })
  try {
    const configs = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
    const token = secret()
    await configs.stage('fixture-service', 0, { value: 'private' }, token)
    await configs.commit('fixture-service', 1, token)
    expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
  } finally {
    await f.close()
  }
}, 60_000)
