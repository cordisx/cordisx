import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createConsoleRetirementFixture } from './fixtures/manager-console-retirement.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find(candidate => {
    if (!candidate || !path.isAbsolute(candidate)) return false
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })

it.skipIf(!chrome)('keeps the browser session usable when a pending console view is left', async () => {
  const f = await createConsoleRetirementFixture()
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-console-navigation-'))
  const sessionToken = 'a'.repeat(64)
  let browser: ChildProcess | undefined
  let page: CdpClient | undefined
  let server: Server | undefined
  let retireRequests = 0
  const statuses: Array<{ action: string; status: number }> = []
  try {
    await f.bridge.channel.prepare(f.request(f.firstToken, 'get'), f.first).dispatch()
    await f.bridge.channel.prepare(f.request(f.secondToken, 'get'), f.second).dispatch()
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: 'console-navigation-fixture.js',
        contents: `
          import { installIndependentHostBindings } from './packages/cli/src/independent-manager/host-bindings.ts'
          import { createManagedConsoleBrowserEntry } from './packages/cli/src/renderer/managed-service-console-browser-entry.ts'
          import { registerManagedConsoleSeat } from './packages/cli/src/renderer/managed-console-seats.ts'
          const fixture = window.fixture = { lost: null, result: null, responses: [] }
          const pending = new Map()
          window.__cordisxManagedServiceUIReceiveV1 = raw => {
            const result = JSON.parse(raw)
            fixture.responses.push({ requestId: result.requestId, ok: result.ok })
            const waiter = pending.get(result.requestId)
            if (!waiter) return
            pending.delete(result.requestId)
            result.ok ? waiter.resolve(result.value) : waiter.reject(new Error('request failed'))
          }
          fixture.dispose = installIndependentHostBindings({
            window, sessionToken: ${JSON.stringify(sessionToken)}, channels: ['managed-service-ui'],
            rendererAdmission: Promise.resolve(true), onSessionLost: reason => { fixture.lost = reason }
          })
          const invoke = request => new Promise((resolve, reject) => {
            pending.set(request.requestId, { resolve, reject })
            try {
              window.__cordisxManagedServiceUIRequestV1(JSON.stringify({
                ...request, version: 1, token: ${JSON.stringify(f.firstToken)},
                scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'plugin-1' }
              }))
            } catch (error) { pending.delete(request.requestId); reject(error) }
          })
          const read = createManagedConsoleBrowserEntry({
            owner: 'example', binding: ${JSON.stringify(f.binding)}, serviceGeneration: 'service-1',
            nextId: () => 'fixture-' + crypto.randomUUID(), invoke
          })
          const body = document.querySelector('#body')
          let controller
          document.querySelector('#open').onclick = () => {
            controller = new AbortController()
            body.hidden = false
            registerManagedConsoleSeat(body, 'example', controller.signal)
            fixture.result = null
            void read().then(result => { fixture.result = result })
          }
          document.querySelector('#other').onclick = () => { controller.abort(); body.hidden = true }
        `,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: ['chrome120'],
    })
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/') {
          response.setHeader('content-type', 'text/html')
          response.end(
            '<button id="open">Open console</button><button id="other">Other page</button>'
              + '<main id="body"></main><script src="/fixture.js"></script>',
          )
          return
        }
        if (request.method === 'GET' && request.url === '/fixture.js') {
          response.setHeader('content-type', 'text/javascript')
          response.end(bundle.outputFiles[0]!.text)
          return
        }
        if (
          request.method !== 'POST' || request.url !== '/api/renderer/binding'
          || request.headers.authorization !== 'Bearer ' + sessionToken
        ) {
          response.writeHead(404).end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as { channel: string; payload: string }
        if (envelope.channel !== 'managed-service-ui') throw new Error('unexpected channel')
        const action = JSON.parse(envelope.payload).request.action as string
        if (action === 'retire') retireRequests += 1
        try {
          const result = await f.bridge.channel.prepare(envelope.payload, f.first).dispatch()
          statuses.push({ action, status: 200 })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(result))
        } catch {
          statuses.push({ action, status: 503 })
          response.writeHead(503).end()
        }
      })().catch(() => response.writeHead(500).end())
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const launched = launchChrome(chrome!, profile)
    browser = launched.browser
    page = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
    await page.send('Page.enable')
    await page.send('Page.navigate', { url: origin }, 15_000)
    await expect.poll(() => page!.evaluate('typeof window.fixture?.dispose'), { timeout: 10_000 }).toBe('function')
    await page.evaluate('document.querySelector("#open").click()')
    await expect.poll(() => f.origins.length, { timeout: 10_000 }).toBe(1)
    expect(await f.bridge.channel.prepare(f.issue(f.secondToken, 'second'), f.second).dispatch()).toMatchObject({
      ok: true,
      value: { status: 'available', origin: f.origins[1] },
    })
    await page.evaluate('document.querySelector("#other").click()')
    await expect.poll(() => retireRequests, { timeout: 10_000 }).toBe(1)
    f.release()
    await expect.poll(() => page!.evaluate('window.fixture.result?.reason'), { timeout: 10_000 }).toBe('cancelled')
    await expect.poll(() => page!.evaluate('window.fixture.responses.length'), { timeout: 10_000 }).toBe(2)
    expect(statuses).toEqual(expect.arrayContaining([
      { action: 'issue', status: 200 },
      { action: 'retire', status: 200 },
    ]))
    expect(await page.evaluate('window.fixture.lost')).toBeNull()
    expect(await page.evaluate('window.fixture.dispose.canQuiesce()')).toBe(true)
    expect(f.disposed.has(f.origins[0]!)).toBe(true)
    expect(f.disposed.has(f.origins[1]!)).toBe(false)
    await page.evaluate('document.querySelector("#open").click()')
    await expect.poll(() => page!.evaluate('window.fixture.result?.status'), { timeout: 10_000 }).toBe('available')
    expect(f.origins[2]).toBe(f.origins[0])
    await page.evaluate('document.querySelector("#other").click()')
    await expect.poll(() => statuses.filter(item => item.action === 'retire').length, { timeout: 10_000 }).toBe(2)
    expect(await page.evaluate('window.fixture.lost')).toBeNull()
  } finally {
    f.release()
    await page?.close().catch(() => undefined)
    if (browser) await stopChrome(browser)
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
    try {
      await f.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}, 75_000)
