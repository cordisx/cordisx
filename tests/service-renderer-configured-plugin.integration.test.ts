import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import type { ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
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
  'keeps configured plugin values private until their configuration bridge exists',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      const plugin = await configuredManagerPlugin(f.root)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'configured-demo', entry: plugin.archive, config: { token: 'fixture-private' } }],
      }), f.configPath)
      const result = await f.call({ action: 'prepare' })
      expect(result).toEqual({ status: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain('fixture-private')
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
