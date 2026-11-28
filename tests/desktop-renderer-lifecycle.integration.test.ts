import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { DesktopRendererLifecycle } from '../packages/cli/src/launcher/desktop-renderer-lifecycle.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  type AttachedRendererPeer,
  attachmentHomeDigest,
  RendererAttachmentRejected,
} from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

const secret = () => randomBytes(32).toString('hex')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

async function fixture(
  options: {
    blockProjection?: () => Promise<void>
    blockSynchronize?: () => Promise<void>
    rejectPublish?: boolean
    disconnectOnStage?: boolean
    disconnectOnFinalize?: boolean
    invalidFinalize?: boolean
    desktopCount?: number
    dependent?: boolean
  } = {},
) {
  const root = await mkdtemp('/tmp/cx-desktop-barrier-')
  const home = path.join(root, 'home')
  const generation = 'runtime-1'
  const scope = { homeDigest: attachmentHomeDigest(home), ownerAppId: 'codex', profileId: 'work', generation }
  // Set up durable activation before opening the new owner; no two owners run concurrently.
  const seed = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: new FormalRuntime(),
    headless: true,
  })
  const sourceDirectory = await localPackage({ root, id: 'fixture-plugin' })
  const plan = await seed.handle(request({ kind: 'inspect-local', sourceDirectory }))
  expect(
    await seed.handle(
      request({
        kind: 'install',
        candidateId: plan.candidateId!,
        authorizationDecision: decision(plan.authorizationPlan!),
      }),
    ),
  ).toMatchObject({ outcome: 'applied' })
  if (options.dependent) {
    const dependent = await localPackage({
      root,
      id: 'fixture-dependent',
      dependencies: [{ id: 'fixture-plugin', version: '1.0.0' }],
    })
    const planned = await seed.handle(request({ kind: 'inspect-local', sourceDirectory: dependent }, 1))
    expect(
      await seed.handle(request({
        kind: 'install',
        candidateId: planned.candidateId!,
        authorizationDecision: decision(planned.authorizationPlan!),
      }, 1)),
    ).toMatchObject({ outcome: 'applied', revision: 2 })
  }
  const store = new PluginActivationStore(home, 'work', generation)
  const active = await store.bindRuntimeGeneration()
  const plugins = await loadPluginComposition(store, active)
  const bundle = await buildRendererBundle({
    version: 1,
    rootDir: process.cwd(),
    codex: { debugPort: 9229 },
    providers: [],
    plugins,
  }, { profileId: 'work', generation, pluginActivation: active, permission: { profileId: 'work', policies: [] } })
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'https://desktop.invalid/',
  })
  Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
  Object.assign(dom.window, { TextEncoder, TextDecoder })
  dom.window.eval(bundle)
  await vi.waitFor(() => expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
    timeout: 10_000,
  })
  const desktop = (dom.window as any).__cordisxRuntime
  const cdp = new CdpPluginLifecycleRuntime()
  const calls: string[] = []
  const stageEpochs: string[] = []
  const desktopImpacts: unknown[] = []
  const managerImpacts: unknown[] = []
  const cdpSession = {
    async send(_method: string, params: Record<string, unknown>) {
      const expression = String(params.expression ?? '')
      for (const method of ['stage', 'publish', 'complete', 'finalize', 'rollback']) {
        if (expression.includes(`${method}PluginMutation`)) calls.push(`desktop:${method}`)
      }
      if (expression.includes('stagePluginMutation')) {
        stageEpochs.push(expression.match(/"transactionEpoch":"([^"]+)"/u)?.[1] ?? '')
      }
      try {
        const value = await dom.window.eval(expression)
        if (expression.includes('stagePluginMutation')) desktopImpacts.push(value?.result?.affectedPluginIds)
        const serialized = JSON.stringify(value)
        return { result: { value: serialized === undefined ? undefined : JSON.parse(serialized) } }
      } catch (error) {
        return { exceptionDetails: { text: error instanceof Error ? error.message : String(error) } }
      }
    },
  }
  const unregister = cdp.register(cdpSession as never)
  let extraDom: JSDOM | undefined
  let extraDesktop: any
  let extraSession: typeof cdpSession | undefined
  let unregisterExtra: (() => void) | undefined
  if (options.desktopCount === 2) {
    extraDom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'dangerously',
      url: 'https://desktop.invalid/',
    })
    Object.defineProperty(extraDom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(extraDom.window, { TextEncoder, TextDecoder })
    extraDom.window.eval(bundle)
    await vi.waitFor(() => expect(extraDom!.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
      timeout: 10_000,
    })
    extraDesktop = (extraDom.window as any).__cordisxRuntime
    extraSession = {
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) {
          stageEpochs.push(expression.match(/"transactionEpoch":"([^"]+)"/u)?.[1] ?? '')
        }
        try {
          const value = await extraDom!.window.eval(expression)
          if (expression.includes('stagePluginMutation')) desktopImpacts.push(value?.result?.affectedPluginIds)
          const serialized = JSON.stringify(value)
          return { result: { value: serialized === undefined ? undefined : JSON.parse(serialized) } }
        } catch (error) {
          return { exceptionDetails: { text: error instanceof Error ? error.message : String(error) } }
        }
      },
    }
    unregisterExtra = cdp.register(extraSession as never)
  }
  const lifecycle = new DesktopRendererLifecycle({
    scope,
    cdp,
    active,
    registryEpoch: 0,
    async projectManagerMutation(mutation, identity) {
      await options.blockProjection?.()
      if (mutation.transactionEpoch?.endsWith(':preflight')) return undefined
      return {
        rendererId: identity.rendererId,
        transactionId: mutation.transactionId,
        transactionEpoch: mutation.transactionEpoch,
        expectedRegistryEpoch: mutation.expectedRegistryEpoch,
        afterRegistryEpoch: mutation.afterRegistryEpoch,
        operation: mutation.operation,
        previous: mutation.previous,
        candidate: mutation.candidate,
        targetId: mutation.targetId,
        affectedPluginIds: mutation.affectedPluginIds,
      }
    },
  })
  const managed = createProductionManagedServiceLifecycle({
    runtime: new PlatformProviderPluginLifecycleRuntime(lifecycle),
    homeDir: home,
    profileId: 'work',
    generation,
    environment: { PATH: process.env.PATH, HOME: root },
    store,
    dryRun: false,
    requireOwnedProcess: true,
  })
  await (await managed.initialize(active)).coreReady
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: managed,
  })
  const peers: Array<{ peer: ManagerRendererCommandPeer; task: Promise<void>; methods: string[] }> = []
  async function attach(id = 'manager') {
    const peer = new ManagerRendererCommandPeer({
      scope,
      identity: {
        appId: 'manager',
        adapterId: 'independent-manager',
        rendererId: id,
        pid: process.pid,
        processStartedAt: 'fixture',
      },
      sessionId: secret(),
      timeoutMs: 3000,
    })
    const methods: string[] = []
    let current: CordisXPluginActivationRecordV1 = active
    let epoch = 0
    let staged: any
    const task = (async () => {
      while (!peer.closed) {
        const command = await peer.next()
        if (!command) continue
        methods.push(command.method)
        calls.push(`manager:${command.method}`)
        const payload = command.payload as any
        let value: unknown
        if (command.method === 'synchronize') {
          await options.blockSynchronize?.()
          current = payload.active
          epoch = payload.registryEpoch
          value = { active: current, registryEpoch: epoch }
        } else if (command.method === 'prepare') value = payload
        else if (command.method === 'stage') {
          managerImpacts.push(payload.affectedPluginIds)
          if (options.disconnectOnStage) {
            peer.close()
            break
          }
          staged = payload
          stageEpochs.push(payload.transactionEpoch)
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
        } else if (command.method === 'finalize') {
          if (options.disconnectOnFinalize) {
            peer.close()
            break
          }
          const { transactionId: _id, ...candidate } = staged.candidate
          void _id
          current = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
          value = { transactionId: options.invalidFinalize ? 'wrong-transaction' : payload.transactionId }
        } else if (command.method === 'rollback') {
          current = staged.previous
          epoch = staged.afterRegistryEpoch + 1
          value = payload.expected
        } else throw new Error('unexpected command')
        peer.acknowledge({ id: command.id, sequence: command.sequence, ok: true, value })
      }
    })()
    const attached: AttachedRendererPeer = options.rejectPublish
      ? {
        scope: peer.scope,
        identity: peer.identity,
        sessionId: peer.sessionId,
        get closed() {
          return peer.closed
        },
        async request(method, payload) {
          const value = await peer.request(method, payload)
          if (method === 'publish') throw new RendererAttachmentRejected()
          return value
        },
        onDisconnect: listener => peer.onDisconnect(listener),
        close: () => peer.close(),
      }
      : peer
    peers.push({ peer, task, methods })
    await lifecycle.attach(attached)
    return { peer, methods }
  }
  async function disable() {
    const revision = (await store.loadActive()).revision
    const planned = await coordinator.handle(
      request({ kind: 'disable', pluginId: 'fixture-plugin', impactToken: 'probe' }, revision),
    )
    expect(planned).toMatchObject({ outcome: 'planned' })
    return await coordinator.handle(
      request({ kind: 'disable', pluginId: 'fixture-plugin', impactToken: planned.impactToken! }, revision),
    )
  }
  async function enable(pluginId: string) {
    const revision = (await store.loadActive()).revision
    const planned = await coordinator.handle(request({ kind: 'enable', pluginId }, revision))
    expect(planned).toMatchObject({ outcome: 'planned' })
    return await coordinator.handle(request({
      kind: 'enable',
      pluginId,
      authorizationDecision: decision(planned.authorizationPlan!),
    }, revision))
  }
  return {
    root,
    home,
    scope,
    active,
    cdp,
    cdpSession,
    extraSession,
    unregister,
    lifecycle,
    managed,
    coordinator,
    desktop,
    extraDesktop,
    stageEpochs,
    desktopImpacts,
    managerImpacts,
    calls,
    attach,
    disable,
    enable,
    async close() {
      for (const item of peers) item.peer.close()
      await Promise.allSettled(peers.map(item => item.task))
      unregister()
      unregisterExtra?.()
      await managed.dispose()
      await desktop.dispose()
      await extraDesktop?.dispose()
      dom.window.close()
      extraDom?.window.close()
      const digests = await readdir(path.join(home, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(home, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('uses the same authority and fence for a real desktop renderer and manager participant', async () => {
  const f = await fixture({ desktopCount: 2 })
  try {
    const manager = await f.attach()
    expect(await f.disable()).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(f.desktop.activePluginGeneration().plugins[0].enabled).toBe(false)
    expect(f.desktop.pluginRegistryEpoch()).toBe(1)
    expect(f.extraDesktop.activePluginGeneration()).toEqual(f.desktop.activePluginGeneration())
    expect(f.extraDesktop.pluginRegistryEpoch()).toBe(1)
    expect(f.stageEpochs).toHaveLength(3)
    expect(new Set(f.stageEpochs).size).toBe(1)
    expect(f.stageEpochs[0]).not.toBe('')
    expect(manager.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(f.calls.indexOf('manager:finalize')).toBeLessThan(f.calls.indexOf('desktop:finalize'))
    expect(f.lifecycle.requiresReconciliation).toBe(false)
    const join = f.cdp.beginJoin({ send: async () => ({}) } as never)
    join.abort()
  } finally {
    await f.close()
  }
}, 60_000)

it('blocks desktop joins and manager attachment while preflight projections are in flight', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    blockProjection: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    const manager = await f.attach()
    const result = f.disable()
    await entered.promise
    expect(() => f.cdp.beginJoin({ send: async () => ({}) } as never)).toThrow('cannot join')
    await expect(
      f.cdp.reload({ pluginId: 'fixture-plugin', moduleGeneration: 'fixture', runtimeGeneration: 'runtime-1' }),
    )
      .rejects.toThrow('blocks renderer reload')
    await expect(f.attach('late')).rejects.toThrow('attachment is unavailable')
    manager.peer.close()
    release.resolve()
    expect(await result).toMatchObject({ outcome: 'rejected', error: { code: 'operation-unavailable' } })
    const join = f.cdp.beginJoin({ send: async () => ({}) } as never)
    join.abort()
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('rejects preflight while an earlier manager join is awaiting its actual snapshot', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    blockSynchronize: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    const joining = f.attach()
    await entered.promise
    const candidate: CordisXPluginActivationRecordV1 = {
      ...f.active,
      recordKind: 'candidate',
      transactionId: 'join-race',
      revision: f.active.revision + 1,
      lastGoodRevision: f.active.revision,
      plugins: f.active.plugins.map(item => ({ ...item, enabled: false })),
    }
    await expect(
      f.lifecycle.preflight({
        transactionId: 'join-race',
        operation: 'disable',
        previous: f.active,
        candidate,
        targetId: 'fixture-plugin',
      }),
    )
      .rejects.toThrow('shared preflight is unavailable')
    release.resolve()
    await joining
    const join = f.cdp.beginJoin({ send: async () => ({}) } as never)
    join.abort()
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('admits concurrent managers against one verified Desktop snapshot', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    blockSynchronize: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    const first = f.attach('first')
    await entered.promise
    const second = f.attach('second')
    release.resolve()
    const managers = await Promise.all([first, second])
    expect(await f.disable()).toMatchObject({ outcome: 'applied', revision: 2 })
    for (const manager of managers) {
      expect(manager.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'complete', 'finalize'])
    }
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('closes an in-flight Manager join and releases its unstarted Desktop reservation on shutdown', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    blockSynchronize: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    const joining = f.attach()
    await entered.promise
    f.lifecycle.close()
    await expect(joining).rejects.toThrow()
    release.resolve()
    expect(() => f.lifecycle.snapshot()).toThrow('unavailable')
    const next = f.cdp.beginJoin({ send: async () => ({}) } as never)
    next.abort()
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('keeps Manager bootstrap and mutation unavailable while no CDP seat is ready', async () => {
  const f = await fixture()
  try {
    f.unregister()
    expect(() => f.lifecycle.snapshot()).toThrow('CDP shared admission is unavailable')
    await expect(f.attach()).rejects.toThrow('CDP shared admission is unavailable')
    expect(await f.disable()).toMatchObject({ outcome: 'rejected', error: { code: 'operation-unavailable' } })
    expect(f.desktop.activePluginGeneration().revision).toBe(f.active.revision)
  } finally {
    await f.close()
  }
}, 60_000)

it('keeps ordinary Desktop package mutation available with no Manager participants', async () => {
  const f = await fixture()
  try {
    expect(await f.disable()).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(f.desktop.activePluginGeneration().plugins[0].enabled).toBe(false)
    expect(f.calls.some(call => call.startsWith('manager:'))).toBe(false)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)

it('does not let an attached Manager bypass the shared barrier via Desktop configuration', async () => {
  const f = await fixture()
  try {
    const operation = { kind: 'plugin-configuration' as const, action: 'list' as const }
    expect((await f.lifecycle.pluginConfiguration(operation)).status).toBe('ok')
    const manager = await f.attach()
    expect(await f.lifecycle.pluginConfiguration(operation)).toEqual({ status: 'unavailable', reason: 'renderer-busy' })
    manager.peer.close()
    expect((await f.lifecycle.pluginConfiguration(operation)).status).toBe('ok')
  } finally {
    await f.close()
  }
}, 60_000)

it('requires a proven rollback before allowing the desktop or manager to join again', async () => {
  const f = await fixture({ rejectPublish: true })
  try {
    const manager = await f.attach()
    expect(await f.disable()).toMatchObject({ outcome: 'rolled-back' })
    expect(f.desktop.activePluginGeneration().plugins[0].enabled).toBe(true)
    expect(f.desktop.pluginRegistryEpoch()).toBe(2)
    expect(manager.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'rollback', 'synchronize'])
    expect(manager.peer.closed).toBe(false)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
    const join = f.cdp.beginJoin({ send: async () => ({}) } as never)
    join.abort()
  } finally {
    await f.close()
  }
}, 60_000)

it('does not fence a duplicate between federation confirmation and wrapper adoption', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({ rejectPublish: true })
  try {
    const manager = await f.attach()
    // Hold the wrapper after the federation has confirmed rollback, before
    // the wrapper has had a chance to record pendingAdoption.
    const federation = (f.lifecycle as any).federation
    const rollback = federation.rollback.bind(federation)
    vi.spyOn(federation, 'rollback').mockImplementation(async (id: string) => {
      const confirmed = await rollback(id)
      entered.resolve()
      await release.promise
      return confirmed
    })
    const disabling = f.disable()
    await entered.promise
    const id = f.stageEpochs[0]!.split(':')[0]!
    await expect(f.lifecycle.rollback(id)).rejects.toThrow()
    expect(manager.peer.closed).toBe(false)
    release.resolve()
    expect(await disabling).toMatchObject({ outcome: 'rolled-back' })
    expect(manager.peer.closed).toBe(false)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('still fences a failed first rollback when a duplicate races its in-flight receipt', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({ rejectPublish: true })
  try {
    const surviving = await f.attach('first')
    const disconnected = await f.attach('second')
    const request = disconnected.peer.request.bind(disconnected.peer)
    vi.spyOn(disconnected.peer, 'request').mockImplementation(async (method, payload) => {
      if (method === 'rollback') {
        entered.resolve()
        await release.promise
      }
      return await request(method, payload)
    })
    const disabling = f.disable()
    await entered.promise
    const id = f.stageEpochs[0]!.split(':')[0]!
    await expect(f.lifecycle.rollback(id)).rejects.toThrow('already in progress')
    expect(surviving.peer.closed).toBe(false)
    disconnected.peer.close()
    release.resolve()
    expect(await disabling).toMatchObject({ outcome: 'rollback-failed' })
    expect(surviving.peer.closed).toBe(true)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('keeps a confirmed rollback alive while its durable adoption is pending', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({ rejectPublish: true })
  const adopt = f.lifecycle.adoptRecoveredActivation.bind(f.lifecycle)
  vi.spyOn(f.lifecycle, 'adoptRecoveredActivation').mockImplementation(async (active, epoch) => {
    entered.resolve()
    await release.promise
    await adopt(active, epoch)
  })
  try {
    const manager = await f.attach()
    const disabling = f.disable()
    await entered.promise
    const id = f.stageEpochs[0]!.split(':')[0]!
    await expect(f.lifecycle.rollback('stale-transaction')).rejects.toThrow()
    await expect(f.lifecycle.rollback(id)).rejects.toThrow()
    expect(manager.peer.closed).toBe(false)
    release.resolve()
    expect(await disabling).toMatchObject({ outcome: 'rolled-back' })
    expect(manager.peer.closed).toBe(false)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it.each(['desktop', 'manager'] as const)(
  'cancels the unstarted reservation if %s leaves after preflight',
  async which => {
    const f = await fixture()
    try {
      const manager = await f.attach()
      const candidate: CordisXPluginActivationRecordV1 = {
        ...f.active,
        recordKind: 'candidate',
        transactionId: 'manual-reservation',
        revision: f.active.revision + 1,
        lastGoodRevision: f.active.revision,
        plugins: f.active.plugins.map(item => ({ ...item, enabled: false })),
      }
      await f.lifecycle.preflight({
        transactionId: 'manual-reservation',
        operation: 'disable',
        previous: f.active,
        candidate,
        targetId: 'fixture-plugin',
      })
      if (which === 'desktop') f.unregister()
      else manager.peer.close()
      expect(() => f.lifecycle.prepare('manual-reservation')).toThrow('reservation is stale')
      expect(f.lifecycle.requiresReconciliation).toBe(false)
      const join = f.cdp.beginJoin({ send: async () => ({}) } as never)
      join.abort()
    } finally {
      await f.close()
    }
  },
  60_000,
)

it('keeps the shared reservation while first-browser-graph admission is pending', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  try {
    await f.attach()
    f.cdp.setBrowserGraphAdmission(async () => {
      entered.resolve()
      await release.promise
      return { commit: () => {}, rollback: async () => {} }
    })
    const candidate: CordisXPluginActivationRecordV1 = {
      ...f.active,
      recordKind: 'candidate',
      transactionId: 'graph-reservation',
      revision: f.active.revision + 1,
      lastGoodRevision: f.active.revision,
      plugins: f.active.plugins.map(item => ({ ...item, enabled: false })),
    }
    await f.managed.preflight!({
      transactionId: 'graph-reservation',
      operation: 'disable',
      previous: f.active,
      candidate,
      targetId: 'fixture-plugin',
    })
    const pending = f.managed.prepareBrowserGraph('graph-reservation', f.active)
    await entered.promise
    expect(() => f.managed.prepare('graph-reservation')).toThrow('already in progress')
    await expect(f.managed.prepareBrowserGraph('graph-reservation', { ...f.active, revision: 9 })).rejects.toThrow(
      'already in progress',
    )
    await expect(f.managed.abort('graph-reservation')).rejects.toThrow('already in progress')
    expect(() => f.cdp.beginJoin({ send: async () => ({}) } as never)).toThrow('cannot join')
    release.resolve()
    const fence = await pending
    expect(fence.expectedRegistryEpoch).toBe(0)
    expect(fence.transactionEpoch.startsWith('graph-reservation:')).toBe(true)
    await f.managed.abort('graph-reservation')
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    release.resolve()
    await f.close()
  }
}, 60_000)

it('does not retire Desktop resources if a manager disappears during finalization', async () => {
  const f = await fixture({ disconnectOnFinalize: true })
  try {
    await f.attach()
    expect(await f.disable()).toMatchObject({ outcome: 'rollback-failed' })
    expect(f.calls).toContain('manager:finalize')
    expect(f.calls).not.toContain('desktop:finalize')
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    expect(() => f.cdp.beginJoin({ send: async () => ({}) } as never)).toThrow('cannot join')
  } finally {
    await f.close()
  }
}, 60_000)

it('does not finalize the CDP graph authority if a live manager returns a wrong receipt', async () => {
  const f = await fixture({ invalidFinalize: true })
  try {
    const manager = await f.attach()
    expect(await f.disable()).toMatchObject({ outcome: 'rollback-failed' })
    expect(manager.peer.closed).toBe(true)
    expect(f.calls).toContain('manager:finalize')
    expect(f.calls).not.toContain('desktop:finalize')
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    expect(() => f.cdp.beginJoin({ send: async () => ({}) } as never)).toThrow('cannot join')
  } finally {
    await f.close()
  }
}, 60_000)

it('does not accept a second CDP publication whose observed activation disagrees', async () => {
  const f = await fixture({ desktopCount: 2 })
  try {
    await f.attach()
    const original = f.extraSession!.send.bind(f.extraSession)
    vi.spyOn(f.extraSession!, 'send').mockImplementation(async (method, params) => {
      const response = await original(method, params)
      if (String(params.expression).includes('publishPluginMutation') && response.result?.value?.result) {
        response.result.value.result.active.profileId = 'wrong-profile'
      }
      return response
    })
    expect(await f.disable()).toMatchObject({ outcome: 'rollback-failed' })
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    expect(() => f.cdp.prepare('blocked')).toThrow('another plugin generation transaction')
  } finally {
    await f.close()
  }
}, 60_000)

it.each(['desktop', 'manager'] as const)(
  'fences unknown results after %s disconnects during a frozen transaction',
  async which => {
    const f = await fixture({ disconnectOnStage: which === 'manager' })
    try {
      const manager = await f.attach()
      if (which === 'desktop') {
        const original = f.cdpSession.send.bind(f.cdpSession)
        vi.spyOn(f.cdpSession, 'send').mockImplementation(async (method, params) => {
          if (String(params.expression).includes('stagePluginMutation')) f.unregister()
          return await original(method, params)
        })
      }
      expect(await f.disable()).toMatchObject({ outcome: 'rollback-failed' })
      expect(f.lifecycle.requiresReconciliation).toBe(true)
      expect(() => f.cdp.beginJoin({ send: async () => ({}) } as never)).toThrow('cannot join')
      expect(() => f.cdp.prepare('blocked')).toThrow('another plugin generation transaction')
      manager.peer.close()
    } finally {
      await f.close()
    }
  },
  60_000,
)

// Manager is a protocol peer fixture; the CDP sessions execute real renderer bundles.
it.each([false, true])('validates a real dependency closure with Manager attached: %s', async withManager => {
  const f = await fixture({ dependent: true, desktopCount: 2 })
  try {
    // A transport substitute is required because JSDOM cannot provide CDP's
    // native browser graph admission and future-document bootstrap refresh.
    f.cdp.setBrowserGraphAdmission(async () => ({ commit: () => {}, rollback: async () => {} }))
    f.cdp.setBrowserGraphBootstrapRefresh(async () => {})
    if (withManager) await f.attach()
    expect(await f.disable()).toMatchObject({ outcome: 'applied', revision: 3 })
    expect(f.desktopImpacts).toEqual([
      ['fixture-plugin', 'fixture-dependent'],
      ['fixture-plugin', 'fixture-dependent'],
    ])
    expect(f.managerImpacts).toEqual(withManager ? [['fixture-dependent', 'fixture-plugin']] : [])
    expect(f.desktop.activePluginGeneration().plugins.map((item: { enabled: boolean }) => item.enabled)).toEqual([
      false,
      false,
    ])
    expect(f.extraDesktop.activePluginGeneration()).toEqual(f.desktop.activePluginGeneration())
    expect(f.stageEpochs).toHaveLength(withManager ? 3 : 2)
    expect(new Set(f.stageEpochs).size).toBe(1)
    expect(f.stageEpochs[0]).not.toBe('')
    expect(f.lifecycle.requiresReconciliation).toBe(false)
    expect(await f.enable('fixture-plugin')).toMatchObject({ outcome: 'applied', revision: 4 })
    expect(f.desktop.activePluginGeneration().plugins.map((item: { enabled: boolean }) => item.enabled)).toEqual([
      true,
      false,
    ])
    expect(f.extraDesktop.activePluginGeneration()).toEqual(f.desktop.activePluginGeneration())
    expect(await f.enable('fixture-dependent')).toMatchObject({ outcome: 'applied', revision: 5 })
    expect(f.desktop.activePluginGeneration().plugins.map((item: { enabled: boolean }) => item.enabled)).toEqual([
      true,
      true,
    ])
    expect(f.extraDesktop.activePluginGeneration()).toEqual(f.desktop.activePluginGeneration())
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)
