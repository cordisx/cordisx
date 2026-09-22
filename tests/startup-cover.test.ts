import { afterEach, expect, it, vi } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { connectStartupCover } from '../packages/cli/src/shortcuts/startup-cover.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(options: { registration?: boolean; changed?: boolean } = {}) {
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
    async send(method: string, params: { expression?: string }) {
      events.push(method)
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        registered = true
        return options.registration === false ? {} : { identifier: 'cover' }
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression?.includes('?.release(')) {
          events.push('release-final')
          return { result: { value: true } }
        }
        return {
          result: {
            value: {
              ready: true,
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
  return { events, connect: () => connectStartupCover(main as unknown as CdpSession, held, 4444) }
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

it.each([{ registration: false }, { changed: true }])(
  'fails closed when script receipt or native target changes: %j',
  async options => {
    const f = fixture(options)
    await expect(f.connect()).rejects.toThrow()
    expect(f.events).not.toContain('releaseNavigation')
    expect(f.events.at(-1)).toBe('close-page')
  },
)
