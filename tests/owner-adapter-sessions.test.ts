import { describe, expect, it, vi } from 'vitest'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { verifyOwnerPolicyPacket } from '../packages/cli/src/renderer/owner-policy-verification.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'default', generation: 'owner-1' }
const active: CordisXPluginActivationRecordV1 = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1,
  recordKind: 'active',
  profileId: scope.profileId,
  runtimeGeneration: scope.generation,
  revision: 2,
  lastGoodRevision: 2,
  plugins: [],
}
const snapshot = { active, registryEpoch: 3 }
const processIdentity = { pid: 123, processStartedAt: 'start-1' }

describe('owner adapter sessions', () => {
  it('admits only a live process after it confirms the owner snapshot', async () => {
    const attach = vi.fn(async peer => {
      expect(await peer.request('synchronize', snapshot)).toEqual(snapshot)
    })
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => snapshot,
      attach,
      ownerCurrent: () => true,
      identify: async () => 'alive',
    })
    try {
      const opened = await sessions.open(processIdentity)
      expect(opened).toMatchObject({ snapshot, rendererId: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      const { sessionId, grant } = opened!
      expect(await sessions.poll(sessionId, 'f'.repeat(64), 100)).toBeUndefined()
      const admitting = sessions.admit(sessionId, grant)
      const polled = await sessions.poll(sessionId, grant, 1_000)
      expect(polled?.command).toMatchObject({ method: 'synchronize', payload: snapshot })
      const command = polled!.command!
      expect(
        await sessions.acknowledge(sessionId, grant, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: snapshot,
        }),
      ).toBe(true)
      expect(await admitting).toBe(true)
      expect(attach).toHaveBeenCalledOnce()

      const reservation = sessions.reserve()
      expect(reservation.peers).toHaveLength(1)
      const transition = {
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        rendererId: opened!.rendererId,
        handoffId: 'b'.repeat(64),
        requestId: 'policy-1',
        origin: false as const,
        identity: { id: 'demo', source: 'https://example.com/demo' },
        moduleGeneration: 'module-1',
        expected: [],
        updates: [{}],
        candidate: [{}],
      }
      const packet = sessions.signPolicy(reservation.peers[0]!, transition)
      expect(
        await verifyOwnerPolicyPacket(packet, {
          profileId: scope.profileId,
          generation: scope.generation,
          rendererId: opened!.rendererId,
          key: opened!.policyPublicKey,
        }),
      ).toEqual(transition)
      expect(await sessions.open({ pid: 456, processStartedAt: 'start-2' })).toBeUndefined()
      expect(reservation.release()).toBe(true)
      expect(() => sessions.signPolicy(reservation.peers[0]!, transition)).toThrow('adapter-policy-handoff-unavailable')
      expect(await sessions.end(sessionId, grant)).toBe(true)
      expect(await sessions.poll(sessionId, grant, 100)).toBeUndefined()
    } finally {
      sessions.close()
    }
  })

  it('retires a session if its process identity is lost', async () => {
    let alive = true
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => snapshot,
      attach: async () => {},
      ownerCurrent: () => true,
      identify: async () => alive ? 'alive' : 'dead',
    })
    try {
      const opened = (await sessions.open(processIdentity))!
      expect(await sessions.admit(opened.sessionId, opened.grant)).toBe(true)
      const reservation = sessions.reserve()
      alive = false
      expect(await sessions.poll(opened.sessionId, opened.grant, 100)).toBeUndefined()
      expect(reservation.isCurrent()).toBe(false)
      expect(reservation.release()).toBe(false)
    } finally {
      sessions.close()
    }
  })

  it('rejects a snapshot that changes during admission', async () => {
    let reads = 0
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => ({ ...snapshot, registryEpoch: reads++ }),
      attach: async () => {},
      ownerCurrent: () => true,
      identify: async () => 'alive',
    })
    try {
      expect(await sessions.open(processIdentity)).toBeUndefined()
      const reservation = sessions.reserve()
      expect(reservation.peers).toEqual([])
      expect(reservation.release()).toBe(true)
    } finally {
      sessions.close()
    }
  })

  it('allows only snapshot-bound document reads before admission and fences writes during transitions', async () => {
    let currentSnapshot = snapshot
    const documents = vi.fn(async (_payload, context) => ({ secret: context.secret, canWrite: context.current(true) }))
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => currentSnapshot,
      attach: async () => {},
      ownerCurrent: () => true,
      identify: async () => 'alive',
      document: documents,
    })
    try {
      const opened = (await sessions.open(processIdentity))!
      expect(await sessions.requestDocument(opened.sessionId, opened.grant, { operation: 'replace' }))
        .toEqual({ available: false })
      expect(await sessions.requestDocument(opened.sessionId, opened.grant, { operation: 'load' })).toEqual({
        available: true,
        value: { secret: opened.documentSecret, canWrite: false },
      })
      currentSnapshot = { ...snapshot, registryEpoch: snapshot.registryEpoch + 1 }
      expect(await sessions.requestDocument(opened.sessionId, opened.grant, { operation: 'load' }))
        .toEqual({ available: false })
      currentSnapshot = snapshot
      expect(await sessions.admit(opened.sessionId, opened.grant)).toBe(true)
      const reservation = sessions.reserve()
      expect(await sessions.requestDocument(opened.sessionId, opened.grant, { operation: 'replace' }))
        .toEqual({ available: false })
      expect(reservation.release()).toBe(true)
      expect(await sessions.requestDocument(opened.sessionId, opened.grant, { operation: 'replace' })).toEqual({
        available: true,
        value: { secret: opened.documentSecret, canWrite: true },
      })
    } finally {
      sessions.close()
    }
  })

  it('blocks other adapter calls during an owner lifecycle reservation', async () => {
    let releaseRead!: () => void
    let readStarted!: () => void
    const started = new Promise<void>(resolve => readStarted = resolve)
    const wait = new Promise<void>(resolve => releaseRead = resolve)
    let sessionId = ''
    let grant = ''
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => snapshot,
      attach: async () => {},
      ownerCurrent: () => true,
      identify: async () => 'alive',
      management: async () => {
        readStarted()
        await wait
        return 'read'
      },
      lifecycle: async () => {
        const reservation = sessions.reserve()
        expect(reservation.isCurrent()).toBe(true)
        expect(await sessions.requestManagement(sessionId, grant, {})).toEqual({ available: false })
        expect(reservation.release()).toBe(true)
        return 'committed'
      },
    })
    try {
      const opened = (await sessions.open(processIdentity))!
      sessionId = opened.sessionId
      grant = opened.grant
      expect(await sessions.admit(sessionId, grant)).toBe(true)
      const read = sessions.requestManagement(sessionId, grant, {})
      await started
      expect(() => sessions.reserve()).toThrow('adapter-reservation-unavailable')
      const pendingReservation = sessions.reserveForLifecycle()
      expect(await sessions.requestLifecycle(sessionId, grant, {})).toEqual({ available: false })
      releaseRead()
      expect(await read).toEqual({ available: true, value: 'read' })
      const reservation = await pendingReservation
      expect(reservation.isCurrent()).toBe(true)
      expect(reservation.release()).toBe(true)
      expect(await sessions.requestLifecycle(sessionId, grant, {})).toEqual({ available: true, value: 'committed' })
    } finally {
      releaseRead?.()
      sessions.close()
    }
  })

  it('scopes artifact cancellation to its adapter and handles cancellation before dispatch', async () => {
    const started = vi.fn()
    let aborted = false
    const artifact = vi.fn(async (_request, signal: AbortSignal) =>
      await new Promise<string>(resolve => {
        started()
        signal.addEventListener('abort', () => {
          aborted = true
          resolve('cancelled')
        }, { once: true })
      })
    )
    const sessions = new OwnerAdapterSessions({
      scope,
      adapter: { appId: 'codex', adapterId: 'codex-desktop' },
      snapshot: () => snapshot,
      attach: async () => {},
      ownerCurrent: () => true,
      identify: async () => 'alive',
      artifact,
    })
    const preview = (requestId: string) => ({
      kind: 'preview',
      requestId,
      request: {
        schemaVersion: 8,
        pluginId: 'demo',
        version: '1.0.0',
        canonicalSource: 'https://example.com/plugins',
        artifact: {
          packageName: 'demo',
          downloadUrl: 'https://example.com/demo.tgz',
          integrity: `sha256:${'a'.repeat(64)}`,
        },
      },
    })
    const cancel = (targetRequestId: string) => ({
      kind: 'cancel',
      requestId: `cancel-${targetRequestId}`,
      targetRequestId,
    })
    try {
      const first = (await sessions.open(processIdentity))!
      const second = (await sessions.open({ pid: 456, processStartedAt: 'start-2' }))!
      expect(await sessions.admit(first.sessionId, first.grant)).toBe(true)
      expect(await sessions.admit(second.sessionId, second.grant)).toBe(true)
      const pending = sessions.requestArtifact(first.sessionId, first.grant, preview('first'))
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
      await sessions.requestArtifact(second.sessionId, second.grant, cancel('first'))
      expect(aborted).toBe(false)
      await sessions.requestArtifact(first.sessionId, first.grant, cancel('first'))
      expect(await pending).toEqual({ available: true, value: 'cancelled' })
      expect(aborted).toBe(true)
      await sessions.requestArtifact(first.sessionId, first.grant, cancel('later'))
      expect(await sessions.requestArtifact(first.sessionId, first.grant, preview('later')))
        .toEqual({ available: false })
      expect(artifact).toHaveBeenCalledOnce()
    } finally {
      sessions.close()
    }
  })
})
