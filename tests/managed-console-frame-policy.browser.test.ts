import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'
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

it.skipIf(chrome === undefined)(
  'loads an allowed console frame and blocks unissued or service-denied frames',
  async () => {
    let parentOrigin = ''
    const paths: string[] = []
    const upstream = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      paths.push(pathname)
      if (pathname.startsWith('/auth/')) {
        return response.writeHead(303, { location: '/' + pathname.slice('/auth/'.length) }).end()
      }
      if (pathname === '/allowed' || pathname === '/denied') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        if (pathname === '/allowed') {
          response.setHeader('content-security-policy', `frame-ancestors ${parentOrigin}; script-src 'unsafe-inline'`)
        } else {
          response.setHeader('x-frame-options', 'DENY')
        }
        return response.end(
          `<script>parent.postMessage(${JSON.stringify(pathname.slice(1))}, ${JSON.stringify(parentOrigin)})</script>`,
        )
      }
      response.writeHead(404).end()
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
    const upstreamOrigin = `http://127.0.0.1:${address.port}`
    const gateways: Awaited<ReturnType<typeof openManagedConsoleBrowserGateway>>[] = []
    const lifetime = new AbortController()
    let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    let profile: string | undefined
    try {
      for (let index = 0; index < 3; index++) gateways.push(await openManagedConsoleBrowserGateway())
      const [allowed, denied, unissued] = gateways
      web = await startManagerWeb({
        appId: 'codex',
        profileId: 'fixture',
        generation: 'fixture-owner',
        managerConsoleOrigins: [allowed!.origin, denied!.origin],
        isCurrent: async () => true,
        request: async () => ({ status: 'unavailable' }),
      })
      parentOrigin = new URL(web.url).origin
      const makeEntry = (gateway: typeof allowed, destination: string, ticket: string) => {
        const redeemPath = '/auth/' + destination
        const route = gateway!.boundary.open({
          service: 'fixture-service',
          generation: 'fixture-generation',
          upstream: upstreamOrigin,
          redeemPath,
          signal: lifetime.signal,
          verify: async () => true,
        })
        if (!route?.admit(ticket)) throw new Error('fixture console route unavailable')
        const url = new URL(redeemPath, route.origin)
        url.searchParams.set('ticket', ticket)
        return url.href
      }
      const allowedEntry = makeEntry(allowed, 'allowed', 'a'.repeat(32))
      const deniedEntry = makeEntry(denied, 'denied', 'b'.repeat(32))
      const unissuedEntry = makeEntry(unissued, 'unissued', 'c'.repeat(32))
      profile = await mkdtemp(path.join(os.tmpdir(), 'cx-console-frame-policy-'))
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await page.send('Runtime.enable')
      await page.send('Page.enable')
      await page.send('Page.navigate', { url: web.url })
      const active = page
      await expect.poll(() => active.evaluate('document.readyState'), { timeout: 15_000 }).toBe('complete')
      await active.evaluate(`(() => {
        globalThis.__frameFixtureMessages = [];
        globalThis.__frameFixtureViolations = [];
        addEventListener('message', event => globalThis.__frameFixtureMessages.push({ origin: event.origin, data: event.data }));
        addEventListener('securitypolicyviolation', event => globalThis.__frameFixtureViolations.push(event.effectiveDirective));
        const frame = document.createElement('iframe'); frame.src = ${
        JSON.stringify(allowedEntry)
      }; document.body.append(frame);
      })()`)
      await expect.poll(() => active.evaluate('globalThis.__frameFixtureMessages'), { timeout: 15_000 }).toContainEqual(
        {
          origin: allowed!.origin,
          data: 'allowed',
        },
      )
      await active.evaluate(`(() => {
        const frame = document.createElement('iframe'); frame.src = ${
        JSON.stringify(unissuedEntry)
      }; document.body.append(frame);
      })()`)
      await expect.poll(() => active.evaluate('globalThis.__frameFixtureViolations'), { timeout: 15_000 }).toContain(
        'frame-src',
      )
      expect(paths).not.toContain('/auth/unissued')
      await active.evaluate(`new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.addEventListener('load', () => setTimeout(resolve, 300), { once: true });
        frame.src = ${JSON.stringify(deniedEntry)}; document.body.append(frame);
      })`)
      expect(paths).toContain('/denied')
      expect(await active.evaluate('globalThis.__frameFixtureMessages')).not.toContainEqual({
        origin: denied!.origin,
        data: 'denied',
      })
    } finally {
      await page?.close().catch(() => {})
      if (browser) await stopChrome(browser)
      // Chromium children may finish a profile write just after the parent exits.
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await web?.close()
      lifetime.abort()
      await Promise.all(gateways.map(async gateway => await gateway.close()))
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    }
  },
  90_000,
)
