import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { transform } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { fenceManagerConsumers } from '../packages/cli/src/cli/manager-consumer-fence.js'
import {
  loadServiceRendererPackage,
  type ServiceRendererPrivateGraph,
} from '../packages/cli/src/cli/service-renderer-projection.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import * as homeConfigLoader from '../packages/cli/src/config/home-config.js'
import * as configLoader from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { createManagerRendererLifecycleClient } from '../packages/cli/src/independent-manager/lifecycle-client.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { RendererAttachmentRejected } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { backend as fixtureBackendSource } from './fixtures/service-mode-plugin.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'holds one profile permission fence until both Manager bootstraps retire',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const secondId = secret()
    const secondHandle = (await f.sessions.open(f.gateway, secondId))!
    const second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
    const policy = createPermissionPolicyRecord({
      profileId: f.profileId,
      identity: { source: 'https://example.test/plugin', id: 'fixture' },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'deny',
    })
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'prepare' })).toMatchObject({
        status: 'ok',
      })
      await expect(persistPermissionPolicies({ configPath: f.configPath }, [policy])).rejects.toThrow(
        'permission policy is in use',
      )
      const addPlugin = async () =>
        await updateHomeConfigAtomic(current => ({
          ...current,
          plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
        }), f.configPath)
      await expect(addPlugin()).rejects.toThrow('plugin configuration is in use')
      expect(await f.sessions.close(f.invocation)).toBe(true)
      await expect(persistPermissionPolicies({ configPath: f.configPath }, [policy])).rejects.toThrow(
        'permission policy is in use',
      )
      await expect(addPlugin()).rejects.toThrow('plugin configuration is in use')
      expect(await f.sessions.close(second)).toBe(true)
      await vi.waitFor(async () => await persistPermissionPolicies({ configPath: f.configPath }, [policy]))
      await vi.waitFor(addPlugin)
    } finally {
      await f.close()
    }
  },
  30_000,
)

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

it('projects an already-running managed backend into two isolated read-only renderer sessions', async () => {
  const f = await fixture({ managedBackend: true })
  const active = f.lifecycle.snapshot().active.plugins.find(item => item.id === 'fixture-service')!
  const projections = vi.spyOn(f.managedUI, 'projectInitial')
  const secondId = secret()
  let second: typeof f.invocation | undefined
  const boot = async (invocation: typeof f.invocation) => {
    const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    expect((await fetch(`${prepared.value.privateGraphs[0].baseUrl}server.mjs`)).status).toBe(404)
    const graph = project(prepared.value.privateGraphs[0])
    const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
      action: 'complete',
      managerOrigin: origin,
      graphs: [graph],
    }) as any
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    try {
      const source = bytes.toString('utf8')
      const capability = projections.mock.results.at(-1)?.value?.[0]
      if (!capability) throw new Error('manager managed-service capability is missing')
      expect(source.includes(capability.token)).toBe(true)
      expect(source.includes(f.managed.capabilities()[0]!.token)).toBe(false)
      expect(source.includes(prepared.value.privateGraphs[0].baseUrl)).toBe(false)
      expect(source.includes(invocation.handle.grant)).toBe(false)
      expect(source.includes(fixtureBackendSource)).toBe(false)
      return capability
    } finally {
      bytes.fill(0)
    }
  }
  try {
    await expect(loadServiceRendererPackage(f.homeDir, active)).rejects.toThrow(
      'renderer-projection-plugin-unsupported',
    )
    const secondHandle = await f.sessions.open(f.gateway, secondId)
    if (!secondHandle) throw new Error('second renderer unavailable')
    second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
    const first = await boot(f.invocation)
    const other = await boot(second)
    expect(first.pluginId).toBe('fixture-service')
    expect(first.token !== other.token && first.token !== f.managed.capabilities()[0]!.token).toBe(true)
    const request = (token: string, operation: string, binding?: unknown) =>
      JSON.stringify({
        version: 1,
        token,
        requestId: `fixture-${operation}`,
        operation,
        scope: { profileId: f.profileId, runtimeGeneration: f.generation, pluginGeneration: first.pluginGeneration },
        serviceId: 'gateway',
        ...(binding === undefined ? {} : { binding }),
      })
    const get = await f.sessions.call(f.invocation, 'managed-service-ui', request(first.token, 'get')) as any
    expect(get).toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
    expect(await f.sessions.call(second, 'managed-service-ui', request(first.token, 'get')))
      .toEqual({ status: 'unavailable' })
    expect(
      await f.sessions.call(
        second,
        'managed-service-ui',
        request(other.token, 'snapshot', get.value.value.service.binding),
      ),
    )
      .toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
    // Subscription requests now require the owner-issued service binding.
    expect(await f.sessions.call(second, 'managed-service-ui', request(other.token, 'subscribe')))
      .toEqual({ status: 'unavailable' })
    expect(await f.sessions.close(f.invocation)).toBe(true)
    expect(await f.sessions.call(f.invocation, 'managed-service-ui', request(first.token, 'get')))
      .toEqual({ status: 'unavailable' })
    expect(await f.sessions.call(second, 'managed-service-ui', request(other.token, 'get')))
      .toMatchObject({ status: 'ok', value: { ok: true } })
    const entered = defer<void>()
    const release = defer<void>()
    const original = f.managed.managedServiceUI.handleBindingValue
    const handler = vi.spyOn(f.managed.managedServiceUI, 'handleBindingValue').mockImplementationOnce(
      async (payload, signal) => {
        const value = await original(payload, signal)
        entered.resolve()
        await release.promise
        return value
      },
    )
    try {
      const pending = f.sessions.call(second, 'managed-service-ui', request(other.token, 'get'))
      await entered.promise
      await f.managed.dispose()
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
        .toEqual({ status: 'ok', value: { status: 'ok', current: false } })
      release.resolve()
      expect(await pending).toEqual({ status: 'unavailable' })
    } finally {
      release.resolve()
      handler.mockRestore()
    }
  } finally {
    if (second) await f.sessions.close(second).catch(() => undefined)
    await f.close()
  }
}, 90_000)

it('builds the real empty manager from the owner and admits its runtime through session synchronization', async () => {
  const f = await fixture()
  try {
    expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
    const prepared = await f.call({ action: 'prepare' }) as any
    expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
    const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
    expect(completed).toMatchObject({
      status: 'ok',
      value: { status: 'ok', initialGraphs: [], bundle: { encoding: 'brotli-base64' } },
    })
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'dangerously',
      url: origin,
    })
    try {
      Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
      Object.assign(dom.window, { TextEncoder, TextDecoder })
      // JSDOM cannot execute modules; adapt the owner's real ESM for this
      // in-process lifecycle test. Native ESM is exercised in the browser test.
      const module = await transform(bytes.toString('utf8'), { format: 'iife', globalName: '__testOwnerModule' })
      dom.window.eval(module.code)
      bytes.fill(0)
      await (dom.window as any).__testOwnerModule.startStandaloneManagerComposition(new AbortController().signal)
      await vi.waitFor(() => expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
        timeout: 10_000,
      })
      expect(dom.window.document.querySelector('[data-manager-surface="standalone"]')).not.toBeNull()
      const runtime = (dom.window as any).__cordisxRuntime
      const client = createManagerRendererLifecycleClient({
        runtime,
        scope: { profileId: f.profileId, generation: f.generation, rendererId: f.handle.rendererId },
      })
      const polling = f.sessions.poll(f.invocation, 3000)
      const admitting = f.sessions.admit(f.invocation)
      const polled = await polling as any
      expect(polled).toMatchObject({ status: 'ok', value: { command: { method: 'synchronize' } } })
      const receipt = await client.handle(polled.value.command)
      expect(receipt.ok).toBe(true)
      expect(await f.sessions.acknowledge(f.invocation, receipt)).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await admitting).toEqual({ status: 'ok', value: { admitted: true } })
      const config = createDefaultHomeConfig()
      const policy = createPermissionPolicyRecord({
        profileId: f.profileId,
        identity: { source: 'https://example.test/plugin', id: 'fixture' },
        capability: 'models.read',
        scope: { providers: ['codex'] },
        policy: 'deny',
      })
      await writeFile(f.configPath, JSON.stringify({ ...config, permissions: [policy] }))
      expect(await f.call({ action: 'status' })).toEqual({ status: 'unavailable' })
      await writeFile(f.configPath, JSON.stringify(config))
      expect(await f.call({ action: 'status' })).toEqual({ status: 'unavailable' })
      expect(await f.sessions.close(f.invocation)).toBe(false)
      expect(await f.call({ action: 'status' })).toEqual({ status: 'unavailable' })
      await client.close()
    } finally {
      bytes.fill(0)
      dom.window.close()
    }
  } finally {
    await f.close()
  }
}, 90_000)

it('waits for the actual Manager runtime to quiesce before releasing owner admission', async () => {
  const f = await fixture()
  const gate = defer<void>()
  const entered = defer<void>()
  let dom: JSDOM | undefined
  let client: ReturnType<typeof createManagerRendererLifecycleClient> | undefined
  try {
    expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
    const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [] }) as any
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'dangerously',
      url: origin,
    })
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    const module = await transform(bytes.toString('utf8'), { format: 'iife', globalName: '__testOwnerModule' })
    bytes.fill(0)
    dom.window.eval(module.code)
    await (dom.window as any).__testOwnerModule.startStandaloneManagerComposition(new AbortController().signal)
    await vi.waitFor(() => expect(dom!.window.document.documentElement.dataset.cordisxReady).toBe('true'))
    client = createManagerRendererLifecycleClient({
      runtime: (dom.window as any).__cordisxRuntime,
      scope: { profileId: f.profileId, generation: f.generation, rendererId: f.handle.rendererId },
      onQuiesce: async () => {
        entered.resolve()
        await gate.promise
        return true
      },
    })
    const polling = f.sessions.poll(f.invocation, 3000)
    const admitting = f.sessions.admit(f.invocation)
    const synchronize = await polling as any
    expect(synchronize.value.command.method).toBe('synchronize')
    expect((await f.sessions.acknowledge(f.invocation, await client.handle(synchronize.value.command))).status).toBe(
      'ok',
    )
    expect((await admitting).status).toBe('ok')

    const quiescence = fenceManagerConsumers({
      sessions: f.sessions,
      participants: f.participants,
      lifecycle: f.lifecycle,
    })
    void quiescence.catch(() => {})
    const polled = await f.sessions.poll(f.invocation, 3000) as any
    expect(polled.value.command.method).toBe('quiesce')
    let settled = false
    const handling = client.handle(polled.value.command).then(value => {
      settled = true
      return value
    })
    await entered.promise
    expect(settled).toBe(false)
    expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
    gate.resolve()
    const receipt = await handling
    expect(receipt.ok).toBe(true)
    expect(dom.window.document.querySelector('[data-manager-surface="standalone"]')).toBeNull()
    expect((await f.sessions.acknowledge(f.invocation, receipt)).status).toBe('ok')
    expect(await f.sessions.close(f.invocation)).toBe(true)
    const lease = await quiescence
    expect(lease.isCurrent()).toBe(true)
    expect(() => f.lifecycle.prepare('blocked-while-fenced')).toThrow('service renderer fence is active')
    expect(f.lifecycle.snapshot().active.profileId).toBe(f.profileId)
    expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
    expect(lease.release()).toBe(true)
    expect(await f.sessions.open(f.gateway, secret())).toBeDefined()
  } finally {
    gate.resolve()
    await client?.close()
    dom?.window.close()
    await f.close()
  }
}, 90_000)

it(
  'projects a real package graph using only the sidecar alias and retires the private lease on disconnect',
  async () => {
    const f = await fixture()
    try {
      expect(await f.install('graph-fixture')).toMatchObject({ outcome: 'applied', revision: 1 })
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared.status).toBe('ok')
      const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
      expect((await fetch(privateGraph.entryUrl)).status).toBe(200)
      const graph = project(privateGraph)
      expect(graph.leaseId).not.toBe(privateGraph.leaseId)
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [graph] }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok', initialGraphs: [graph] } })
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        const text = bytes.toString('utf8')
        expect(text).toContain(graph.entryUrl)
        expect(text).not.toContain(privateGraph.baseUrl)
        expect(text).not.toContain(privateGraph.leaseId)
        expect(text).not.toContain(f.handle.grant)
      } finally {
        bytes.fill(0)
      }
      expect(await f.sessions.close(f.invocation)).toBe(true)
      expect((await fetch(privateGraph.entryUrl)).status).toBe(404)
    } finally {
      await f.close()
    }
  },
  90_000,
)

it('rejects a forged projected path and removes the owner lease', async () => {
  const f = await fixture()
  try {
    expect(await f.install('graph-fixture')).toMatchObject({ outcome: 'applied' })
    const prepared = await f.call({ action: 'prepare' }) as any
    const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
    const graph = project(privateGraph)
    expect(
      await f.call({
        action: 'complete',
        managerOrigin: origin,
        graphs: [{ ...graph, entryUrl: `${graph.baseUrl}other.js` }],
      }),
    ).toEqual({ status: 'unavailable' })
    expect((await fetch(privateGraph.entryUrl)).status).toBe(404)
  } finally {
    await f.close()
  }
}, 30_000)

it('retires a failed bootstrap before accepting new reads or renderer sessions', async () => {
  const entered = defer<void>()
  const release = defer<void>()
  let reads = 0
  const f = await fixture({
    protectProfileInputs: true,
    readDispatch: async () => {
      reads++
      if (reads === 1) {
        entered.resolve()
        await release.promise
      }
      return 'read complete'
    },
  })
  try {
    expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
    const reading = f.sessions.call(f.invocation, 'fixture-read', {})
    await entered.promise
    expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [{}] })).toEqual({
      status: 'unavailable',
    })
    expect(await f.sessions.call(f.invocation, 'fixture-read', {})).toEqual({ status: 'unavailable' })
    expect(reads).toBe(1)
    expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
    release.resolve()
    expect(await reading).toEqual({ status: 'unavailable' })
    expect(await f.sessions.revoke(f.gateway, f.invocation.browserSessionId)).toBe(true)
    const browserSessionId = secret()
    const handle = await f.sessions.open(f.gateway, browserSessionId)
    expect(handle).toBeDefined()
    const next = { gateway: f.gateway, browserSessionId, handle: handle! }
    expect(await f.sessions.call(next, 'manager-bootstrap', { action: 'prepare' })).toMatchObject({ status: 'ok' })
  } finally {
    release.resolve()
    await f.close()
  }
}, 30_000)

it('refuses a stale composition and retires its initial graph after the authority changes', async () => {
  const f = await fixture()
  try {
    expect(await f.install('first-graph')).toMatchObject({ outcome: 'applied', revision: 1 })
    const prepared = await f.call({ action: 'prepare' }) as any
    const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
    expect((await fetch(privateGraph.entryUrl)).status).toBe(200)
    expect(await f.install('second-graph', 1)).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [project(privateGraph)] })).toEqual({
      status: 'unavailable',
    })
    expect((await fetch(privateGraph.entryUrl)).status).toBe(404)
    // A failed bootstrap revokes the old session; recovery needs a fresh one.
    expect(await f.call({ action: 'status' })).toEqual({ status: 'unavailable' })
  } finally {
    await f.close()
  }
}, 30_000)

it('keeps configured plugins and their private configuration outside the bootstrap', async () => {
  const f = await fixture()
  try {
    const entry = path.join(f.root, 'configured-fixture.mjs')
    const privateValue = `fixture-private-${secret()}`
    await writeFile(entry, 'export function apply() {}')
    await writeFile(
      f.configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        plugins: [{ id: 'configured-fixture', entry, enabled: true, config: { token: privateValue } }],
      }),
    )
    const result = await f.call({ action: 'prepare' })
    expect(result).toEqual({ status: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain(privateValue)
  } finally {
    await f.close()
  }
}, 30_000)

const configuredChannelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
it.skipIf(
  configuredChannelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'refuses a configured Channel when the live owner identity differs',
  async () => {
    const f = await fixture({
      channelArchive: configuredChannelArchive!,
      channelOwnerMismatch: true,
      protectProfileInputs: true,
    })
    try {
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
  'projects the owner-selected Channel into isolated read-only renderer sessions',
  async () => {
    const f = await fixture({
      channelArchive: configuredChannelArchive!,
      channelUiGrant: true,
      protectProfileInputs: true,
    })
    const secondId = secret()
    let second: typeof f.invocation | undefined
    let recovered: typeof f.invocation | undefined
    const boot = async (invocation: typeof f.invocation) => {
      const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [expect.any(Object)] } })
      const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
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
        const alias = bundle.match(new RegExp('https://renderer[.]cordisx[.]invalid/plugin/[a-f0-9]{64}', 'u'))?.[0]
        expect(alias).toBeDefined()
        expect(bundle).not.toContain(f.configuredChannel!.plugin.source!)
        expect(bundle).not.toContain(f.configuredChannel!.plugin.entry)
        expect(bundle).not.toContain('fixture-private-reference')
        expect(bundle).not.toContain(privateGraph.baseUrl)
        expect(bundle).not.toContain(invocation.handle.grant)
        return { alias, privateGraph }
      } finally {
        bytes.fill(0)
      }
    }
    const admit = async (invocation: typeof f.invocation) => {
      const polling = f.sessions.poll(invocation, 3000)
      const admitting = f.sessions.admit(invocation)
      const polled = await polling as any
      expect(polled).toMatchObject({ status: 'ok', value: { command: { method: 'synchronize' } } })
      const command = polled.value.command
      const payload = command.payload
      expect(
        await f.sessions.acknowledge(invocation, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { active: payload.active, registryEpoch: payload.registryEpoch },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await admitting).toEqual({ status: 'ok', value: { admitted: true } })
    }
    const snapshot = (id: string, action = 'snapshot') =>
      JSON.stringify({
        version: 1,
        token: 'renderer-binding-placeholder',
        requestId: id,
        action,
      })
    try {
      const secondHandle = (await f.sessions.open(f.gateway, secondId))!
      second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
      const first = await boot(f.invocation)
      const other = await boot(second)
      expect(first.alias).not.toBe(other.alias)
      expect(first.privateGraph.moduleGeneration).not.toBe(other.privateGraph.moduleGeneration)
      await admit(f.invocation)
      await admit(second)
      const response = await f.sessions.call(f.invocation, 'channel-actions', snapshot('first'))
      expect(response).toMatchObject({
        status: 'ok',
        value: {
          ok: true,
          value: { status: 'applied', projection: { accounts: expect.arrayContaining([expect.any(Object)]) } },
        },
      })
      expect(JSON.stringify(response)).not.toContain('fixture-private-reference')
      expect(await f.sessions.call(f.invocation, 'channel-actions', snapshot('write', 'enable')))
        .toEqual({ status: 'unavailable' })
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, enabled: false })),
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      expect(await f.sessions.close(f.invocation)).toBe(true)
      expect((await fetch(first.privateGraph.entryUrl)).status).toBe(404)
      expect(await f.sessions.call(second, 'channel-actions', snapshot('second')))
        .toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'applied' } } })
      const service = f.configuredChannel!.service
      const restart = await service.restart(f.configuredChannel!.configuration, service.generation())
      await restart.finalize()
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' })).toEqual({
        status: 'unavailable',
      })
      expect(await f.sessions.call(second, 'channel-actions', snapshot('stale'))).toEqual({ status: 'unavailable' })
      expect(await f.sessions.revoke(f.gateway, second.browserSessionId)).toBe(true)
      second = undefined
      const recoveredId = secret()
      const recoveredHandle = (await f.sessions.open(f.gateway, recoveredId))!
      recovered = { gateway: f.gateway, browserSessionId: recoveredId, handle: recoveredHandle }
      const renewed = await boot(recovered)
      expect(renewed.alias).not.toBe(other.alias)
      await admit(recovered)
      expect(await f.sessions.call(recovered, 'channel-actions', snapshot('recovered')))
        .toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'applied' } } })
      expect(await f.sessions.close(recovered)).toBe(true)
      recovered = undefined
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, enabled: false })),
      }), f.configPath)
    } finally {
      if (second) await f.sessions.close(second).catch(() => undefined)
      if (recovered) await f.sessions.close(recovered).catch(() => undefined)
      await f.close()
    }
  },
  90_000,
)

it('retires a late graph lease when the session is revoked during prepare', async () => {
  const f = await fixture({ delayLease: true })
  try {
    expect(await f.install('late-lease')).toMatchObject({ outcome: 'applied' })
    const pending = f.call({ action: 'prepare' })
    const lease = await f.leaseReady.promise
    expect((await fetch(lease.entryUrl)).status).toBe(200)
    const closing = f.sessions.close(f.invocation)
    f.releaseLease.resolve()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(await closing).toBe(true)
    expect((await fetch(lease.entryUrl)).status).toBe(404)
  } finally {
    await f.close()
  }
}, 30_000)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'holds profile fences until an in-flight configuration check retires',
  async () => {
    const f = await fixture({ protectProfileInputs: true })
    const entered = defer<void>()
    const release = defer<void>()
    const loadConfig = configLoader.loadConfig
    let spy: ReturnType<typeof vi.spyOn> | undefined
    let policySpy: ReturnType<typeof vi.spyOn> | undefined
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      spy = vi.spyOn(configLoader, 'loadConfig').mockImplementation(async (...args) => {
        entered.resolve()
        await release.promise
        return await loadConfig(...args)
      })
      policySpy = vi.spyOn(homeConfigLoader, 'loadHomeConfig').mockRejectedValueOnce(new Error('fixture read failed'))
      let checked = false
      const checking = f.call({ action: 'status' }).then(result => {
        checked = true
        return result
      })
      await entered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(checked).toBe(false)
      let closed = false
      const closing = f.sessions.close(f.invocation).then(result => {
        closed = true
        return result
      })
      let bootstrapClosed = false
      const closingBootstrap = f.bootstrap.close().then(result => {
        bootstrapClosed = true
        return result
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(bootstrapClosed).toBe(false)
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      release.resolve()
      expect(await checking).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      expect(await closingBootstrap).toBe(true)
    } finally {
      release.resolve()
      spy?.mockRestore()
      policySpy?.mockRestore()
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'holds profile fences until a disconnected renderer read settles',
  async () => {
    const entered = defer<void>()
    const release = defer<void>()
    const f = await fixture({
      protectProfileInputs: true,
      readDispatch: async () => {
        entered.resolve()
        await release.promise
        return 'read complete'
      },
    })
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      const reading = f.sessions.call(f.invocation, 'fixture-read', {})
      await entered.promise
      let closed = false
      const closing = f.sessions.close(f.invocation).then(result => {
        closed = true
        return result
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      release.resolve()
      expect(await reading).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)
    } finally {
      release.resolve()
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'waits for a late bootstrap and profile locks before acknowledging renderer retirement',
  async () => {
    const f = await fixture({ delayLease: true, protectProfileInputs: true })
    try {
      expect(await f.install('late-protected-lease')).toMatchObject({ outcome: 'applied' })
      const pending = f.call({ action: 'prepare' })
      const lease = await f.leaseReady.promise
      const closing = f.sessions.close(f.invocation)
      await vi.waitFor(() => expect(f.sessions.hasLiveRenderers()).toBe(true))
      expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      f.releaseLease.resolve()
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      expect((await fetch(lease.entryUrl)).status).toBe(404)
      expect(await f.sessions.open(f.gateway, secret())).toBeDefined()
    } finally {
      f.releaseLease.resolve()
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'retains profile locks until a disconnected renderer write has finished',
  async () => {
    const started = defer<void>()
    const finish = defer<void>()
    const f = await fixture({
      protectProfileInputs: true,
      writeDispatch: async () => {
        started.resolve()
        await finish.promise
        return 'possibly committed'
      },
    })
    const addPlugin = async () =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      const write = f.sessions.call(f.invocation, 'fixture-write', {})
      await started.promise
      const closing = f.sessions.close(f.invocation)
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(addPlugin()).rejects.toThrow('plugin configuration is in use')
      expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
      finish.resolve()
      expect(await write).toEqual({ status: 'unknown' })
      expect(await closing).toBe(false)
      await addPlugin()
      expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
    } finally {
      finish.resolve()
      await f.close()
    }
  },
  30_000,
)

it('uses the owner projector for a real staged package after an authenticated renderer is admitted', async () => {
  const f = await fixture()
  let pump: Promise<void> | undefined
  try {
    expect(await f.install('live-graph')).toMatchObject({ outcome: 'applied', revision: 1 })
    const prepared = await f.call({ action: 'prepare' }) as any
    const original: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
    expect((await fetch(original.entryUrl)).status).toBe(200)
    expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [project(original)] })).toMatchObject({
      status: 'ok',
    })
    let current: any = f.lifecycle.snapshot().active
    let epoch = f.lifecycle.snapshot().registryEpoch
    let staged: any
    let rejectNextPublish = true
    const stages: any[] = []
    const methods: string[] = []
    const peer = f.participants.peer(f.handle.rendererId)!
    const originalRequest = peer.request.bind(peer)
    vi.spyOn(peer, 'request').mockImplementation(async (method, payload) => {
      const value = await originalRequest(method, payload)
      // Inject a definite owner-observed rejection after this fixture renderer
      // has published, so rollback must preserve the previous real graph.
      if (method === 'publish' && rejectNextPublish) {
        rejectNextPublish = false
        throw new RendererAttachmentRejected()
      }
      return value
    })
    pump = (async () => {
      while (true) {
        const response = await f.sessions.poll(f.invocation, 2000) as any
        if (response.status !== 'ok') return
        const command = response.value.command
        if (!command) continue
        const payload = command.payload
        methods.push(command.method)
        let value: unknown
        if (command.method === 'synchronize') {
          current = payload.active
          epoch = payload.registryEpoch
          value = { active: current, registryEpoch: epoch }
        } else if (command.method === 'prepare') value = payload
        else if (command.method === 'stage') {
          staged = payload
          stages.push(payload)
          value = {
            transactionId: payload.transactionId,
            transactionEpoch: payload.transactionEpoch,
            expectedRegistryEpoch: payload.expectedRegistryEpoch,
            afterRegistryEpoch: payload.afterRegistryEpoch,
            observation: payload.candidate,
            affectedPluginIds: payload.affectedPluginIds,
          }
        } else if (command.method === 'publish') {
          current = staged.candidate
          epoch = staged.afterRegistryEpoch
          value = {
            transactionId: staged.transactionId,
            transactionEpoch: staged.transactionEpoch,
            registryEpoch: epoch,
            active: current,
          }
        } else if (command.method === 'complete') {
          value = {
            transactionId: staged.transactionId,
            transactionEpoch: staged.transactionEpoch,
            registryEpoch: epoch,
            active: current,
            disposedAfter: staged.previous,
          }
        } else if (command.method === 'rollback') {
          current = staged.previous
          epoch = staged.afterRegistryEpoch + 1
          value = payload.expected
        } else if (command.method === 'finalize') {
          const { transactionId: _discard, ...candidate } = staged.candidate
          void _discard
          current = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
          value = { transactionId: payload.transactionId }
        } else throw new Error('unexpected lifecycle command')
        await f.sessions.acknowledge(f.invocation, { id: command.id, sequence: command.sequence, ok: true, value })
      }
    })()
    expect(await f.sessions.admit(f.invocation)).toEqual({ status: 'ok', value: { admitted: true } })
    expect(await f.install('live-graph', 1, false, 'export const revision = 2; export function apply() {}'))
      .toMatchObject({ outcome: 'rolled-back' })
    expect(methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'rollback', 'synchronize'])
    expect((await fetch(original.entryUrl)).status).toBe(200)
    expect((await fetch(stages[0].privateGraphs[0].entryUrl)).status).toBe(404)
    methods.length = 0
    stages.length = 0
    const revision = f.lifecycle.snapshot().active.revision
    expect(await f.install('live-graph', revision, false, 'export const revision = 3; export function apply() {}'))
      .toMatchObject({ outcome: 'applied', revision: revision + 1 })
    expect(methods).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatchObject({
      rendererId: f.handle.rendererId,
      targetId: 'live-graph',
      privateGraphs: [{ pluginId: 'live-graph' }],
      package: { manifest: { id: 'live-graph' } },
    })
    expect(stages[0]).not.toHaveProperty('runtimeArtifactLease')
    expect(stages[0]).not.toHaveProperty('runtimeArtifactSource')
    // The prior per-session bootstrap lease is released only after the
    // replacement was finalized by every participating renderer.
    expect((await fetch(original.entryUrl)).status).toBe(404)
    expect((await fetch(stages[0].privateGraphs[0].entryUrl)).status).toBe(200)
    expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
    expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [project(original)] })).toEqual({
      status: 'unavailable',
    })
    expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
    expect(await f.sessions.close(f.invocation)).toBe(true)
    await pump
    expect((await fetch(stages[0].privateGraphs[0].entryUrl)).status).toBe(404)
  } finally {
    await f.close()
    await pump
  }
}, 60_000)

it('rejects capability-bearing packages before issuing bootstrap graphs', async () => {
  const f = await fixture()
  try {
    expect(await f.install('unsupported-capability', 0, true)).toMatchObject({ outcome: 'applied' })
    expect(await f.call({ action: 'prepare' })).toEqual({ status: 'unavailable' })
  } finally {
    await f.close()
  }
}, 30_000)
