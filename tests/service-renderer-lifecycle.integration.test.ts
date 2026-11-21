import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { fenceManagerConsumers } from '../packages/cli/src/cli/manager-consumer-fence.js'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import {
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import {
  type AttachedRendererPeer,
  attachmentHomeDigest,
  RendererAttachmentRejected,
} from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { RendererLifecycleFederation } from '../packages/cli/src/launcher/renderer-lifecycle-federation.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

const secret = () => randomBytes(32).toString('hex')

async function fixture(options: {
  rollbackPending?: boolean
  failLeaseAt?: number
  blockProjection?: () => Promise<void>
} = {}) {
  const root = await mkdtemp('/tmp/cx-service-renderer-')
  const home = path.join(root, 'home')
  const generation = 'runtime-1'
  const scope = {
    homeDigest: attachmentHomeDigest(home),
    ownerAppId: 'codex',
    profileId: 'work',
    generation,
  }
  if (options.rollbackPending) {
    const interrupted = new FormalRuntime()
    interrupted.failComplete = true
    interrupted.failRollback = true
    const first = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: interrupted,
    })
    const sourceDirectory = await localPackage({ root, id: 'before-recovery' })
    const plan = await first.handle(request({ kind: 'inspect-local', sourceDirectory }))
    const failure = await first.handle(request({
      kind: 'install',
      candidateId: plan.candidateId!,
      authorizationDecision: decision(plan.authorizationPlan!),
    }))
    expect(failure).toMatchObject({ outcome: 'rollback-failed' })
  }
  let projectionAllowed = true
  let serverStarts = 0
  let leaseRequests = 0
  const leases: PluginGenerationGraphLease[] = []
  const projectedLeases: Array<{ rendererId: string; pluginIds: string[] }> = []
  const preflightImpacts: string[][] = []
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    async createArtifactServer() {
      serverStarts++
      const server = await startPluginGenerationArtifactServer()
      return {
        origin: server.origin,
        requestTrace: () => server.requestTrace(),
        close: async () => await server.close(),
        async lease(...args) {
          leaseRequests++
          if (leaseRequests === options.failLeaseAt) throw new Error('fixture graph resolution failed')
          const lease = await server.lease(...args)
          leases.push(lease)
          return lease
        },
      }
    },
    async projectMutation(mutation, identity) {
      await options.blockProjection?.()
      if (!projectionAllowed) throw new Error('fixture projection rejected')
      if (mutation.transactionEpoch?.endsWith(':preflight')) {
        preflightImpacts.push([...mutation.affectedPluginIds].sort())
      }
      if (mutation.runtimeArtifactLeases !== undefined) {
        projectedLeases.push({
          rendererId: identity.rendererId,
          pluginIds: mutation.runtimeArtifactLeases.map(lease => lease.pluginId).sort(),
        })
      }
      return {
        rendererId: identity.rendererId,
        transactionId: mutation.transactionId,
        transactionEpoch: mutation.transactionEpoch,
        expectedRegistryEpoch: mutation.expectedRegistryEpoch,
        afterRegistryEpoch: mutation.afterRegistryEpoch,
        previous: mutation.previous,
        candidate: mutation.candidate,
        operation: mutation.operation,
        targetId: mutation.targetId,
        affectedPluginIds: mutation.affectedPluginIds,
      }
    },
  })
  const store = new PluginActivationStore(home, 'work', generation)
  const managed = createProductionManagedServiceLifecycle({
    runtime: lifecycle,
    homeDir: home,
    profileId: 'work',
    generation,
    environment: { PATH: process.env.PATH, HOME: root },
    store,
    dryRun: false,
    requireOwnedProcess: true,
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: managed,
    headless: true,
  })
  const recovered = await coordinator.recover()
  expect(recovered).toHaveLength(options.rollbackPending ? 1 : 0)
  lifecycle.initialize(await store.bindRuntimeGeneration())
  await (await managed.initialize(await store.loadActive())).coreReady
  const peers: Array<{ peer: ManagerRendererCommandPeer; task: Promise<void>; methods: string[] }> = []

  async function attach(id: string, options: { disconnectOnStage?: boolean; rejectPublish?: boolean } = {}) {
    const active = await store.loadActive()
    const snapshot = lifecycle.snapshot()
    const peer = new ManagerRendererCommandPeer({
      scope,
      identity: { appId: 'codex', adapterId: 'manager', rendererId: id, pid: process.pid, processStartedAt: 'fixture' },
      sessionId: secret(),
      timeoutMs: 3000,
    })
    const methods: string[] = []
    let current: CordisXPluginActivationRecordV1 = active
    let epoch = snapshot.registryEpoch
    let staged: Record<string, any> | undefined
    const task = (async () => {
      while (!peer.closed) {
        const command = await peer.next()
        if (command === undefined) continue
        methods.push(command.method)
        const payload = command.payload as Record<string, any>
        let value: unknown
        try {
          if (command.method === 'synchronize') {
            expect(payload).toEqual({ active: current, registryEpoch: epoch })
            value = { active: current, registryEpoch: epoch }
          } else if (command.method === 'prepare') {
            expect(payload.expectedRegistryEpoch).toBe(epoch)
            value = payload
          } else if (command.method === 'stage') {
            if (options.disconnectOnStage) {
              peer.close()
              break
            }
            expect(payload.rendererId).toBe(id)
            expect(payload.previous).toEqual(current)
            staged = payload
            value = {
              transactionId: payload.transactionId,
              transactionEpoch: payload.transactionEpoch,
              expectedRegistryEpoch: payload.expectedRegistryEpoch,
              afterRegistryEpoch: payload.afterRegistryEpoch,
              observation: payload.candidate,
              affectedPluginIds: payload.affectedPluginIds,
            }
          } else if (command.method === 'publish') {
            if (!staged) throw new Error('not staged')
            current = staged.candidate
            epoch = staged.afterRegistryEpoch
            value = {
              transactionId: staged.transactionId,
              transactionEpoch: staged.transactionEpoch,
              registryEpoch: epoch,
              active: current,
            }
          } else if (command.method === 'complete') {
            if (!staged) throw new Error('not staged')
            value = {
              transactionId: staged.transactionId,
              transactionEpoch: staged.transactionEpoch,
              registryEpoch: epoch,
              active: current,
              disposedAfter: staged.previous,
            }
          } else if (command.method === 'finalize') {
            if (!staged) throw new Error('not staged')
            const { transactionId: _id, ...candidate } = staged.candidate
            void _id
            current = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
            staged = undefined
            value = { transactionId: payload.transactionId }
          } else if (command.method === 'rollback') {
            if (!staged) throw new Error('not staged')
            current = staged.previous
            epoch = staged.afterRegistryEpoch + 1
            expect(payload.expected).toEqual({
              transactionId: staged.transactionId,
              transactionEpoch: staged.transactionEpoch,
              registryEpoch: epoch,
              active: current,
              disposedAfter: staged.candidate,
            })
            value = payload.expected
            staged = undefined
          } else {
            throw new Error('fixture operation not supported')
          }
          peer.acknowledge({ id: command.id, sequence: command.sequence, ok: true, value })
        } catch {
          peer.acknowledge({ id: command.id, sequence: command.sequence, ok: false })
        }
      }
    })()
    peers.push({ peer, task, methods })
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
          // Simulate a definite negative receipt after that renderer changed
          // its state. The owner must still confirm rollback with every peer.
          if (method === 'publish') throw new RendererAttachmentRejected()
          return value
        },
        onDisconnect: listener => peer.onDisconnect(listener),
        close: () => peer.close(),
      }
      : peer
    await lifecycle.attach(attached)
    return { peer, methods }
  }

  async function install(
    id: string,
    revision: number,
    plugin: { version?: string; code?: string; dependencies?: readonly { id: string; version: string }[] } = {},
  ) {
    const sourceDirectory = await localPackage({ root, id, ...plugin })
    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory }, revision))
    expect(planned).toMatchObject({ outcome: 'planned', candidateId: expect.any(String) })
    return await coordinator.handle(request({
      kind: planned.operation === 'update' ? 'update' : 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!),
    }, revision))
  }

  return {
    lifecycle,
    coordinator,
    store,
    scope,
    leases,
    projectedLeases,
    preflightImpacts,
    serverStarts: () => serverStarts,
    attach,
    install,
    rejectProjection: () => projectionAllowed = false,
    async close() {
      await lifecycle.close()
      await Promise.allSettled(peers.map(async peer => await peer.task))
      await managed.dispose()
      const digests = await readdir(path.join(home, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(home, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('fences lifecycle writes and new seats only when every existing peer is accounted for', async () => {
  const f = await fixture()
  try {
    const first = await f.attach('first')
    expect(() => f.lifecycle.reserveExternalMutation([])).toThrow('service renderer fence is unavailable')
    const lease = f.lifecycle.reserveExternalMutation([first.peer])
    expect(lease.isCurrent()).toBe(true)
    expect(() => f.lifecycle.prepare('blocked')).toThrow('service renderer fence is active')
    const stranger = new ManagerRendererCommandPeer({
      scope: f.scope,
      identity: {
        appId: 'codex',
        adapterId: 'other',
        rendererId: 'second',
        pid: process.pid,
        processStartedAt: 'fixture',
      },
      sessionId: secret(),
    })
    await expect(f.lifecycle.attach(stranger)).rejects.toThrow('service renderer attachment is unavailable')
    expect(stranger.closed).toBe(true)
    first.peer.close()
    expect(lease.isCurrent()).toBe(true)
    expect(lease.release()).toBe(true)
    const next = await f.attach('after-release')
    next.peer.close()
  } finally {
    await f.close()
  }
}, 30_000)

it('does not reserve a fence during an existing transaction and stays closed after uncertainty', async () => {
  const f = await fixture()
  try {
    f.lifecycle.prepare('in-progress')
    expect(() => f.lifecycle.reserveExternalMutation([])).toThrow('service renderer lifecycle is unavailable')
    await f.lifecycle.abort('in-progress')
    const lease = f.lifecycle.reserveExternalMutation([])
    lease.fence()
    expect(lease.isCurrent()).toBe(false)
    expect(() => f.lifecycle.snapshot()).toThrow('service renderer lifecycle is unavailable')
  } finally {
    await f.close()
  }
}, 30_000)

it('permits only the reserved owner review and requires its committed activation readback', async () => {
  const f = await fixture()
  let resume!: () => void
  let entered!: () => void
  let resumeGap!: () => void
  let gap!: Promise<unknown>
  let resumeLate!: () => void
  let late!: Promise<unknown>
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const paused = new Promise<void>(resolve => {
    resume = resolve
  })
  const lateSignal = new Promise<void>(resolve => {
    resumeLate = resolve
  })
  const gapSignal = new Promise<void>(resolve => {
    resumeGap = resolve
  })
  try {
    const lease = f.lifecycle.reserveExternalMutation([])
    const original = f.lifecycle.snapshot().active
    const review = lease.runExclusive(async () => {
      gap = gapSignal.then(() => f.lifecycle.prepare('expired-review'))
      late = lateSignal.then(() => f.lifecycle.prepare('late-review'))
      entered()
      await paused
      f.lifecycle.prepare('owner-review')
      await f.lifecycle.abort('owner-review')
    })
    await started
    expect(() => f.lifecycle.prepare('unrelated')).toThrow('service renderer fence is active')
    expect(lease.adoptCommitted(original)).toBe(false)
    await expect(lease.runExclusive(async () => {})).rejects.toThrow('service renderer fence is unavailable')
    resume()
    await review
    resumeGap()
    await expect(gap).rejects.toThrow('service renderer fence is stale')
    expect(lease.adoptCommitted({ ...original, revision: original.revision + 1 })).toBe(false)
    expect(lease.adoptCommitted(f.lifecycle.snapshot().active)).toBe(true)
    expect(lease.release()).toBe(true)
    resumeLate()
    await expect(late).rejects.toThrow('service renderer fence is stale')
    f.lifecycle.prepare('after-review')
    await f.lifecycle.abort('after-review')
  } finally {
    resume()
    resumeGap()
    resumeLate()
    await f.close()
  }
}, 30_000)

it('does not let an expired review context finish a dangling transaction', async () => {
  const f = await fixture()
  let resume!: () => void
  let late!: Promise<unknown>
  const signal = new Promise<void>(resolve => {
    resume = resolve
  })
  try {
    const lease = f.lifecycle.reserveExternalMutation([])
    const original = f.lifecycle.snapshot().active
    await lease.runExclusive(async () => {
      f.lifecycle.prepare('unfinished-review')
      late = signal.then(async () => await f.lifecycle.abort('unfinished-review'))
    })
    resume()
    await expect(late).rejects.toThrow('service renderer fence is stale')
    expect(lease.adoptCommitted(original)).toBe(false)
    expect(lease.release()).toBe(false)
    expect(() => f.lifecycle.snapshot()).toThrow('service renderer lifecycle is unavailable')
  } finally {
    resume()
    await f.close()
  }
}, 30_000)

it('refuses a Manager fence while an unaccounted adapter is attached', async () => {
  const f = await fixture()
  const participants = new ServiceRendererParticipants(f.scope)
  participants.bind(f.lifecycle)
  const sessions = new ManagerRendererSessions({
    profileId: f.scope.profileId,
    ownerGeneration: f.scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
  })
  try {
    const foreign = await f.attach('unaccounted-adapter')
    await expect(fenceManagerConsumers({ sessions, participants, lifecycle: f.lifecycle }))
      .rejects.toThrow('manager-consumer-fence-unavailable')
    expect(foreign.peer.closed).toBe(false)
    expect(await sessions.open({ pid: 42, processStartedAt: 'fixture', instanceToken: secret() }, secret()))
      .toBeDefined()
  } finally {
    sessions.dispose()
    participants.close()
    await f.close()
  }
}, 30_000)

it('reserves the real lifecycle while the sole originating Manager receives its write result', async () => {
  const f = await fixture()
  const participants = new ServiceRendererParticipants(f.scope)
  participants.bind(f.lifecycle)
  let signalReady!: (id: string) => void
  let finish!: () => void
  let ready = new Promise<string>(resolve => {
    signalReady = resolve
  })
  let completion = new Promise<void>(resolve => {
    finish = resolve
  })
  let sessions!: ManagerRendererSessions
  sessions = new ManagerRendererSessions({
    profileId: f.scope.profileId,
    ownerGeneration: f.scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['fixture', {
      prepare: value => ({
        mode: 'write' as const,
        dispatch: async () => {
          const fence = await fenceManagerOrigin({ sessions, participants, lifecycle: f.lifecycle })
          signalReady(fence.rendererId)
          await completion
          if (value === 'disconnect') {
            expect(fence.isCurrent()).toBe(false)
            expect(fence.release()).toBe(false)
            return 'possibly written'
          }
          expect(fence.isCurrent()).toBe(true)
          expect(fence.release()).toBe(true)
          return 'written'
        },
      }),
    }]]),
  })
  try {
    const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
    const browserSessionId = secret()
    const handle = (await sessions.open(gateway, browserSessionId))!
    participants.confirmBootstrap(handle.rendererId, f.lifecycle.snapshot())
    const invocation = { gateway, browserSessionId, handle }
    const admission = sessions.admit(invocation)
    const peer = participants.peer(handle.rendererId)!
    const synchronize = (await peer.next())!
    expect(synchronize.method).toBe('synchronize')
    expect(peer.acknowledge({
      id: synchronize.id,
      sequence: synchronize.sequence,
      ok: true,
      value: synchronize.payload,
    })).toBe(true)
    expect(await admission).toEqual({ status: 'ok', value: { admitted: true } })
    const write = sessions.call(invocation, 'fixture', {})
    expect(await ready).toBe(handle.rendererId)
    expect(peer.closed).toBe(false)
    expect(await sessions.open(gateway, secret())).toBeUndefined()
    expect(() => f.lifecycle.prepare('blocked')).toThrow('service renderer fence is active')
    finish()
    expect(await write).toEqual({ status: 'ok', value: 'written' })
    const probeId = secret()
    const probe = (await sessions.open(gateway, probeId))!
    expect(await sessions.close({ gateway, browserSessionId: probeId, handle: probe })).toBe(true)
    ready = new Promise(resolve => {
      signalReady = resolve
    })
    completion = new Promise(resolve => {
      finish = resolve
    })
    const interrupted = sessions.call(invocation, 'fixture', 'disconnect')
    expect(await ready).toBe(handle.rendererId)
    const closing = sessions.close(invocation)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    finish()
    expect(await interrupted).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
  } finally {
    finish()
    sessions.dispose()
    participants.close()
    await f.close()
  }
}, 30_000)

it('preserves other Managers and refuses an unaccounted adapter during an originating write', async () => {
  const f = await fixture()
  const participants = new ServiceRendererParticipants(f.scope)
  participants.bind(f.lifecycle)
  let sessions!: ManagerRendererSessions
  sessions = new ManagerRendererSessions({
    profileId: f.scope.profileId,
    ownerGeneration: f.scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['fixture', {
      prepare: () => ({
        mode: 'write' as const,
        dispatch: async () => {
          try {
            const fence = await fenceManagerOrigin({ sessions, participants, lifecycle: f.lifecycle })
            return fence.release() ? 'reserved' : 'unavailable'
          } catch {
            return 'unavailable'
          }
        },
      }),
    }]]),
  })
  try {
    const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
    const browserSessionId = secret()
    const handle = (await sessions.open(gateway, browserSessionId))!
    participants.confirmBootstrap(handle.rendererId, f.lifecycle.snapshot())
    const invocation = { gateway, browserSessionId, handle }
    const admission = sessions.admit(invocation)
    const peer = participants.peer(handle.rendererId)!
    const synchronize = (await peer.next())!
    peer.acknowledge({ id: synchronize.id, sequence: synchronize.sequence, ok: true, value: synchronize.payload })
    expect(await admission).toMatchObject({ status: 'ok' })
    const otherId = secret()
    const otherHandle = (await sessions.open(gateway, otherId))!
    const other = participants.peer(otherHandle.rendererId)!
    expect(await sessions.call(invocation, 'fixture', {})).toEqual({ status: 'ok', value: 'unavailable' })
    expect(other.closed).toBe(false)
    expect(peer.closed).toBe(false)
    expect(await sessions.close({ gateway, browserSessionId: otherId, handle: otherHandle })).toBe(true)
    const foreign = await f.attach('unaccounted-adapter')
    expect(await sessions.call(invocation, 'fixture', {})).toEqual({ status: 'ok', value: 'unavailable' })
    expect(foreign.peer.closed).toBe(false)
    foreign.peer.close()
    expect(await sessions.call(invocation, 'fixture', {})).toEqual({ status: 'ok', value: 'reserved' })
  } finally {
    sessions.dispose()
    participants.close()
    await f.close()
  }
}, 30_000)

it('uses one real package authority across zero, two, and zero renderer peers', async () => {
  const f = await fixture()
  try {
    expect(await f.install('headless-first', 0)).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(f.serverStarts()).toBe(0)
    const first = await f.attach('first')
    const second = await f.attach('second')
    expect(await f.install('renderer-second', 1)).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(f.serverStarts()).toBe(1)
    expect(f.projectedLeases).toEqual([
      { rendererId: 'first', pluginIds: ['renderer-second'] },
      { rendererId: 'second', pluginIds: ['renderer-second'] },
    ])
    expect(await (await fetch(f.leases[0]!.entryUrl)).status).toBe(200)
    for (const peer of [first, second]) {
      expect(peer.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'complete', 'finalize'])
      peer.peer.close()
    }
    expect(await (await fetch(f.leases[0]!.entryUrl)).status).toBe(404)
    const plan = await f.coordinator.handle(
      request({ kind: 'disable', pluginId: 'renderer-second', impactToken: 'probe' }, 2),
    )
    expect(plan).toMatchObject({ outcome: 'planned' })
    expect(
      await f.coordinator.handle(request({
        kind: 'disable',
        pluginId: 'renderer-second',
        impactToken: plan.impactToken!,
      }, 2)),
    ).toMatchObject({ outcome: 'applied', revision: 3 })
    expect((await f.store.loadActive()).plugins).toMatchObject([
      { id: 'headless-first', enabled: true },
      { id: 'renderer-second', enabled: false },
    ])
  } finally {
    await f.close()
  }
}, 30000)

it('resolves the affected dependency closure through the candidate authority', async () => {
  const f = await fixture()
  try {
    expect(await f.install('graph-base', 0)).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(
      await f.install('graph-consumer', 1, {
        dependencies: [{ id: 'graph-base', version: '1.0.0' }],
      }),
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    await f.attach('first')
    const updated = await f.install('graph-base', 2, { code: 'export const revision = 2; export function apply() {}' })
    expect(updated, JSON.stringify(updated)).toMatchObject({ outcome: 'applied', revision: 3 })
    expect(f.preflightImpacts).toEqual([['graph-base', 'graph-consumer']])
    expect(f.projectedLeases).toEqual([{ rendererId: 'first', pluginIds: ['graph-base', 'graph-consumer'] }])
    expect(f.leases.map(lease => lease.pluginId).sort()).toEqual(['graph-base', 'graph-consumer'])
    for (const lease of f.leases) expect((await fetch(lease.entryUrl)).status).toBe(200)
  } finally {
    await f.close()
  }
}, 30000)

it('retires partially resolved graph leases after a confirmed rollback', async () => {
  const f = await fixture({ failLeaseAt: 2 })
  try {
    expect(await f.install('graph-base', 0)).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(
      await f.install('graph-consumer', 1, {
        dependencies: [{ id: 'graph-base', version: '1.0.0' }],
      }),
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    await f.attach('first')
    const updated = await f.install('graph-base', 2, { code: 'export const revision = 2; export function apply() {}' })
    expect(updated, JSON.stringify(updated)).toMatchObject({ outcome: 'rolled-back' })
    expect(f.leases).toHaveLength(1)
    expect((await fetch(f.leases[0]!.entryUrl)).status).toBe(404)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)

it('retires the previous graph only after a replacement is confirmed', async () => {
  const f = await fixture()
  try {
    const peer = await f.attach('first')
    expect(await f.install('replace-graph', 0)).toMatchObject({ outcome: 'applied', revision: 1 })
    const previous = f.leases[0]!
    expect((await fetch(previous.entryUrl)).status).toBe(200)
    expect(await f.install('replace-graph', 1, { code: 'export const revision = 2; export function apply() {}' }))
      .toMatchObject({ outcome: 'applied', revision: 2 })
    const current = f.leases[1]!
    expect((await fetch(previous.entryUrl)).status).toBe(404)
    expect((await fetch(current.entryUrl)).status).toBe(200)
    peer.peer.close()
    expect((await fetch(current.entryUrl)).status).toBe(404)
  } finally {
    await f.close()
  }
}, 30000)

it('keeps the prior graph live when candidate graph resolution rolls back', async () => {
  const f = await fixture({ failLeaseAt: 2 })
  try {
    const peer = await f.attach('first')
    expect(await f.install('retain-graph', 0)).toMatchObject({ outcome: 'applied', revision: 1 })
    const previous = f.leases[0]!
    expect(await f.install('retain-graph', 1, { code: 'export const revision = 2; export function apply() {}' }))
      .toMatchObject({ outcome: 'rolled-back' })
    expect((await fetch(previous.entryUrl)).status).toBe(200)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
    peer.peer.close()
    expect((await fetch(previous.entryUrl)).status).toBe(404)
  } finally {
    await f.close()
  }
}, 30000)

it('fences later mutations when one renderer disconnects after stage dispatch', async () => {
  const f = await fixture()
  try {
    await f.attach('first')
    await f.attach('second', { disconnectOnStage: true })
    const result = await f.install('interrupted', 0)
    expect(result).toMatchObject({ outcome: 'rollback-failed' })
    expect((await f.store.loadActive()).revision).toBe(0)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    expect(f.leases).toHaveLength(1)
    expect((await fetch(f.leases[0]!.entryUrl)).status).toBe(404)
    expect(() => f.lifecycle.prepare('must-remain-fenced')).toThrow('unavailable')
  } finally {
    await f.close()
  }
}, 30000)

it('adopts the package authority rollback only after every renderer confirms', async () => {
  const f = await fixture()
  try {
    const first = await f.attach('first')
    const second = await f.attach('second', { rejectPublish: true })
    expect(await f.install('rollback-fixture', 0)).toMatchObject({ outcome: 'rolled-back' })
    expect((await f.store.loadActive()).revision).toBe(0)
    expect(f.lifecycle.requiresReconciliation).toBe(false)
    for (const item of [first, second]) {
      expect(item.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'rollback', 'synchronize'])
      expect(item.peer.closed).toBe(false)
    }
    expect(f.lifecycle.snapshot().registryEpoch).toBe(2)
  } finally {
    await f.close()
  }
}, 30000)

it('rejects unsupported projection before dispatch and releases the reservation', async () => {
  const f = await fixture()
  try {
    const peer = await f.attach('first')
    f.rejectProjection()
    expect(await f.install('unsupported', 0)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'operation-unavailable' },
    })
    expect(peer.methods).toEqual(['synchronize'])
    peer.peer.close()
    expect(f.lifecycle.prepare('still-available').expectedRegistryEpoch).toBe(0)
    await f.lifecycle.abort('still-available')
  } finally {
    await f.close()
  }
}, 30000)

it.each(['ready', 'disconnect'] as const)(
  'freezes admission and prepare while preflight is pending: %s',
  async mode => {
    let entered!: () => void
    const reached = new Promise<void>(resolve => entered = resolve)
    let release!: () => void
    const blocked = new Promise<void>(resolve => release = resolve)
    const f = await fixture({
      blockProjection: async () => {
        entered()
        await blocked
      },
    })
    try {
      const participant = await f.attach('first')
      expect(() => f.lifecycle.prepare('without-preflight')).toThrow('admission is required')
      const active = await f.store.loadActive()
      const candidate = {
        ...active,
        recordKind: 'candidate' as const,
        transactionId: 'preflight-race',
        revision: active.revision + 1,
        lastGoodRevision: active.revision,
        plugins: [{
          id: 'test',
          version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}` as const,
          moduleGeneration: 'test-generation',
          enabled: true,
          dependencies: [],
        }],
      }
      const pending = f.lifecycle.preflight({
        transactionId: 'preflight-race',
        operation: 'install',
        previous: active,
        candidate,
        targetId: 'test',
      })
      await reached
      expect(() => f.lifecycle.prepare('preflight-race')).toThrow('admission is still in progress')
      const late = new ManagerRendererCommandPeer({
        scope: f.scope,
        identity: {
          appId: 'codex',
          adapterId: 'manager',
          rendererId: 'late',
          pid: process.pid,
          processStartedAt: 'fixture',
        },
        sessionId: secret(),
      })
      await expect(f.lifecycle.attach(late)).rejects.toThrow('unavailable')
      expect(late.closed).toBe(true)
      if (mode === 'disconnect') participant.peer.close()
      release()
      if (mode === 'ready') {
        await pending
        expect(f.lifecycle.prepare('preflight-race').expectedRegistryEpoch).toBe(0)
        await f.lifecycle.abort('preflight-race')
      } else {
        await expect(pending).rejects.toThrow()
        expect(f.lifecycle.prepare('after-detach').expectedRegistryEpoch).toBe(0)
        await f.lifecycle.abort('after-detach')
      }
    } finally {
      release()
      await f.close()
    }
  },
  30000,
)

it('rejects a federation reservation if a peer leaves after preflight', async () => {
  const f = await fixture()
  try {
    const active = await f.store.loadActive()
    const federation = new RendererLifecycleFederation({
      scope: f.scope,
      active,
      registryEpoch: 0,
      projectMutation: () => ({}),
    })
    const makePeer = (rendererId: string): AttachedRendererPeer => {
      const listeners = new Set<() => void>()
      let closed = false
      return {
        scope: f.scope,
        identity: { appId: 'codex', adapterId: 'manager', rendererId, pid: process.pid, processStartedAt: 'fixture' },
        sessionId: secret(),
        get closed() {
          return closed
        },
        request: async (_method, payload) => payload,
        onDisconnect(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close() {
          if (closed) return
          closed = true
          for (const listener of listeners) listener()
        },
      }
    }
    const first = makePeer('federation-first')
    const second = makePeer('federation-second')
    await federation.attach(first)
    await federation.attach(second)
    const candidate = {
      ...active,
      recordKind: 'candidate' as const,
      transactionId: 'federation-reservation',
      revision: active.revision + 1,
      lastGoodRevision: active.revision,
      plugins: [{
        id: 'test',
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}` as const,
        moduleGeneration: 'test-generation',
        enabled: true,
        dependencies: [],
      }],
    }
    const input = {
      transactionId: 'federation-reservation',
      operation: 'install' as const,
      previous: active,
      candidate,
      targetId: 'test',
    }
    await federation.preflight(input)
    first.close()
    expect(() => federation.prepare(input.transactionId)).toThrow('admission became stale')
    await federation.preflight(input)
    expect(federation.prepare(input.transactionId).expectedRegistryEpoch).toBe(0)
    await federation.abort(input.transactionId)
    second.close()
  } finally {
    await f.close()
  }
}, 30000)

it('keeps renderer attachment unavailable until the owner supplies a projector', async () => {
  const f = await fixture()
  const withoutProjection = new ServiceRendererLifecycle({ scope: f.scope })
  const peer = new ManagerRendererCommandPeer({
    scope: f.scope,
    identity: {
      appId: 'codex',
      adapterId: 'manager',
      rendererId: 'blocked',
      pid: process.pid,
      processStartedAt: 'fixture',
    },
    sessionId: secret(),
  })
  try {
    withoutProjection.initialize(await f.store.loadActive())
    await expect(withoutProjection.attach(peer)).rejects.toThrow('attachment is disabled')
    expect(peer.closed).toBe(true)
    expect(withoutProjection.prepare('headless-still-available').expectedRegistryEpoch).toBe(0)
    await withoutProjection.abort('headless-still-available')
  } finally {
    await withoutProjection.close()
    await f.close()
  }
}, 30000)

it('finishes an interrupted package rollback before service renderer initialization', async () => {
  const f = await fixture({ rollbackPending: true })
  try {
    expect(await f.store.loadActive()).toMatchObject({ revision: 2, plugins: [] })
    expect(f.lifecycle.prepare('after-startup-recovery').expectedRegistryEpoch).toBe(2)
    await f.lifecycle.abort('after-startup-recovery')
    expect(await f.install('after-recovery', 2)).toMatchObject({ outcome: 'applied', revision: 3 })
  } finally {
    await f.close()
  }
}, 30000)

it('revokes every service renderer when the owner enters terminal failure', async () => {
  const f = await fixture()
  try {
    const first = await f.attach('first')
    const second = await f.attach('second')
    f.lifecycle.terminal(new Error('fixture terminal failure'))
    expect(first.peer.closed).toBe(true)
    expect(second.peer.closed).toBe(true)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
    expect(() => f.lifecycle.snapshot()).toThrow('unavailable')
  } finally {
    await f.close()
  }
}, 30_000)
