import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { transform } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { ServiceRendererBootstrap } from '../packages/cli/src/cli/service-renderer-bootstrap.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import {
  createServiceRendererProjector,
  loadServiceRendererPackage,
  type ServiceRendererPrivateGraph,
} from '../packages/cli/src/cli/service-renderer-projection.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { createManagerRendererLifecycleClient } from '../packages/cli/src/independent-manager/lifecycle-client.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import {
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  attachmentHomeDigest,
  RendererAttachmentRejected,
} from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { decision, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'
import { backend as fixtureBackendSource, stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

async function fixture(options: { delayLease?: boolean; managedBackend?: boolean } = {}) {
  const root = await mkdtemp('/tmp/cx-service-bootstrap-')
  const homeDir = path.join(root, 'home')
  const configPath = path.join(homeDir, 'config.json')
  await mkdir(homeDir, { recursive: true })
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
  const profileId = 'default'
  const generation = 'fixture-owner'
  if (options.managedBackend) {
    await stageServiceModePlugin(
      root,
      homeDir,
      profileId,
      true,
      'https://example.test/fixtures',
      `export const inject = ['managedServices'];
       export async function apply(ctx) {
         const result = await ctx.managedServices.get({ serviceId: 'gateway' });
         globalThis.__fixtureManagedStatus = result.status;
         if (result.status === 'available') globalThis.__fixtureManagedSnapshot = (await result.service.snapshot()).status;
       }`,
    )
  }
  const scope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: 'codex', profileId, generation }
  const participants = new ServiceRendererParticipants(scope)
  const leaseReady = defer<PluginGenerationGraphLease>()
  const releaseLease = defer<void>()
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    projectMutation: createServiceRendererProjector({
      homeDir,
      profileId,
      generation,
      isLive: identity => participants.isLive(identity),
    }),
    async createArtifactServer() {
      const server = await startPluginGenerationArtifactServer()
      return {
        origin: server.origin,
        close: async () => await server.close(),
        requestTrace: () => server.requestTrace(),
        async lease(...args) {
          const lease = await server.lease(...args)
          if (options.delayLease) {
            leaseReady.resolve(lease)
            await releaseLease.promise
          }
          return lease
        },
      }
    },
  })
  participants.bind(lifecycle)
  const store = new PluginActivationStore(homeDir, profileId, generation)
  const managed = createProductionManagedServiceLifecycle({
    runtime: lifecycle,
    homeDir,
    profileId,
    generation,
    environment: { PATH: process.env.PATH, HOME: root },
    store,
    dryRun: false,
    requireOwnedProcess: true,
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: managed,
    headless: true,
  })
  await coordinator.recover()
  lifecycle.initialize(await store.bindRuntimeGeneration())
  const startup = await managed.initialize(await store.loadActive())
  await Promise.all([startup.coreReady, startup.adopted])
  await vi.waitFor(() => expect(managed.readManagedServiceUIFence()).toEqual(expect.any(Number)))
  const managedUI = createManagerManagedServiceUIBridge({
    profileId,
    runtimeGeneration: generation,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    readLifecycleFence: () => managed.readManagedServiceUIFence(),
    runtime: managed,
  })
  const bootstrap = new ServiceRendererBootstrap({
    homeDir,
    configPath,
    appId: 'codex',
    profileId,
    generation,
    lifecycle,
    participants,
    store,
    managedServiceUI: managedUI,
  })
  const gateway = { pid: process.pid, processStartedAt: 'fixture', instanceToken: secret() }
  const sessions = new ManagerRendererSessions({
    profileId,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    participant: participants.participant,
    channels: new Map([
      ['manager-bootstrap', bootstrap.channel()],
      ['managed-service-ui', managedUI.channel],
    ]),
  })
  const browserSessionId = secret()
  const handle = (await sessions.open(gateway, browserSessionId))!
  const invocation = { gateway, browserSessionId, handle }
  async function call(payload: unknown) {
    return await sessions.call(invocation, 'manager-bootstrap', payload)
  }
  async function install(id: string, revision = 0, requiredCapability = false, code?: string) {
    const sourceDirectory = await localPackage({ root, id, requiredCapability, code })
    const plan = await coordinator.handle({
      ...request({ kind: 'inspect-local', sourceDirectory }, revision, generation),
      profileId,
    })
    expect(plan, JSON.stringify(plan)).toMatchObject({ outcome: 'planned', candidateId: expect.any(String) })
    return await coordinator.handle(
      {
        ...request(
          {
            kind: plan.operation === 'update' ? 'update' : 'install',
            candidateId: plan.candidateId!,
            authorizationDecision: decision(plan.authorizationPlan!),
          },
          revision,
          generation,
        ),
        profileId,
      },
    )
  }
  return {
    root,
    homeDir,
    configPath,
    profileId,
    generation,
    lifecycle,
    managed,
    managedUI,
    gateway,
    participants,
    sessions,
    invocation,
    handle,
    call,
    install,
    leaseReady,
    releaseLease,
    async close() {
      releaseLease.resolve()
      sessions.dispose()
      bootstrap.close()
      managedUI.dispose()
      participants.close()
      await lifecycle.close()
      await managed.dispose()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    },
  }
}

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
    expect(await f.sessions.call(second, 'managed-service-ui', request(other.token, 'subscribe')))
      .toEqual({ status: 'ok', value: { requestId: 'fixture-subscribe', ok: false, code: 'unsupported' } })
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
    // Rebinding still authenticates the live session; a fresh bootstrap is
    // required before that session can be admitted to the new composition.
    expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
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

it('retires a late graph lease when the session is revoked during prepare', async () => {
  const f = await fixture({ delayLease: true })
  try {
    expect(await f.install('late-lease')).toMatchObject({ outcome: 'applied' })
    const pending = f.call({ action: 'prepare' })
    const lease = await f.leaseReady.promise
    expect((await fetch(lease.entryUrl)).status).toBe(200)
    expect(await f.sessions.close(f.invocation)).toBe(true)
    f.releaseLease.resolve()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect((await fetch(lease.entryUrl)).status).toBe(404)
  } finally {
    await f.close()
  }
}, 30_000)

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
