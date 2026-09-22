import { afterEach, expect, it, vi } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { connectStartupCover } from '../packages/cli/src/shortcuts/startup-cover.js'
import { completeHostReadiness } from '../packages/cli/src/cli/run-support.js'
import { settleInjectedHostCleanup } from '../packages/cli/src/cli/injected-host-cleanup.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture(
  options: {
    registration?: boolean
    changed?: boolean
    ready?: boolean
    pending?: boolean
    action?: string
    surface?: 'auth-required' | 'workspace-ready'
  } = {},
) {
  const events: string[] = []
  const held = {
    pid: 42,
    generation: 'generation',
    windowId: 1,
    webContentsId: 2,
    targetId: 'owned',
    phase: 'navigation-held',
    initialDocumentURL: 'data:text/html;charset=utf-8,loading',
  }
  let registered = false
  const main = {
    async send(_method: string, params: { expression: string }) {
      const method = params.expression.match(/Navigation\.(\w+)/)?.[1]
      events.push(method ?? 'unknown')
      return { result: { value: options.changed && registered ? { ...held, targetId: 'changed' } : held } }
    },
  }
  const receipt = { nonce: 'final-document' }
  const page = {
    onEvent() {
      return () => {}
    },
    async send(method: string, params: { expression?: string }) {
      events.push(method)
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        registered = true
        return options.registration === false ? {} : { identifier: 'cover' }
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression?.includes('api.retire(')) {
          events.push('retire-document')
          return {}
        }
        if (params.expression?.includes('?.fail(')) {
          events.push('recovery-visible')
          return { result: { value: true } }
        }
        if (params.expression === 'globalThis.__cordisxStartupDocument?.snapshot()') {
          return { result: { value: { phase: 'failed', modal: true, mounted: true, requestedAction: options.action } } }
        }
        if (options.pending) return await new Promise<never>(() => {})
        expect(params.expression).toContain('releaseReadyStartup')
        if (options.ready !== false) events.push('release-final')
        return {
          result: {
            value: {
              ready: options.ready !== false,
              released: options.ready !== false,
              releasedAt: 1234,
              surface: options.surface,
              receipt,
              observations: { receipt, authenticated: true, hostUsable: true, cordisxReady: true },
            },
          },
        }
      }
      return {}
    },
    close() {
      events.push('close-page')
    },
  }
  vi.spyOn(CdpSession, 'connect').mockResolvedValue(page as unknown as CdpSession)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    async () => ({
      json: async () => [{
        id: 'owned',
        type: 'page',
        url: held.initialDocumentURL,
        webSocketDebuggerUrl: 'ws://127.0.0.1:4444/devtools/page/owned',
      }],
    }),
  )
  return {
    events,
    connect: () =>
      connectStartupCover(main as unknown as CdpSession, held, 4444, async () => {
        events.push('recovery-heartbeat')
      }),
  }
}

it('registers the production cover before navigation and removes it only after final readiness release', async () => {
  const f = fixture()
  const controller = await f.connect()
  expect(f.events.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(f.events.indexOf('releaseNavigation'))
  expect(f.events).not.toContain('Page.removeScriptToEvaluateOnNewDocument')
  await controller.reveal({ module: 'app://-/assets/fixture.js', exportName: 'account' })
  expect(f.events.indexOf('release-final')).toBeLessThan(f.events.indexOf('Page.removeScriptToEvaluateOnNewDocument'))
  expect(f.events.at(-1)).toBe('close-page')
})

it('returns workspace-ready without requiring an account descriptor or claiming authentication', async () => {
  const f = fixture({ surface: 'workspace-ready' })
  const cover = await f.connect()
  await expect(cover.reveal(undefined)).resolves.toBe('workspace-ready')
  expect(f.events).toContain('release-final')
  expect(f.events.at(-1)).toBe('close-page')
})

it('returns auth-required distinctly while retiring the cover so the native login can be used', async () => {
  const f = fixture({ surface: 'auth-required' })
  const cover = await f.connect()
  await expect(cover.reveal({ module: 'app://-/assets/fixture.js', exportName: 'account' })).resolves.toBe(
    'auth-required',
  )
  expect(f.events).toContain('release-final')
  expect(f.events).not.toContain('Page.reload')
  expect(f.events.at(-1)).toBe('close-page')
})

it.each([{ registration: false }, { changed: true }])(
  'fails closed when script receipt or native target changes: %j',
  async options => {
    const f = fixture(options)
    await expect(f.connect()).rejects.toThrow()
    expect(f.events).not.toContain('releaseNavigation')
    expect(f.events.at(-1)).toBe('close-page')
  },
)

it.each(['stop', 'close'] as const)('retires recovery and reaches owned Host cleanup on %s', async action => {
  const f = fixture({ ready: false, ...(action === 'close' ? { action } : {}) })
  const cover = await f.connect()
  vi.useFakeTimers()
  const lifetime = new AbortController()
  const readiness = completeHostReadiness(lifetime, async signal => {
    await cover.reveal({ module: 'app://-/assets/fixture.js', exportName: 'account' }, signal)
  })
  const terminate = vi.fn(async () => {})
  const cleanup = settleInjectedHostCleanup({ beforeHostTermination: [readiness], terminateHost: terminate })
  await vi.advanceTimersByTimeAsync(30100)
  expect(f.events).toContain('recovery-visible')
  if (action === 'stop') lifetime.abort()
  const result = await cleanup
  expect(result[0]?.status).toBe('rejected')
  expect(lifetime.signal.aborted).toBe(true)
  expect(f.events).toContain('Page.removeScriptToEvaluateOnNewDocument')
  expect(f.events).toContain('retire-document')
  expect(f.events.at(-1)).toBe('close-page')
  expect(terminate).toHaveBeenCalledOnce()
})

it('aborts an unresolved account/boot evaluation and cleans the script without waiting for its result', async () => {
  const f = fixture({ pending: true })
  const cover = await f.connect()
  const lifetime = new AbortController()
  const readiness = cover.reveal({ module: 'app://-/assets/fixture.js', exportName: 'account' }, lifetime.signal)
  const rejected = expect(readiness).rejects.toThrow('aborted')
  lifetime.abort()
  await rejected
  expect(f.events).toContain('retire-document')
  expect(f.events.at(-1)).toBe('close-page')
})
