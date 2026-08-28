import { afterEach, describe, expect, it } from 'vitest'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'

const candidate = {
  providerId: 'plugin:aurora:aurora' as const,
  namespace: 'aurora',
  providerVersion: '2.1.0',
  providerGeneration: 'aurora-3',
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceRequestV1')
  Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceReceiveV1')
})

describe('browser icon-theme preference bridge', () => {
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
    globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ requestId, ok: true, value: { revision: 1, ...candidate } }))
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
      requestId, ok: false, code: 'conflict', currentPreference: builtin,
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
})
