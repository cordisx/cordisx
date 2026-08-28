import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, type HomeConfigIconThemePreference } from '../packages/cli/src/config/home-config.js'
import {
  IconThemePreferenceBroadcastHub,
  IconThemePreferenceConflictError,
  iconThemePreferenceBridgeError,
  parseIconThemePreferenceBindingRequest,
  parseIconThemePreferenceDocumentReadyRequest,
  persistIconThemePreference,
  type IconThemePreferencePersistenceContext,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'

const token = 'a'.repeat(64)
const candidate = {
  providerId: 'plugin:aurora:aurora' as const,
  namespace: 'aurora',
  providerVersion: '2.1.0',
  providerGeneration: 'aurora-3',
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function context(): Promise<IconThemePreferencePersistenceContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-preference-'))
  const configPath = path.join(root, '.cordisx', 'config.json')
  await ensureHomeConfig(configPath)
  return { configPath, appId: 'codex', profileId: 'default', hostGeneration: 'host-12', token }
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    token,
    requestId: 'icon-preference-1',
    scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-12' },
    expectedPreferenceRevision: 0,
    expectedProfileRevision: 2,
    selectedProfileRevision: 3,
    candidate,
    ...overrides,
  }
}

describe('Host icon-theme preference persistence', () => {
  it('persists an exact redacted identity with profile and revision CAS fencing', async () => {
    const ctx = await context()
    const request = parseIconThemePreferenceBindingRequest(payload(), ctx)
    await expect(persistIconThemePreference(ctx, request)).resolves.toEqual({ revision: 1, ...candidate })
    expect((await loadHomeConfig(ctx.configPath)).apps.codex?.profiles.default?.iconTheme).toEqual({ revision: 1, ...candidate })
    const conflict = await persistIconThemePreference(ctx, request).catch(error => error as IconThemePreferenceConflictError)
    expect(conflict).toBeInstanceOf(IconThemePreferenceConflictError)
    expect(conflict.currentPreference).toEqual({ revision: 1, ...candidate })

    const next = parseIconThemePreferenceBindingRequest(payload({
      requestId: 'icon-preference-2',
      expectedPreferenceRevision: 1,
      expectedProfileRevision: 3,
      selectedProfileRevision: 4,
      candidate: {
        providerId: 'builtin:reicon', namespace: 'reicon', providerVersion: '1.2.1', providerGeneration: 'reicon-1.2.1',
      },
    }), ctx)
    await expect(persistIconThemePreference(ctx, next)).resolves.toMatchObject({ revision: 2, providerId: 'builtin:reicon' })
  })

  it('does not synthesize a durable winner when a conflict has no current preference', async () => {
    const ctx = await context()
    const request = parseIconThemePreferenceBindingRequest(payload({ expectedPreferenceRevision: 9 }), ctx)
    const conflict = await persistIconThemePreference(ctx, request).catch(error => error as IconThemePreferenceConflictError)
    expect(conflict).toBeInstanceOf(IconThemePreferenceConflictError)
    expect(conflict.currentPreference).toBeUndefined()
    expect(iconThemePreferenceBridgeError(conflict)).toEqual({
      code: 'conflict',
      error: 'icon theme preference revision conflict: expected a different revision; actual 0',
      actualRevision: 0,
    })
  })

  it('replays only the highest durable winner to late same-profile receivers in serialized order', async () => {
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const first: HomeConfigIconThemePreference[] = []
    const second: HomeConfigIconThemePreference[] = []
    const winner = { revision: 1, ...candidate }
    await hub.broadcast(winner)
    const replayStarted = deferred()
    const releaseReplay = deferred()
    const registerFirst = hub.register({
      targetId: 'target-a', sessionId: 'session-a', documentEpoch: 'document_a', currentRevision: 0,
      receive: async preference => {
        first.push(preference)
        replayStarted.resolve()
        await releaseReplay.promise
        return { documentEpoch: 'document_a', currentRevision: preference.revision }
      },
    })
    await replayStarted.promise
    const next = { ...winner, revision: 2 }
    const broadcastNext = hub.broadcast(next)
    await hub.broadcast({ ...winner, revision: 1 })
    releaseReplay.resolve()
    const firstRegistration = await registerFirst
    await broadcastNext
    expect(first).toEqual([winner, next])

    const secondRegistration = await hub.register({
      targetId: 'target-b', sessionId: 'session-b', documentEpoch: 'document_b', currentRevision: 0,
      receive: async preference => {
        second.push(preference)
        return { documentEpoch: 'document_b', currentRevision: preference.revision }
      },
    })
    expect(second).toEqual([next])
    await hub.broadcast({ ...next })
    expect(second).toEqual([next])
    await expect(hub.broadcast({ ...next, providerGeneration: 'divergent-generation' }))
      .rejects.toThrow('winner revision is divergent')
    await hub.broadcast({ ...winner })
    expect(hub.current()).toEqual(next)
    firstRegistration.unregister()
    secondRegistration.unregister()
    await hub.broadcast({ ...winner, revision: 3 })
    expect(first).toEqual([winner, next])
    expect(second).toEqual([next])
    expect(first[0]).not.toBe(winner)
  })

  it('keeps durable winners isolated between profile-scoped hubs', async () => {
    const defaultHub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const workHub = new IconThemePreferenceBroadcastHub('codex', 'work')
    const observedDefault: HomeConfigIconThemePreference[] = []
    const observedWork: HomeConfigIconThemePreference[] = []
    await defaultHub.broadcast({ revision: 4, ...candidate })
    await Promise.all([
      defaultHub.register({
        targetId: 'target', sessionId: 'default-session', documentEpoch: 'default_doc', currentRevision: 0,
        receive: async preference => {
          observedDefault.push(preference)
          return { documentEpoch: 'default_doc', currentRevision: preference.revision }
        },
      }),
      workHub.register({
        targetId: 'target', sessionId: 'work-session', documentEpoch: 'work_doc_1', currentRevision: 0,
        receive: async preference => {
          observedWork.push(preference)
          return { documentEpoch: 'work_doc_1', currentRevision: preference.revision }
        },
      }),
    ])
    expect(defaultHub.appId).toBe('codex')
    expect(defaultHub.profileId).toBe('default')
    expect(workHub.profileId).toBe('work')
    expect(() => defaultHub.assertScope({ appId: 'codex', profileId: 'work' })).toThrow('scope is mismatched')
    expect(observedDefault).toEqual([{ revision: 4, ...candidate }])
    expect(observedWork).toEqual([])
  })

  it('keeps failed delivery pending and re-drives the same winner after the receiver recovers', async () => {
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    await hub.broadcast({ revision: 1, ...candidate })
    let attempts = 0
    let recovered = false
    const registration = await hub.register({
      targetId: 'target', sessionId: 'session', documentEpoch: 'document_retry', currentRevision: 0,
      receive: async preference => {
        attempts += 1
        if (!recovered) throw new Error('receiver missing during document install')
        return { documentEpoch: 'document_retry', currentRevision: preference.revision }
      },
    })
    expect(attempts).toBe(2)
    expect(registration).toMatchObject({ currentRevision: 0, synchronization: 'pending' })
    expect(hub.current()).toEqual({ revision: 1, ...candidate })
    recovered = true
    await expect(hub.retryPending()).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, pending: 0 })
    expect(attempts).toBe(3)
    registration.unregister()

    const permanent = await hub.register({
      targetId: 'bad-target', sessionId: 'bad-session', documentEpoch: 'document_bad', currentRevision: 0,
      receive: async preference => ({ documentEpoch: 'wrong_document', currentRevision: preference.revision - 1 }),
    })
    expect(permanent).toMatchObject({ currentRevision: 0, synchronization: 'pending' })
    await expect(hub.retryPending()).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1, pending: 1 })
    permanent.unregister()
  })

  it('supersedes a failed pending revision and cancels delivery after document disposal', async () => {
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const firstAttempt = deferred()
    const releaseFirst = deferred()
    const observed: number[] = []
    const registration = await hub.register({
      targetId: 'target', sessionId: 'session', documentEpoch: 'document_supersede', currentRevision: 0,
      receive: async preference => {
        observed.push(preference.revision)
        if (preference.revision === 1) {
          firstAttempt.resolve()
          await releaseFirst.promise
          throw new Error('old context delivery failed')
        }
        return { documentEpoch: 'document_supersede', currentRevision: preference.revision }
      },
    })
    const first = hub.broadcast({ revision: 1, ...candidate })
    await firstAttempt.promise
    const second = hub.broadcast({ revision: 2, ...candidate })
    releaseFirst.resolve()
    expect(await first).toEqual({ attempted: 1, delivered: 1, failed: 0, pending: 0 })
    expect(await second).toEqual({ attempted: 1, delivered: 1, failed: 0, pending: 0 })
    expect(observed).toEqual([1, 2])

    const disposeHub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const deliveryStarted = deferred()
    const releaseDelivery = deferred()
    registration.unregister()
    const disposed = await disposeHub.register({
      targetId: 'target', sessionId: 'session', documentEpoch: 'document_dispose', currentRevision: 0,
      receive: async preference => {
        deliveryStarted.resolve()
        await releaseDelivery.promise
        return { documentEpoch: 'document_dispose', currentRevision: preference.revision }
      },
    })
    const late = disposeHub.broadcast({ revision: 3, ...candidate })
    await deliveryStarted.promise
    disposed.unregister()
    releaseDelivery.resolve()
    expect(await late).toEqual({ attempted: 1, delivered: 0, failed: 1, pending: 0 })
  })

  it('rejects generation spoofing, malformed transitions, raw/private fields, and hostile identities', async () => {
    const ctx = await context()
    const cases = [
      payload({ scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-11' } }),
      payload({ selectedProfileRevision: 4 }),
      payload({ candidate: { ...candidate, providerHandle: 'iph_private' } }),
      payload({ candidate: { ...candidate, status: 'active', coverage: { kind: 'complete' }, tupleCount: 1_224 } }),
      payload({ candidate: { ...candidate, providerGeneration: '/tmp/private-provider' } }),
      { ...payload(), principalHandle: 'ipp_private' },
    ]
    for (const hostile of cases) expect(() => parseIconThemePreferenceBindingRequest(hostile, ctx)).toThrow()

    const ready = {
      version: 1,
      kind: 'document-ready',
      token,
      requestId: 'document-ready-1',
      scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-12' },
      documentEpoch: 'document_epoch_1',
      currentRevision: 7,
    }
    expect(parseIconThemePreferenceDocumentReadyRequest(ready, ctx)).toEqual({
      requestId: 'document-ready-1', documentEpoch: 'document_epoch_1', currentRevision: 7,
    })
    expect(() => parseIconThemePreferenceDocumentReadyRequest({ ...ready, providerHandle: 'private' }, ctx)).toThrow('shape is invalid')
    expect(() => parseIconThemePreferenceDocumentReadyRequest({ ...ready, documentEpoch: '../old-document' }, ctx)).toThrow('epoch is invalid')
  })
})
