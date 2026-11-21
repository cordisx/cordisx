import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
    ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
  ),
].find(candidate => {
  if (!candidate || !path.isAbsolute(candidate)) return false
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
})

const active = {
  recordKind: 'active',
  profileId: 'work',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}
const bundle = `
export async function startStandaloneManagerComposition(signal) {
  signal.throwIfAborted();
  const active = ${JSON.stringify(active)};
  globalThis.__cordisxPluginGenerationResourcesV1 = {
    stage() {}, publish() {}, retire() {}, dispose() { globalThis.__fixtureRegistryDisposed = true; }
  };
  const runtime = {
    activePluginGeneration() { return active }, pluginRegistryEpoch() { return 3 },
    async settleRegistryProjection() {}, async adoptRecoveredActivation() {}, async stagePluginMutation() {},
    async publishPluginMutation() {}, async completePluginMutation() {}, async finalizePluginMutation() {},
    async rollbackPluginMutation() {}, async dispose() { globalThis.__fixtureDisposed = true; }
  };
  globalThis.__cordisxRuntime = runtime;
  return runtime;
}`

it.skipIf(chrome === undefined)(
  'boots two isolated pages through the real worker and retires only the closed page',
  async () => {
    const result = await build({
      entryPoints: ['packages/cli/src/independent-manager/standalone-entry.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: ['chrome120'],
      logLevel: 'silent',
    })
    const script = result.outputFiles[0]!.contents
    const worker = await readFile('packages/cli/assets/manager/manager-resource-worker.js')
    const entries = new Map([['a'.repeat(64), 'c'.repeat(64)], ['b'.repeat(64), 'd'.repeat(64)]])
    const sessions = new Map<
      string,
      { rendererId: string; polled: boolean; closed: boolean; admission?: ServerResponse }
    >()
    const events: Array<{ path: string; label: string; body: string }> = []
    let origin = ''
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', origin)
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        if (url.pathname === '/') {
          response.setHeader('content-type', 'text/html')
          response.setHeader(
            'content-security-policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          )
          return response.end('<!doctype html><body><script defer src="/manager-standalone.js"></script></body>')
        }
        if (url.pathname === '/manager-standalone.js' || url.pathname === '/manager-resource-worker.js') {
          response.setHeader('content-type', 'text/javascript')
          return response.end(url.pathname === '/manager-standalone.js' ? script : worker)
        }
        let data = ''
        for await (const chunk of request) data += String(chunk)
        const authorization = request.headers.authorization ?? ''
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        const session = sessions.get(token)
        events.push({
          path: request.url ?? '',
          label: token === 'c'.repeat(64) ? 'first' : token === 'd'.repeat(64) ? 'second' : '',
          body: data,
        })
        const json = (value: unknown) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(value))
        }
        if (url.pathname === '/api/session') {
          const entry = JSON.parse(data) as { token?: string }
          const exchanged = entries.get(entry.token ?? '')
          if (!exchanged) {
            response.statusCode = 401
            return response.end()
          }
          entries.delete(entry.token!)
          sessions.set(exchanged, {
            rendererId: exchanged === 'c'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
            polled: false,
            closed: false,
          })
          return json({ token: exchanged })
        }
        if (!session || session.closed) {
          response.statusCode = 401
          return response.end()
        }
        if (url.pathname === '/api/renderer/open') {
          return json({
            status: 'ok',
            rendererId: session.rendererId,
            generation: 'owner-1',
            profileId: 'work',
            channels: [],
            commands: true,
          })
        }
        if (url.pathname === '/api/renderer/session') {
          return json({ current: true, rendererId: session.rendererId, generation: 'owner-1' })
        }
        if (url.pathname === '/api/renderer/bootstrap') {
          return json({ status: 'ok', bundleUrl: '/api/renderer/bundle.js', initialGraphs: [] })
        }
        if (url.pathname === '/api/renderer/bundle.js') {
          response.setHeader('content-type', 'text/javascript')
          return response.end(bundle)
        }
        if (url.pathname === '/api/renderer/poll') {
          if (session.polled) {
            return
          }
          session.polled = true
          return json({
            command: { id: '1'.repeat(64), sequence: 1, method: 'synchronize', payload: { active, registryEpoch: 3 } },
          })
        }
        if (url.pathname === '/api/renderer/admit') {
          session.admission = response
          return
        }
        if (url.pathname === '/api/renderer/acknowledge') {
          const receipt = JSON.parse(data) as { receipt?: { ok?: boolean; value?: { registryEpoch?: number } } }
          if (!receipt.receipt?.ok || receipt.receipt.value?.registryEpoch !== 3 || !session.admission) {
            response.statusCode = 409
            return response.end()
          }
          session.admission.setHeader('content-type', 'application/json')
          session.admission.end(JSON.stringify({ admitted: true }))
          return json({ accepted: true })
        }
        if (url.pathname === '/api/renderer/close') {
          session.closed = true
          return json({ closed: true })
        }
        response.statusCode = 404
        return response.end()
      })().catch(() => response.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-standalone-browser-'))
    let browser: ChildProcess | undefined
    const clients: CdpClient[] = []
    try {
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socketUrl = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socketUrl)
      clients.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: `${origin}/?host=1#${'a'.repeat(64)}` })
      await expect.poll(() => first.evaluate("document.querySelector('[role=status]')?.hidden === true"), {
        timeout: 15_000,
      }).toBe(true)
      const debugOrigin = `http://${new URL(socketUrl).host}`
      const secondUrl = `${origin}/?host=1#${'b'.repeat(64)}`
      const tabResponse = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(secondUrl)}`, { method: 'PUT' })
      const tab = await tabResponse.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(tab.webSocketDebuggerUrl)
      clients.push(second)
      await expect.poll(() => second.evaluate("document.querySelector('[role=status]')?.hidden === true"), {
        timeout: 15_000,
      }).toBe(true)
      expect(await first.evaluate('location.hash')).toBe('')
      expect(await second.evaluate('location.hash')).toBe('')
      expect(events.filter(event => event.path === '/api/renderer/bundle.js').map(event => event.label).sort()).toEqual(
        ['first', 'second'],
      )
      await first.evaluate("dispatchEvent(new Event('pagehide'))")
      await expect.poll(() => first.evaluate('globalThis.__fixtureDisposed === true')).toBe(true)
      await expect.poll(() => sessions.get('c'.repeat(64))?.closed === true).toBe(true)
      expect(await second.evaluate('globalThis.__fixtureDisposed === true')).toBe(false)
      expect(await second.evaluate("fetch('/api/renderer/bundle.js').then(response => response.status)")).toBe(200)
      expect(await first.evaluate("fetch('/api/renderer/bundle.js').then(response => response.status)")).toBe(403)
      expect(events.every(event => !event.path.includes('c'.repeat(64)) && !event.path.includes('d'.repeat(64)))).toBe(
        true,
      )
    } finally {
      await Promise.allSettled(clients.map(async client => await client.close()))
      if (browser) await stopChrome(browser)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(profile, { recursive: true, force: true })
    }
  },
  45_000,
)
