import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, type HomeConfigIconThemePreference } from '../packages/cli/src/config/home-config.js'
import {
  IconThemePreferenceBroadcastHub,
  IconThemePreferenceConflictError,
  parseIconThemePreferenceBindingRequest,
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

  it('replays only the highest durable winner to late same-profile receivers in serialized order', async () => {
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const first: HomeConfigIconThemePreference[] = []
    const second: HomeConfigIconThemePreference[] = []
    const winner = { revision: 1, ...candidate }
    await hub.broadcast(winner)
    const replayStarted = deferred()
    const releaseReplay = deferred()
    const registerFirst = hub.register(async preference => {
      first.push(preference)
      replayStarted.resolve()
      await releaseReplay.promise
    })
    await replayStarted.promise
    const next = { ...winner, revision: 2 }
    const broadcastNext = hub.broadcast(next)
    await hub.broadcast({ ...winner, revision: 1 })
    releaseReplay.resolve()
    const removeFirst = await registerFirst
    await broadcastNext
    expect(first).toEqual([winner, next])

    const removeSecond = await hub.register(async preference => { second.push(preference) })
    expect(second).toEqual([next])
    await hub.broadcast({ ...next })
    expect(second).toEqual([next])
    removeFirst()
    removeSecond()
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
      defaultHub.register(async preference => { observedDefault.push(preference) }),
      workHub.register(async preference => { observedWork.push(preference) }),
    ])
    expect(defaultHub.appId).toBe('codex')
    expect(defaultHub.profileId).toBe('default')
    expect(workHub.profileId).toBe('work')
    expect(() => defaultHub.assertScope({ appId: 'codex', profileId: 'work' })).toThrow('scope is mismatched')
    expect(observedDefault).toEqual([{ revision: 4, ...candidate }])
    expect(observedWork).toEqual([])
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
  })
})
