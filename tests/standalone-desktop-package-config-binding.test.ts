import { afterEach, expect, it, vi } from 'vitest'
import { BrowserStandaloneDesktopPackageConfigBridge } from '../packages/cli/src/renderer/standalone-desktop-package-config-binding.js'

afterEach(() => {
  globalThis.__cordisxDesktopPackageConfigRequestV1 = undefined
  globalThis.__cordisxDesktopPackageConfigReceiveV1 = undefined
})

it('accepts success only after adopting the matching owner-confirmed value', async () => {
  let request: any
  globalThis.__cordisxDesktopPackageConfigRequestV1 = payload => request = JSON.parse(payload)
  const unknown = vi.fn(), adopt = vi.fn()
  const bridge = new BrowserStandaloneDesktopPackageConfigBridge('renderer-binding-placeholder', unknown)
  try {
    const pending = bridge.request('demo', 2, [{ op: 'set', path: ['label'], value: 'new' }], {
      raw: { label: 'new' },
      value: { label: 'new' },
    }, adopt)
    expect(bridge.adopt({
      requestId: request.requestId,
      pluginId: 'demo',
      expectedRevision: 2,
      revision: 3,
      origin: true,
      operations: [{ op: 'set', path: ['label'], value: 'new' }],
      value: { label: 'wrong' },
    })).toBe(false)
    expect(adopt).not.toHaveBeenCalled()
    expect(bridge.adopt({
      requestId: request.requestId,
      pluginId: 'demo',
      expectedRevision: 2,
      revision: 3,
      origin: true,
      operations: [{ op: 'set', path: ['label'], value: 'new' }],
      value: { label: 'new' },
    })).toBe(true)
    expect(bridge.adopt({
      requestId: request.requestId,
      pluginId: 'demo',
      expectedRevision: 2,
      revision: 3,
      origin: true,
      operations: [{ op: 'set', path: ['label'], value: 'new' }],
      value: { label: 'new' },
    })).toBe(false)
    globalThis.__cordisxDesktopPackageConfigReceiveV1!(JSON.stringify({
      requestId: request.requestId,
      ok: true,
      value: { status: 'applied', revision: 3 },
    }))
    await expect(pending).resolves.toBeUndefined()
    expect(adopt).toHaveBeenCalledExactlyOnceWith(3)
    expect(unknown).not.toHaveBeenCalled()
  } finally {
    bridge.dispose()
  }
})

it('retires the session when a success arrives without the adoption receipt', async () => {
  let request: any
  globalThis.__cordisxDesktopPackageConfigRequestV1 = payload => request = JSON.parse(payload)
  const unknown = vi.fn(), adopt = vi.fn()
  const bridge = new BrowserStandaloneDesktopPackageConfigBridge('renderer-binding-placeholder', unknown)
  try {
    const pending = bridge.request('demo', 2, [{ op: 'unset', path: ['label'] }], { raw: {}, value: {} }, adopt)
    globalThis.__cordisxDesktopPackageConfigReceiveV1!(JSON.stringify({
      requestId: request.requestId,
      ok: true,
      value: { status: 'applied', revision: 3 },
    }))
    await expect(pending).rejects.toThrow('result is unknown')
    expect(unknown).toHaveBeenCalledOnce()
    expect(adopt).not.toHaveBeenCalled()
  } finally {
    bridge.dispose()
  }
})

it('keeps a rejected pre-dispatch write available for review', async () => {
  let request: any
  globalThis.__cordisxDesktopPackageConfigRequestV1 = payload => request = JSON.parse(payload)
  const unknown = vi.fn()
  const bridge = new BrowserStandaloneDesktopPackageConfigBridge('renderer-binding-placeholder', unknown)
  try {
    const pending = bridge.request('demo', 2, [{ op: 'unset', path: ['label'] }], { raw: {}, value: {} }, () => {})
    globalThis.__cordisxDesktopPackageConfigReceiveV1!(JSON.stringify({
      requestId: request.requestId,
      ok: true,
      value: { status: 'rejected', reason: 'busy' },
    }))
    await expect(pending).rejects.toThrow('unavailable or in use')
    expect(unknown).not.toHaveBeenCalled()
  } finally {
    bridge.dispose()
  }
})

it('waits for an in-transit rejection before adopting another page’s write', async () => {
  let request: any
  globalThis.__cordisxDesktopPackageConfigRequestV1 = payload => request = JSON.parse(payload)
  const bridge = new BrowserStandaloneDesktopPackageConfigBridge('renderer-binding-placeholder')
  const adopt = vi.fn(async () => true)
  try {
    const pending = bridge.request('demo', 2, [{ op: 'unset', path: ['label'] }], { raw: {}, value: {} }, () => {})
    const rejected = expect(pending).rejects.toThrow('unavailable or in use')
    const peer = bridge.adoptPeer({
      requestId: 'other-page',
      pluginId: 'demo',
      expectedRevision: 2,
      revision: 3,
      origin: false,
      operations: [{ op: 'set', path: ['label'], value: 'peer' }],
      value: { label: 'peer' },
    }, adopt)
    await Promise.resolve()
    expect(adopt).not.toHaveBeenCalled()
    globalThis.__cordisxDesktopPackageConfigReceiveV1!(JSON.stringify({
      requestId: request.requestId,
      ok: true,
      value: { status: 'rejected', reason: 'busy' },
    }))
    await rejected
    expect(await peer).toBe(true)
    expect(adopt).toHaveBeenCalledOnce()
  } finally {
    bridge.dispose()
  }
})
