import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { type ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
function project(graph: ServiceRendererPrivateGraph) {
  const baseUrl = origin + '/api/renderer/graphs/' + secret() + '/'
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
  'shows a disabled configured plugin without exposing its configuration or granting lifecycle actions',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const entry = path.join(f.root, 'disabled-plugin.mjs')
    const privateValue = `fixture-private-${secret()}`
    const source = pathToFileURL(entry).href
    const configured = { id: 'disabled-fixture', entry, enabled: false, config: { token: privateValue } }
    try {
      await writeFile(entry, 'throw new Error("disabled plugin must not load")')
      await writeFile(f.configPath, JSON.stringify({ ...createDefaultHomeConfig(), plugins: [configured] }))
      await persistPermissionPolicies({ configPath: f.configPath }, [createPermissionPolicyRecord({
        profileId: f.profileId,
        identity: { source, id: configured.id },
        capability: 'models.read',
        scope: { providers: ['codex'] },
        policy: 'deny',
      })])
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain(configured.id)
        expect(bundle).not.toContain(privateValue)
        expect(bundle).not.toContain(entry)
        expect(bundle).not.toContain(source)
      } finally {
        bytes.fill(0)
      }
      await writeFile(
        f.configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{ ...configured, config: { token: `${privateValue}-changed` } }],
        }),
      )
      expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [] })).toEqual({
        status: 'unavailable',
      })
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps installed package graphs available alongside disabled configuration',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const entry = path.join(f.root, 'disabled-plugin.mjs')
    const privateValue = `fixture-private-${secret()}`
    try {
      expect(await f.install('installed-fixture')).toMatchObject({ outcome: 'applied' })
      await writeFile(
        f.configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{ id: 'disabled-fixture', entry, enabled: false, config: { token: privateValue } }],
        }),
      )
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [expect.any(Object)] } })
      const graph = project(prepared.value.privateGraphs[0])
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [graph] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok', initialGraphs: [graph] } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('installed-fixture')
        expect(bundle).toContain('disabled-fixture')
        expect(bundle).not.toContain(privateValue)
        expect(bundle).not.toContain(entry)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects a configured plugin that conflicts with an installed package',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    try {
      expect(await f.install('disabled-collision')).toMatchObject({ outcome: 'applied' })
      await writeFile(
        f.configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{ id: 'disabled-collision', entry: path.join(f.root, 'disabled.mjs'), enabled: false }],
        }),
      )
      expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'isolates an unsupported enabled configured plugin without exposing its configuration',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const entry = path.join(f.root, 'unsupported.mjs')
    const privateValue = `fixture-private-${secret()}`
    try {
      await writeFile(
        f.configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{ id: 'unsupported', entry, enabled: true, config: { token: privateValue } }],
        }),
      )
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('unsupported')
        expect(bundle).toMatch(/standaloneUnavailable\s*:\s*(?:true|!0)/u)
        expect(bundle).not.toContain(entry)
        expect(bundle).not.toContain(privateValue)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  30_000,
)

const configuredChannelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
it.skipIf(
  configuredChannelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'does not report a still-running Channel as disabled after its configuration changes',
  async () => {
    const f = await fixture({ channelArchive: configuredChannelArchive!, protectProfileInputs: true })
    try {
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, enabled: false })),
      }), f.configPath)
      expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
      expect(f.configuredChannel!.service.generation()).toEqual(expect.any(String))
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(
  configuredChannelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'projects the owner-selected Channel alongside a disabled configured plugin',
  async () => {
    const f = await fixture({
      channelArchive: configuredChannelArchive!,
      channelUiGrant: true,
      protectProfileInputs: true,
    })
    const entry = path.join(f.root, 'disabled-plugin.mjs')
    const privateValue = `fixture-private-${secret()}`
    try {
      await writeFile(entry, 'throw new Error("disabled plugin must not load")')
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{
          id: 'disabled-fixture',
          entry,
          enabled: false,
          config: { token: privateValue },
        }, ...current.plugins],
      }), f.configPath)
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [expect.any(Object)] } })
      const graph = project(prepared.value.privateGraphs[0])
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [graph] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok', initialGraphs: [graph] } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const bundle = bytes.toString('utf8')
        expect(bundle).toContain('disabled-fixture')
        expect(bundle).not.toContain(privateValue)
        expect(bundle).not.toContain(entry)
        expect(bundle).not.toContain(f.configuredChannel!.plugin.source!)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  30_000,
)
