import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  persistPermissionPolicies,
  persistPermissionPoliciesIfUnchanged,
} from '../packages/cli/src/launcher/permission-rpc.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import type { ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'
import { configuredManagerPlugin } from './fixtures/configured-manager-plugin.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

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

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux').each(
  [
    'entry',
    'archive bytes',
    'after write',
  ] as const,
)(
  'fences a configured plugin policy when %s changes during the owner reservation',
  async change => {
    let entered!: () => void
    let resume!: () => void
    const reserved = new Promise<void>(resolve => entered = resolve)
    const waiting = new Promise<void>(resolve => resume = resolve)
    let reservationError: unknown
    let wrote = false
    let completed: boolean | undefined
    let consumersFenced = false
    let f!: Awaited<ReturnType<typeof fixture>>
    f = await fixture({
      protectProfileInputs: true,
      configuredPluginPermissionPolicy: true,
      permissionProof: { register: () => {} },
      writeDispatch: async context => {
        let originFence: Awaited<ReturnType<typeof fenceManagerOrigin>> | undefined
        try {
          const expected = f.bootstrap.permissionAccess.snapshot(context)
          const evidence = f.bootstrap.permissionAccess.evidence(context, 'configured-demo')
          const [record] = exactDomPermissionPolicies(f.profileId, [{
            id: 'configured-demo',
            entry: '/fixture.js',
            pointIds: ['manager.content'],
          }])
          const projected = {
            ...record!,
            key: { ...record!.key, identity: { ...record!.key.identity, source: evidence.identity.source } },
            policy: 'allow-persistent' as const,
          }
          const updates = f.bootstrap.permissionAccess.resolve([projected], context)
          originFence = await fenceManagerOrigin({
            sessions: f.sessions,
            participants: f.participants,
            lifecycle: f.lifecycle,
            allowAdditionalManagers: true,
          })
          const barrier = await f.bootstrap.permissionAccess.reserve(
            originFence,
            context,
            'fixture-policy',
            expected,
            updates,
            {
              isCurrent: () => true,
              adopt: () => {
                throw new Error('unexpected adoption')
              },
              release: () => false,
              fence: () => consumersFenced = true,
            },
          )
          try {
            const result = await barrier.run(async () => {
              if (change !== 'after write') {
                entered()
                await waiting
              }
              return await persistPermissionPoliciesIfUnchanged({
                configPath: f.configPath,
                profileId: f.profileId,
                expected,
                assertCurrent: async () => {
                  if (!await barrier.isCurrent()) throw new Error('fixture policy reservation is stale')
                },
              }, updates)
            })
            wrote = true
            if (change === 'after write') {
              entered()
              await waiting
              completed = await barrier.complete(result.policies)
            }
          } finally {
            await barrier.fence()
          }
          return true
        } catch (error) {
          reservationError = error
          entered()
          originFence?.fence()
          return false
        }
      },
    })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      const replacementRoot = path.join(f.root, 'replacement')
      await mkdir(replacementRoot)
      const replacement = await configuredManagerPlugin(replacementRoot, 'configured-demo', { invalidPage: true })
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      const graph = project(prepared.value.privateGraphs[0])
      expect(
        await f.call({
          action: 'complete',
          managerOrigin: origin,
          graphs: [graph],
          permissionPublicKey: {},
        }),
      ).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const polling = f.sessions.poll(f.invocation, 10_000)
      const admission = f.sessions.admit(f.invocation)
      const command = (await polling as any).value.command
      expect(command.method).toBe('synchronize')
      expect(
        await f.sessions.acknowledge(f.invocation, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { active: command.payload.active, registryEpoch: command.payload.registryEpoch },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await admission).toEqual({ status: 'ok', value: { admitted: true } })
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      await Promise.race([
        reserved,
        saving.then(result => {
          throw new Error('write ended before reservation: ' + JSON.stringify(result))
        }),
      ])
      expect(reservationError).toBeUndefined()
      // An external editor can bypass the cooperative profile lock.
      if (change !== 'archive bytes') {
        const home = JSON.parse(await readFile(f.configPath, 'utf8'))
        home.plugins[0].entry = replacement.archive
        await writeFile(f.configPath, JSON.stringify(home), { mode: 0o600 })
      } else {
        await copyFile(replacement.archive, plugin.archive)
      }
      resume()
      await saving
      if (change === 'after write') {
        expect(wrote).toBe(true)
        expect(completed).toBe(false)
        expect(consumersFenced).toBe(true)
        expect(f.lifecycle.requiresReconciliation).toBe(true)
      } else {
        expect(wrote).toBe(false)
        expect((await loadHomeConfig(f.configPath)).permissions).toEqual([])
      }
    } finally {
      resume()
      await f.close()
    }
  },
  60_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'binds configured-plugin policy targets to each admitted renderer and its verified archive',
  async () => {
    const contexts = new Map<string, ManagerRendererChannelContext>()
    const f = await fixture({
      protectProfileInputs: true,
      configuredPluginPermissionPolicy: true,
      permissionProof: { register: () => {} },
      readDispatch: async context => {
        contexts.set(context.rendererId, { ...context, admitted: true })
        return true
      },
    })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const loaded = (await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })).plugins[0]!
      const policies = exactDomPermissionPolicies(f.profileId, [{
        id: loaded.id,
        entry: loaded.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: loaded.source! } },
      }))
      await persistPermissionPolicies({ configPath: f.configPath }, policies)
      const secondId = secret()
      const secondHandle = (await f.sessions.open(f.gateway, secondId))!
      const second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
      const boot = async (invocation: typeof f.invocation) => {
        const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
        const graph = project(prepared.value.privateGraphs[0])
        const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
          action: 'complete',
          managerOrigin: origin,
          graphs: [graph],
          permissionPublicKey: {},
        }) as any
        expect(completed.status).toBe('ok')
        const bytes = await decodeManagerRendererBundle(completed.value.bundle)
        try {
          expect(bytes.toString('utf8')).toContain('standaloneConfiguredPluginPolicyReview')
        } finally {
          bytes.fill(0)
        }
        expect(await f.sessions.call(invocation, 'fixture-read', {})).toEqual({ status: 'ok', value: true })
        return contexts.get(invocation.handle.rendererId)!
      }
      const firstContext = await boot(f.invocation)
      const secondContext = await boot(second)
      const first = f.bootstrap.permissionAccess.evidence(firstContext, loaded.id)
      const other = f.bootstrap.permissionAccess.evidence(secondContext, loaded.id)
      expect(first.identity.source).not.toBe(other.identity.source)
      expect(first.moduleGeneration).not.toBe(other.moduleGeneration)
      expect(first.ownerIdentity).toEqual(other.ownerIdentity)
      expect(first.digest).toBe(other.digest)
      const projected = f.bootstrap.permissionAccess.project(policies, firstContext, loaded.id)
      expect(projected.every(policy => policy.key.identity.source === first.identity.source)).toBe(true)
      expect(f.bootstrap.permissionAccess.resolve(projected, firstContext)).toEqual(policies)
      expect(() => f.bootstrap.permissionAccess.resolve(projected, secondContext)).toThrow()
      expect(await f.sessions.close(f.invocation)).toBe(true)
      expect(f.bootstrap.permissionAccess.isCurrentEvidence(first)).toBe(false)
      expect(f.bootstrap.permissionAccess.isCurrentEvidence(other)).toBe(true)
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'projects a verified configured plugin separately into two Manager sessions',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const secondId = secret()
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const loaded = (await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })).plugins[0]!
      const policies = exactDomPermissionPolicies(f.profileId, [{
        id: loaded.id,
        entry: loaded.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: loaded.source! } },
      }))
      await persistPermissionPolicies({ configPath: f.configPath }, policies)
      const secondHandle = (await f.sessions.open(f.gateway, secondId))!
      const second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
      const boot = async (invocation: typeof f.invocation) => {
        const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
        expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [expect.any(Object)] } })
        const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
        expect((await fetch(privateGraph.entryUrl)).status).toBe(200)
        const graph = project(privateGraph)
        const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
          action: 'complete',
          managerOrigin: origin,
          graphs: [graph],
        }) as any
        expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok', initialGraphs: [graph] } })
        const bytes = await decodeManagerRendererBundle(completed.value.bundle)
        try {
          const bundle = bytes.toString('utf8')
          expect(bundle).not.toContain(plugin.source)
          expect(bundle).not.toContain(plugin.archive)
          expect(bundle).not.toContain(loaded.entry)
          const alias = bundle.match(new RegExp('https://renderer[.]cordisx[.]invalid/plugin/[a-f0-9]{64}', 'u'))?.[0]
          expect(alias).toBeDefined()
          return { alias, privateGraph }
        } finally {
          bytes.fill(0)
        }
      }
      const first = await boot(f.invocation)
      const other = await boot(second)
      expect(first.alias).not.toBe(other.alias)
      expect(first.privateGraph.moduleGeneration).not.toBe(other.privateGraph.moduleGeneration)
      expect(await f.sessions.close(f.invocation)).toBe(true)
      expect((await fetch(first.privateGraph.entryUrl)).status).toBe(404)
      expect((await fetch(other.privateGraph.entryUrl)).status).toBe(200)
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps the Manager available without exposing an unsupported configured plugin',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive, config: { token: 'fixture-private' } }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('configured-demo')
        expect(bundle).toContain('standaloneUnavailable')
        expect(bundle).not.toContain('fixture-private')
        expect(bundle).not.toContain(plugin.archive)
        expect(bundle).not.toContain(plugin.source)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps the Manager available when a configured Channel cannot be projected',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      const entry = path.join(f.root, 'direct-channel.js')
      await writeFile(entry, 'export default {}')
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'channel', entry, config: { token: 'fixture-private' } }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('standaloneUnavailable')
        expect(bundle).not.toContain('fixture-private')
        expect(bundle).not.toContain(entry)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'retires the configured graph when the owner configuration changes during admission',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [expect.any(Object)] } })
      const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
      const config = JSON.parse(await readFile(f.configPath, 'utf8'))
      config.plugins[0].enabled = false
      await writeFile(f.configPath, JSON.stringify(config))
      expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [project(privateGraph)] })).toEqual({
        status: 'unavailable',
      })
      await vi.waitFor(async () => expect((await fetch(privateGraph.entryUrl)).status).toBe(404))
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects admission if an unsupported configured plugin changes before completion',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive, config: { token: 'fixture-private' } }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive, config: { token: 'fixture-updated' } }],
      }), f.configPath)).rejects.toMatchObject({ name: 'ProfilePluginConfigFenceBusyError' })
      // Even an external writer that bypasses the normal fence must invalidate admission.
      const config = JSON.parse(await readFile(f.configPath, 'utf8'))
      config.plugins[0].config.token = 'fixture-updated'
      await writeFile(f.configPath, JSON.stringify(config))
      expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [] })).toEqual({
        status: 'unavailable',
      })
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps an installed package and a configured plugin in the same Manager session',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      expect(await f.install('installed-demo')).toMatchObject({ outcome: 'applied' })
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: expect.any(Array) } })
      const graphs: ServiceRendererPrivateGraph[] = prepared.value.privateGraphs
      expect(graphs.map(graph => graph.pluginId).sort()).toEqual(['configured-demo', 'installed-demo'])
      const completed = await f.call({
        action: 'complete',
        managerOrigin: origin,
        graphs: graphs.map(project),
      }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('configured-demo')
        expect(bundle).toContain('installed-demo')
        expect(bundle).not.toContain(plugin.archive)
        expect(bundle).not.toContain(plugin.source)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  45_000,
)

const configuredChannelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
it.skipIf(
  configuredChannelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'projects an owner-selected Channel and a configured plugin into the same Manager session',
  async () => {
    const f = await fixture({
      channelArchive: configuredChannelArchive!,
      channelUiGrant: true,
      protectProfileInputs: true,
    })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [...current.plugins, { id: 'configured-demo', entry: plugin.archive }],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: expect.any(Array) } })
      const graphs: ServiceRendererPrivateGraph[] = prepared.value.privateGraphs
      expect(graphs.map(graph => graph.pluginId).sort()).toEqual(['channel', 'configured-demo'])
      const completed = await f.call({
        action: 'complete',
        managerOrigin: origin,
        graphs: graphs.map(project),
      }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('configured-demo')
        expect(bundle).not.toContain(plugin.archive)
        expect(bundle).not.toContain(plugin.source)
        expect(bundle).not.toContain(f.configuredChannel!.plugin.source!)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  45_000,
)
