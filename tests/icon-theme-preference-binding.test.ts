import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HomeConfigIconThemePreference } from '../packages/cli/src/config/home-config.js'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'

const candidate = {
  providerId: 'plugin:aurora:aurora' as const,
  namespace: 'aurora',
  providerVersion: '2.1.0',
  providerGeneration: 'aurora-3',
}

let readyLeaseRevision = 0
function readyLease(): { readonly readyLeaseToken: string; readonly readyLeaseRevision: number } {
  readyLeaseRevision += 1
  return {
    readyLeaseToken: `ready_test_${String(readyLeaseRevision).padStart(8, '0')}`,
    readyLeaseRevision,
  }
}

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceRequestV1')
  Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceReceiveV1')
})

describe('browser icon-theme preference bridge', () => {
  it('keeps a pending document booting until a bounded same-epoch redrive acknowledges the required winner', async () => {
    vi.useFakeTimers()
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 1, ...candidate })
    const ready = bridge.ready()
    const first = requests[0]!
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: first.requestId, ok: true,
      ...readyLease(),
      documentEpoch: first.documentEpoch, synchronization: 'pending', requiredRevision: 2, currentRevision: 1,
    }))
    await vi.advanceTimersByTimeAsync(25)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ documentEpoch: first.documentEpoch, currentRevision: 1 })

    const winner = { revision: 2, ...candidate }
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: winner }))
    const second = requests[1]!
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: second.requestId, ok: true,
      ...readyLease(),
      documentEpoch: second.documentEpoch, synchronization: 'complete', requiredRevision: 2, currentRevision: 2,
    }))
    await expect(ready).resolves.toBeUndefined()
    expect(bridge.current()).toEqual(winner)
    bridge.dispose()
  })

  it('bounds permanent pending retries, permits a later explicit ready round, and cancels backoff on dispose', async () => {
    vi.useFakeTimers()
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 1, ...candidate })
    const respondPending = (index: number): void => {
      const request = requests[index]!
      globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
        kind: 'document-ready', requestId: request.requestId, ok: true,
        ...readyLease(),
        documentEpoch: request.documentEpoch, synchronization: 'pending', requiredRevision: 2, currentRevision: 1,
      }))
    }
    const unavailable = bridge.ready()
    respondPending(0)
    await vi.advanceTimersByTimeAsync(25)
    respondPending(1)
    await vi.advanceTimersByTimeAsync(50)
    respondPending(2)
    await expect(unavailable).rejects.toThrow('remains pending at revision 1; required 2')
    expect(requests).toHaveLength(3)

    const recovered = bridge.ready()
    const fourth = requests[3]!
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: { revision: 2, ...candidate } }))
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: fourth.requestId, ok: true,
      ...readyLease(),
      documentEpoch: fourth.documentEpoch, synchronization: 'complete', requiredRevision: 2, currentRevision: 2,
    }))
    await expect(recovered).resolves.toBeUndefined()

    const pendingDispose = bridge.ready()
    const fifth = requests[4]!
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: fifth.requestId, ok: true,
      ...readyLease(),
      documentEpoch: fifth.documentEpoch, synchronization: 'pending', requiredRevision: 3, currentRevision: 2,
    }))
    await Promise.resolve()
    bridge.dispose()
    await expect(pendingDispose).rejects.toThrow('disposed')
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(5)
  })

  it('handshakes one document epoch and requires an acknowledged current revision', async () => {
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 4, ...candidate })
    const rejected = bridge.ready()
    const first = requests[0]!
    expect(first).toMatchObject({
      kind: 'document-ready',
      scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-12' },
      currentRevision: 4,
    })
    expect(first.documentEpoch).toMatch(/^doc_[A-Za-z0-9_]+$/u)
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: first.requestId, ok: true,
      ...readyLease(),
      documentEpoch: 'doc_wrong_epoch', synchronization: 'complete', requiredRevision: 4, currentRevision: 4,
    }))).toThrow('acknowledgement is invalid')
    const acceptedLease = readyLease()
    const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: first.requestId, ok: true,
      ...acceptedLease,
      documentEpoch: first.documentEpoch, synchronization: 'complete', requiredRevision: 4, currentRevision: 4,
    }))
    await expect(rejected).resolves.toBeUndefined()
    expect(ack).toEqual({ documentEpoch: first.documentEpoch, currentRevision: 4, ...acceptedLease })

    const disposed = bridge.ready()
    bridge.dispose()
    await expect(disposed).rejects.toThrow('disposed')
  })

  it('fails a stale ready lease closed while keeping the exact request available for its replacement lease', async () => {
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 1, ...candidate })
    const ready = bridge.ready()
    const request = requests[0]!
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: { revision: 3, ...candidate } }))
    const oldPendingLease = readyLease()
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...oldPendingLease,
      documentEpoch: request.documentEpoch, synchronization: 'pending', requiredRevision: 3, currentRevision: 2,
    }))).toThrow('response lease is stale')
    const invalidReplacement = readyLease()
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      readyLeaseToken: 'not-a-valid-token', readyLeaseRevision: invalidReplacement.readyLeaseRevision,
      documentEpoch: request.documentEpoch, synchronization: 'complete', requiredRevision: 3, currentRevision: 3,
    }))).toThrow('response lease is stale')
    const replacementLease = readyLease()
    const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...replacementLease,
      documentEpoch: request.documentEpoch, synchronization: 'complete', requiredRevision: 3, currentRevision: 3,
    }))
    await expect(ready).resolves.toBeUndefined()
    expect(ack).toEqual({ documentEpoch: request.documentEpoch, currentRevision: 3, ...replacementLease })
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...replacementLease,
      documentEpoch: request.documentEpoch, synchronization: 'complete', requiredRevision: 3, currentRevision: 3,
    }))).toThrow('unknown or expired')
    bridge.dispose()
  })

  it('rejects a late ready response after the exact request expires', async () => {
    vi.useFakeTimers()
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 3, ...candidate })
    const ready = bridge.ready()
    const expired = expect(ready).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await expired
    const request = requests[0]!
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...readyLease(),
      documentEpoch: request.documentEpoch, synchronization: 'complete', requiredRevision: 3, currentRevision: 3,
    }))).toThrow('unknown or expired')
    bridge.dispose()
  })

  it('retains an accepted pending request and requires a strictly newer opaque replacement lease', async () => {
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requests.push(JSON.parse(payload) as Record<string, unknown>) }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 1, ...candidate })
    const ready = bridge.ready()
    const request = requests[0]!
    const pendingLease = readyLease()
    const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...pendingLease,
      documentEpoch: request.documentEpoch, synchronization: 'pending', requiredRevision: 2, currentRevision: 1,
    }))
    expect(ack).toEqual({ documentEpoch: request.documentEpoch, currentRevision: 1, ...pendingLease })
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      ...pendingLease,
      documentEpoch: request.documentEpoch, synchronization: 'pending', requiredRevision: 2, currentRevision: 1,
    }))).toThrow('response lease is stale')
    expect(() => globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      kind: 'document-ready', requestId: request.requestId, ok: true,
      readyLeaseToken: 'ready_divergent_00000001', readyLeaseRevision: pendingLease.readyLeaseRevision,
      documentEpoch: request.documentEpoch, synchronization: 'pending', requiredRevision: 2, currentRevision: 1,
    }))).toThrow('response lease is stale')
    await Promise.resolve()
    const disposed = expect(ready).rejects.toThrow('disposed')
    bridge.dispose()
    await disposed
  })

  it('correlates an exact generation/revision response and ignores a late duplicate', async () => {
    let request: Record<string, unknown> | undefined
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { request = JSON.parse(payload) as Record<string, unknown> }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', undefined)
    const pending = bridge.persist(2, 3, {
      ...candidate,
      status: 'active',
      coverage: { kind: 'partial', tuples: ['action.save\u0000regular\u0000default'] },
      tupleCount: 1,
    } as typeof candidate)
    expect(request).toMatchObject({
      scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-12' },
      expectedPreferenceRevision: 0,
      expectedProfileRevision: 2,
      selectedProfileRevision: 3,
      candidate,
    })
    expect(Object.keys(request?.candidate as Record<string, unknown>).sort()).toEqual([
      'namespace', 'providerGeneration', 'providerId', 'providerVersion',
    ])
    const requestId = request?.requestId
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      requestId, ok: true, value: { revision: 1, ...candidate }, synchronization: 'pending',
    }))
    await expect(pending).resolves.toEqual({ revision: 1, ...candidate })
    expect(bridge.revision()).toBe(1)
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ requestId, ok: true, value: { revision: 99, ...candidate } }))
    expect(bridge.revision()).toBe(1)
    bridge.dispose()
  })

  it('rejects mismatched responses and fences pending work on dispose', async () => {
    let requestId = ''
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requestId = (JSON.parse(payload) as { requestId: string }).requestId }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 4, ...candidate })
    const mismatch = bridge.persist(7, 8, candidate)
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      requestId,
      ok: true,
      value: { revision: 5, ...candidate, providerGeneration: 'aurora-late' },
    }))
    await expect(mismatch).rejects.toThrow('mismatched')
    const pending = bridge.persist(8, 9, candidate)
    bridge.dispose()
    await expect(pending).rejects.toThrow('disposed')
    expect(globalThis.__cordisxIconThemePreferenceReceiveV1).toBeUndefined()
  })

  it('adopts a conflict winner and fences stale sync and post-dispose messages', async () => {
    let requestId = ''
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => { requestId = (JSON.parse(payload) as { requestId: string }).requestId }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', { revision: 1, ...candidate })
    const observed: string[] = []
    bridge.subscribe(preference => observed.push(`${preference.revision}:${preference.providerId}`))
    const pending = bridge.persist(4, 5, candidate)
    const builtin = {
      revision: 2,
      providerId: 'builtin:reicon' as const,
      namespace: 'reicon',
      providerVersion: '1.2.1',
      providerGeneration: 'reicon-1.2.1',
    }
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      requestId, ok: false, code: 'conflict', currentPreference: builtin, synchronization: 'pending',
    }))
    await expect(pending).rejects.toThrow('conflict')
    expect(bridge.current()).toEqual(builtin)
    expect(observed).toEqual(['2:builtin:reicon'])

    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: { revision: 1, ...candidate } }))
    expect(bridge.current()).toEqual(builtin)
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: { revision: 3, ...candidate } }))
    expect(bridge.current()).toEqual({ revision: 3, ...candidate })
    bridge.dispose()
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: { revision: 4, ...builtin } }))
    expect(bridge.current()).toEqual({ revision: 3, ...candidate })
  })

  it('retains success and conflict winners that arrive before a runtime consumer subscribes', async () => {
    let requestId = ''
    globalThis.__cordisxIconThemePreferenceRequestV1 = payload => {
      requestId = (JSON.parse(payload) as { requestId: string }).requestId
    }
    const bridge = new BrowserIconThemePreferenceBridge('token', 'codex', 'default', 'host-12', undefined)
    const builtin = {
      revision: 1,
      providerId: 'builtin:reicon' as const,
      namespace: 'reicon',
      providerVersion: '1.2.1',
      providerGeneration: 'reicon-1.2.1',
    }
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ kind: 'sync', value: builtin }))
    const observed: HomeConfigIconThemePreference[] = []
    bridge.subscribe(preference => observed.push(preference))
    expect(observed).toEqual([])
    expect(bridge.current()).toEqual(builtin)

    const pending = bridge.persist(9, 10, candidate)
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
      requestId,
      ok: false,
      code: 'conflict',
      currentPreference: { revision: 2, ...candidate },
    }))
    await expect(pending).rejects.toThrow('conflict')
    expect(observed).toEqual([{ revision: 2, ...candidate }])
    expect(bridge.current()).toEqual({ revision: 2, ...candidate })
    bridge.dispose()
  })
})
