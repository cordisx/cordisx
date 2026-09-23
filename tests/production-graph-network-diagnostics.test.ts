import { describe, expect, it, vi } from 'vitest'
import {
  observeProductionGraphNetwork,
  type ProductionGraphNetworkFailure,
  waitForProductionBootstrap,
} from '../packages/cli/src/launcher/cdp-installation-support.js'
import {
  createDocumentInstallationState,
  installDocumentBootstrap,
} from '../packages/cli/src/launcher/cdp-installation-bootstrap.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { hostGenerationBootloaderSource } from '../packages/cli/src/launcher/host-generation-graph.js'

function evaluation(value: Record<string, unknown>): Record<string, unknown> {
  return { result: { value } }
}

describe('production Host graph network diagnostics', () => {
  it('labels bootloader failures by stage without preserving the private graph URL', async () => {
    const privateOrigin = 'http://127.0.0.1:43210/cordisx-host-generation/private-secret'
    const scope: Record<string, unknown> = { __cordisxProductionBootstrapTimeoutMs: 600 }
    const fetch = vi.fn(async () => {
      throw new TypeError(`Failed to fetch ${privateOrigin}/manifest.json`)
    })
    Function('globalThis', 'fetch', 'console', hostGenerationBootloaderSource(privateOrigin))(
      scope,
      fetch,
      { error: vi.fn() },
    )

    await expect(scope.__cordisxCompositionBoot).rejects.toThrow(
      'CordisX Host manifest fetch deadline exceeded: Failed to fetch [host graph]/manifest.json',
    )
    await expect(scope.__cordisxCompositionBoot).rejects.not.toThrow('private-secret')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('recovers when the launch-private manifest transport becomes reachable', async () => {
    const privateOrigin = 'http://127.0.0.1:43210/cordisx-host-generation/transient-secret'
    const scope: Record<string, unknown> = {}
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: 1,
          entry: '/host-test.js',
          digest: `sha256:${'a'.repeat(64)}`,
        }),
      })
    Function('globalThis', 'fetch', 'console', hostGenerationBootloaderSource(privateOrigin))(
      scope,
      fetch,
      { error: vi.fn() },
    )

    await expect(scope.__cordisxCompositionBoot).rejects.toThrow('CordisX Host entry import failed')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a manifest HTTP response', async () => {
    const privateOrigin = 'http://127.0.0.1:43210/cordisx-host-generation/http-secret'
    const scope: Record<string, unknown> = {}
    const fetch = vi.fn(async () => ({ ok: false, status: 503 }))
    Function('globalThis', 'fetch', 'console', hostGenerationBootloaderSource(privateOrigin))(
      scope,
      fetch,
      { error: vi.fn() },
    )

    await expect(scope.__cordisxCompositionBoot).rejects.toThrow('CordisX Host manifest HTTP 503')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains bounded CDP failure fields and drops the randomized request path', async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>()
    const send = vi.fn(async () => ({}))
    const source = hostGenerationBootloaderSource(
      'http://127.0.0.1:43210/cordisx-host-generation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    const observer = await observeProductionGraphNetwork({
      send,
      onEvent(method, listener) {
        listeners.set(method, listener)
        return () => listeners.delete(method)
      },
    }, source)
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'manifest-1',
      request: {
        url:
          'http://127.0.0.1:43210/cordisx-host-generation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest.json',
      },
    })
    listeners.get('Network.loadingFailed')?.({
      requestId: 'manifest-1',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'other',
      canceled: false,
    })

    expect(observer?.latest()).toMatchObject({
      sequence: 1,
      stage: 'manifest-fetch',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'other',
      canceled: false,
    })
    expect(JSON.stringify(observer?.latest())).not.toContain('aaaaaaaaaaaaaaaa')
    await observer?.close()
    expect(send.mock.calls.map(call => call[0])).toEqual(['Network.enable', 'Network.disable'])
    expect(listeners.size).toBe(0)
  })

  it('does not block installation when the diagnostic Network domain is unavailable', async () => {
    await expect(observeProductionGraphNetwork(
      {
        send: async () => {
          throw new Error('Network domain unavailable')
        },
        onEvent: () => () => undefined,
      },
      hostGenerationBootloaderSource(
        'http://127.0.0.1:43210/cordisx-host-generation/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      ),
    )).resolves.toBeUndefined()
  })

  it('reports a manifest HTTP response separately from transport failure', async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>()
    const origin =
      'http://127.0.0.1:43210/cordisx-host-generation/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const observer = await observeProductionGraphNetwork({
      send: async () => ({}),
      onEvent(method, listener) {
        listeners.set(method, listener)
        return () => listeners.delete(method)
      },
    }, hostGenerationBootloaderSource(origin))
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'manifest-http',
      request: { url: `${origin}/manifest.json` },
    })
    listeners.get('Network.responseReceived')?.({
      requestId: 'manifest-http',
      response: { status: 503 },
    })
    const session = {
      send: vi.fn(async () => evaluation({ ok: false, error: 'CordisX Host manifest HTTP 503' })),
      isClosed: () => false,
    } as unknown as CdpSession

    await expect(
      waitForProductionBootstrap(session, 'install-http', Date.now() + 1_000, undefined, observer),
    ).rejects.toThrow('CordisX Host manifest fetch returned HTTP 503')
    await observer?.close()
  })

  it('replaces generic fetch text with the observed connection failure', async () => {
    const session = {
      send: vi.fn(async () => evaluation({ ok: false, error: 'TypeError: Failed to fetch' })),
      isClosed: () => false,
    } as unknown as CdpSession
    const failure: ProductionGraphNetworkFailure = {
      sequence: 1,
      stage: 'manifest-fetch',
      errorText: 'net::ERR_CONNECTION_REFUSED',
      canceled: false,
      observedAt: Date.now(),
    }

    await expect(
      waitForProductionBootstrap(session, 'install-1', Date.now() + 1_000, undefined, { latest: () => failure }),
    ).rejects.toThrow(
      'CordisX Host manifest fetch could not reach the loopback server (net::ERR_CONNECTION_REFUSED)',
    )
  })

  it('reports a document-canceled request without retrying an unknown failure', async () => {
    const session = {
      send: vi.fn(async () => evaluation({ ok: false, error: 'TypeError: Failed to fetch' })),
      isClosed: () => false,
    } as unknown as CdpSession
    const failure: ProductionGraphNetworkFailure = {
      sequence: 1,
      stage: 'manifest-fetch',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
      observedAt: Date.now(),
    }

    await expect(
      waitForProductionBootstrap(session, 'install-1', Date.now() + 1_000, undefined, {
        latest: () => failure,
      }),
    ).rejects.toThrow(
      'CordisX Host manifest fetch was canceled by the renderer document lifecycle (net::ERR_ABORTED)',
    )
    expect(session.send).toHaveBeenCalledTimes(2)
    expect(session.send).toHaveBeenLastCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('owner.abort()'),
      }),
      1000,
    )
  })

  it('keeps waiting through a pending bootstrap when an earlier document was canceled', async () => {
    const session = {
      send: vi.fn()
        .mockResolvedValueOnce(evaluation({ ok: false, error: 'cordisx:production-boot-pending' }))
        .mockResolvedValueOnce(evaluation({ ok: true })),
      isClosed: () => false,
    } as unknown as CdpSession
    const failure: ProductionGraphNetworkFailure = {
      sequence: 1,
      stage: 'manifest-fetch',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
      observedAt: Date.now() - 1_000,
    }

    await expect(
      waitForProductionBootstrap(session, 'install-2', Date.now() + 1_000, undefined, {
        latest: () => failure,
      }),
    ).resolves.toBeUndefined()
    expect(session.send).toHaveBeenCalledTimes(2)
  })

  it('keeps waiting through a destroyed execution context when an earlier document was canceled', async () => {
    const session = {
      send: vi.fn()
        .mockRejectedValueOnce(new Error('Execution context was destroyed'))
        .mockResolvedValueOnce(evaluation({ ok: true })),
      isClosed: () => false,
    } as unknown as CdpSession
    const failure: ProductionGraphNetworkFailure = {
      sequence: 1,
      stage: 'manifest-fetch',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
      observedAt: Date.now() - 1_000,
    }

    await expect(
      waitForProductionBootstrap(session, 'install-3', Date.now() + 1_000, undefined, {
        latest: () => failure,
      }),
    ).resolves.toBeUndefined()
    expect(session.send).toHaveBeenCalledTimes(2)
  })

  it('wires the Network observer around the production reload and reports policy failure', async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>()
    const methods: string[] = []
    const session = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        methods.push(method)
        if (method === 'Runtime.evaluate' && String(params?.expression).includes('document.readyState')) {
          return { result: { value: true } }
        }
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'production-script' }
        if (method === 'Page.reload') {
          listeners.get('Network.requestWillBeSent')?.({
            requestId: 'manifest-policy',
            request: {
              url:
                'http://127.0.0.1:43210/cordisx-host-generation/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/manifest.json',
            },
          })
          listeners.get('Network.loadingFailed')?.({
            requestId: 'manifest-policy',
            errorText: 'net::ERR_BLOCKED_BY_CLIENT',
            blockedReason: 'other',
            canceled: false,
          })
          return {}
        }
        if (method === 'Runtime.evaluate') {
          return evaluation({ ok: false, error: 'TypeError: Failed to fetch' })
        }
        return {}
      }),
      onEvent(method: string, listener: (params: Record<string, unknown>) => void) {
        listeners.set(method, listener)
        return () => listeners.delete(method)
      },
      isClosed: () => false,
    } as unknown as CdpSession

    await expect(installDocumentBootstrap({
      session,
      target: { id: 'native', type: 'page', title: 'Codex', url: 'app://-/index.html' },
      documentSource: hostGenerationBootloaderSource(
        'http://127.0.0.1:43210/cordisx-host-generation/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
      evaluationSource: '',
      viteDevelopment: false,
      loopbackModules: true,
    }, createDocumentInstallationState())).rejects.toThrow(
      'CordisX Host manifest fetch was blocked by browser policy (other; net::ERR_BLOCKED_BY_CLIENT)',
    )

    expect(methods.indexOf('Network.enable')).toBeLessThan(methods.indexOf('Page.reload'))
    expect(methods.at(-1)).toBe('Network.disable')
    expect(listeners.size).toBe(0)
  })
})
