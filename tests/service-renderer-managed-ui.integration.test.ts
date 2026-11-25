import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
import { ServiceRendererIdentityProjection } from '../packages/cli/src/cli/service-renderer-identity.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'

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

it.each([[14, false], [15, false], [16, false], [16, true]] as const)(
  'projects v%s managed UI identities with withoutStartup=%s into isolated read-only sessions',
  async (version, withoutStartup) => {
    const f = await fixture({
      managedUiVersion: version,
      managedWithoutStartup: withoutStartup,
      managedUiGrant: true,
      protectProfileInputs: true,
      browserManagement: true,
    })
    const secondId = secret()
    const handle = (await f.sessions.open(f.gateway, secondId))!
    const second = { gateway: f.gateway, browserSessionId: secondId, handle }
    const source = 'https://example.test/fixtures'
    const projections = vi.spyOn(f.managedUI, 'projectInitial')
    const management = (operation: unknown) =>
      JSON.stringify({
        version: 1,
        requestId: secret(),
        token: 'renderer-binding-placeholder',
        profileId: f.profileId,
        operation,
      })
    const boot = async (invocation: typeof f.invocation) => {
      const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      expect(prepared.status).toBe('ok')
      const graphs = prepared.value.privateGraphs.map(project)
      const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
        action: 'complete',
        managerOrigin: origin,
        graphs,
      }) as any
      expect(completed.status).toBe('ok')
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const text = bytes.toString('utf8')
        const aliases = [...new Set(text.match(/https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}/gu))]
        expect(aliases).toHaveLength(1)
        expect(text).not.toContain(source)
        expect(text).not.toContain(f.managed.capabilities()[0]!.token)
        const capability = projections.mock.results.at(-1)?.value?.[0]
        if (!capability) throw new Error('managed service projection is missing')
        return { alias: aliases[0]!, capability }
      } finally {
        bytes.fill(0)
      }
    }
    try {
      expect(await f.sessions.call(f.invocation, 'plugin-management', management({ kind: 'query' })))
        .toEqual({ status: 'unavailable' })
      const first = await boot(f.invocation)
      const other = await boot(second)
      const firstAlias = first.alias
      const secondAlias = other.alias
      expect(secondAlias).not.toBe(firstAlias)
      const firstQuery = await f.sessions.call(f.invocation, 'plugin-management', management({ kind: 'query' })) as any
      const secondQuery = await f.sessions.call(second, 'plugin-management', management({ kind: 'query' })) as any
      expect(firstQuery).toMatchObject({
        status: 'ok',
        value: { ok: true, value: { plugins: [{ canonicalSource: firstAlias, availableOperations: [] }] } },
      })
      expect(secondQuery.value.value.plugins[0].canonicalSource).toBe(secondAlias)
      expect(JSON.stringify(firstQuery)).not.toContain(source)
      const request = (operation: string, binding?: unknown) =>
        JSON.stringify({
          version: 1,
          token: first.capability.token,
          requestId: `managed-${operation}`,
          operation,
          scope: {
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            pluginGeneration: first.capability.pluginGeneration,
          },
          serviceId: 'gateway',
          ...(binding === undefined ? {} : { binding }),
        })
      const get = await f.sessions.call(f.invocation, 'managed-service-ui', request('get')) as any
      expect(get).toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
      expect(
        await f.sessions.call(f.invocation, 'managed-service-ui', request('snapshot', get.value.value.service.binding)),
      )
        .toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
      await vi.waitFor(() => expect(f.managed.nativeActivation().nativeProviderIds).toContain('fixture-provider'), {
        timeout: 10_000,
      })
      for (const [invocation, alias] of [[f.invocation, firstAlias], [second, secondAlias]] as const) {
        const polling = f.sessions.poll(invocation, 3000)
        const admitting = f.sessions.admit(invocation)
        const polled = await polling as any
        const command = polled.value.command
        expect(command.method).toBe('synchronize')
        expect(command.payload.active.plugins[0].canonicalSource).toBe(alias)
        expect(JSON.stringify(command.payload)).not.toContain(source)
        expect(
          await f.sessions.acknowledge(invocation, {
            id: command.id,
            sequence: command.sequence,
            ok: true,
            value: command.payload,
          }),
        ).toEqual({ status: 'ok', value: { accepted: true } })
        expect(await admitting).toEqual({ status: 'ok', value: { admitted: true } })
      }
      const before = f.lifecycle.snapshot().active
      expect(
        await f.sessions.call(
          f.invocation,
          'plugin-management',
          management({
            kind: 'plan',
            request: { kind: 'plugin-disable', pluginId: 'fixture-service' },
          }),
        ),
      ).toMatchObject({ status: 'ok', value: { ok: false, error: expect.stringContaining('read-only') } })
      expect((await f.install('blocked-change', before.revision)).outcome).not.toBe('applied')
      expect(f.lifecycle.snapshot().active).toEqual(before)
      expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
      const thirdId = secret()
      const thirdHandle = (await f.sessions.open(f.gateway, thirdId))!
      const third = { gateway: f.gateway, browserSessionId: thirdId, handle: thirdHandle }
      const thirdAlias = (await boot(third)).alias
      const polling = f.sessions.poll(third, 3000)
      const admitting = f.sessions.admit(third)
      const command = (await polling as any).value.command
      expect(command.payload.active.plugins[0].canonicalSource).toBe(thirdAlias)
      const forged = structuredClone(command.payload)
      forged.active.plugins[0].canonicalSource = firstAlias
      expect(
        await f.sessions.acknowledge(third, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: forged,
        }),
      ).toEqual({ status: 'unavailable' })
      expect(await admitting).toEqual({ status: 'unavailable' })
      expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
    } finally {
      await f.sessions.close(second).catch(() => undefined)
      await f.close()
    }
  },
  120_000,
)

it('does not project an unsupported v16 Channel capability with a managed service', async () => {
  const f = await fixture({ managedUiVersion: 16, managedChannelExact: true, protectProfileInputs: true })
  try {
    expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
  } finally {
    await f.close()
  }
}, 30_000)

it('binds installed aliases to the exact owner package and never promotes non-manager grants', async () => {
  const f = await fixture({ managedUiVersion: 14, protectProfileInputs: true })
  const controller = new AbortController()
  const context = {
    profileId: f.profileId,
    rendererId: secret(),
    ownerGeneration: f.generation,
    signal: controller.signal,
  }
  const identity = new ServiceRendererIdentityProjection({ homeDir: f.homeDir, context, isCurrent: () => true })
  try {
    const active = f.lifecycle.snapshot().active
    const plugin = (await loadPluginComposition(f.coordinator.store, active))[0]!
    const item = active.plugins[0]!
    await expect(identity.issueInstalled(context, { ...plugin, source: 'https://example.test/other' }, item))
      .rejects.toThrow('renderer-identity-unavailable')
    const alias = await identity.issueInstalled(context, plugin, item)
    const policies = exactDomPermissionPolicies(f.profileId, [{
      id: plugin.id,
      entry: plugin.entry,
      pointIds: ['manager.content', 'manager.settings.navigation-items', 'workspace.toolbar.items'],
    }]).map(policy => ({
      ...policy,
      key: { ...policy.key, identity: { ...policy.key.identity, source: plugin.source! } },
    }))
    const platformGrant = createPermissionPolicyRecord({
      profileId: f.profileId,
      identity: { source: plugin.source!, id: plugin.id },
      capability: 'models.read',
      scope: { providers: ['fixture-provider'] },
      policy: 'allow',
    })
    expect(
      identity.projectManagerPolicies(context, alias, plugin.id, [...policies, platformGrant]).map(value =>
        value.key.scope
      ),
    )
      .toEqual([{ extensionPoints: ['manager.content'] }, { extensionPoints: ['manager.settings.navigation-items'] }])
    expect(identity.projectActivation(context, active).plugins[0]!.canonicalSource).toBe(alias)
    expect(() =>
      identity.projectActivation(context, {
        ...active,
        plugins: [{ ...item, enabled: !item.enabled }],
      })
    ).toThrow('renderer-identity-unavailable')
    controller.abort()
    expect(() => identity.projectActivation(context, active)).toThrow('renderer-identity-unavailable')
  } finally {
    identity.close()
    await f.close()
  }
}, 90_000)
