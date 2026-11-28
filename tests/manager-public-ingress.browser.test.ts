import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createSocketServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { startManagerPublicIngress } from '../packages/cli/src/cli/manager-public-ingress.js'
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

const exec = promisify(execFile)

it.skipIf(chrome === undefined)(
  'loads console frames without sending their credentials to another port',
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-public-browser-'))
    const gateways: Awaited<ReturnType<typeof openManagedConsoleBrowserGateway>>[] = []
    const reservations: ReturnType<typeof createSocketServer>[] = []
    const controllers: AbortController[] = []
    const seen: Array<{ path: string; cookie: string | undefined }> = []
    let managerOrigin = ''
    const service = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      seen.push({ path: url.pathname, cookie: request.headers.cookie })
      if (url.pathname === '/auth/browser') {
        const value = url.searchParams.get('ticket') === 'a'.repeat(32) ? 'a'.repeat(32) : 'b'.repeat(32)
        return response.writeHead(303, {
          location: '/view',
          'set-cookie': `__Host-fixture=${value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90`,
          'content-security-policy': `default-src 'none'; frame-ancestors ${managerOrigin}`,
        }).end()
      }
      const cookie = request.headers.cookie
      if (cookie !== '__Host-fixture=' + 'a'.repeat(32) && cookie !== '__Host-fixture=' + 'b'.repeat(32)) {
        return response.writeHead(401).end()
      }
      if (url.pathname === '/identity') {
        return response.writeHead(200, { 'content-type': 'text/plain' }).end(
          cookie.endsWith('a'.repeat(32)) ? 'a' : 'b',
        )
      }
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': `frame-ancestors ${managerOrigin}; script-src 'unsafe-inline'; connect-src 'self'`,
      }).end(
        `<script>fetch('/identity').then(r => r.text()).then(value => parent.postMessage(value, ${
          JSON.stringify(managerOrigin)
        })); addEventListener('message', e => { if (e.data === 'probe') fetch('/identity')`
          + `.then(r => parent.postMessage('probe:' + r.status, ${JSON.stringify(managerOrigin)})) });</script>`,
      )
    })
    let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
    let ingress: Awaited<ReturnType<typeof startManagerPublicIngress>> | undefined
    let otherPort: HttpsServer | undefined
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    try {
      const certificateFile = path.join(directory, 'certificate.pem')
      const privateKeyFile = path.join(directory, 'key.pem')
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-keyout',
        privateKeyFile,
        '-out',
        certificateFile,
      ], { timeout: 15_000 })
      const tls = { certificate: await readFile(certificateFile), privateKey: await readFile(privateKeyFile) }
      const publicKey = new X509Certificate(tls.certificate).publicKey.export({ type: 'spki', format: 'der' })
      const certificateFingerprint = createHash('sha256').update(publicKey).digest('base64')
      await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
      const address = service.address()
      if (!address || typeof address === 'string') throw new Error('fixture service unavailable')
      for (let index = 0; index < 3; index++) {
        const reservation = createSocketServer()
        reservations.push(reservation)
        await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
      }
      const ports = reservations.map(reservation => {
        const value = reservation.address()
        if (!value || typeof value === 'string') throw new Error('fixture port unavailable')
        return value.port
      })
      managerOrigin = `https://console.localhost:${ports[0]}`
      const templates = ports.slice(1).map(port => `https://{view}.console.localhost:${port}`)
      for (const ticket of ['a'.repeat(32), 'b'.repeat(32)]) {
        const gateway = await openManagedConsoleBrowserGateway()
        gateways.push(gateway)
        const controller = new AbortController()
        controllers.push(controller)
        const route = gateway.boundary.open({
          service: 'fixture',
          generation: 'one',
          upstream: `http://127.0.0.1:${address.port}`,
          redeemPath: '/auth/browser',
          signal: controller.signal,
          verify: async () => true,
        })
        if (!route?.admit(ticket)) throw new Error('fixture console unavailable')
      }
      web = await startManagerWeb({
        appId: 'codex',
        profileId: 'fixture',
        generation: 'fixture-owner',
        managerConsoleOrigins: gateways.map(gateway => gateway.origin),
        isCurrent: async () => true,
        request: async () => ({ status: 'unavailable' }),
      }, { publicOrigin: managerOrigin, publicConsoleOriginTemplates: templates })
      const consoles = gateways.map((gateway, index) =>
        web!.consoleMapping!.issue(gateway.origin, 'view-' + index, controllers[index]!.signal)!.publicOrigin
      )
      await Promise.all(
        reservations.map(async reservation => await new Promise<void>(resolve => reservation.close(() => resolve()))),
      )
      ingress = await startManagerPublicIngress({
        manager: { publicOrigin: web.origin, localOrigin: web.localOrigin },
        consoles: web.consoleMapping!,
        listeners: ports.map(port => ({ host: '127.0.0.1', port, tls })),
      })
      const profile = path.join(directory, 'chrome')
      const launched = launchChrome(chrome!, profile, [
        '--ignore-certificate-errors-spki-list=' + certificateFingerprint,
      ])
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await page.send('Page.enable')
      await page.send('Page.navigate', { url: web.url })
      const active = page
      await expect.poll(
        () =>
          active.evaluate(`location.origin === ${JSON.stringify(managerOrigin)} && document.readyState === 'complete'`),
        { timeout: 15_000 },
      ).toBe(true)
      await active.evaluate(`(() => {
        globalThis.__consoleMessages = [];
        addEventListener('message', event => globalThis.__consoleMessages.push({ origin: event.origin, data: event.data }));
        for (const url of ${
        JSON.stringify(consoles.map((origin, index) =>
          origin + '/auth/browser?ticket=' + (index === 0 ? 'a' : 'b').repeat(32)
        ))
      }) {
          const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame);
        }
      })()`)
      await expect.poll(() => active.evaluate('globalThis.__consoleMessages'), { timeout: 15_000 }).toEqual(
        expect.arrayContaining([{ origin: consoles[0], data: 'a' }, { origin: consoles[1], data: 'b' }]),
      )
      expect(seen.filter(item => item.path === '/identity').map(item => item.cookie).sort()).toEqual([
        '__Host-fixture=' + 'a'.repeat(32),
        '__Host-fixture=' + 'b'.repeat(32),
      ])
      web.consoleMapping!.retire('view-0')
      controllers[0]!.abort()
      const nextController = new AbortController()
      controllers.push(nextController)
      const nextTicket = 'c'.repeat(32)
      const nextRoute = gateways[0]!.boundary.open({
        service: 'fixture',
        generation: 'one',
        upstream: `http://127.0.0.1:${address.port}`,
        redeemPath: '/auth/browser',
        signal: nextController.signal,
        verify: async () => true,
      })
      if (!nextRoute?.admit(nextTicket)) throw new Error('fixture console unavailable')
      const nextOrigin =
        web.consoleMapping!.issue(gateways[0]!.origin, 'next-view', nextController.signal)!.publicOrigin
      expect(nextOrigin).not.toBe(consoles[0])
      await active.evaluate(`(() => {
        document.querySelector('iframe').contentWindow.postMessage('probe', ${JSON.stringify(consoles[0])});
        const frame = document.createElement('iframe');
        frame.src = ${JSON.stringify(nextOrigin + '/auth/browser?ticket=' + nextTicket)};
        document.body.append(frame);
      })()`)
      await expect.poll(() => active.evaluate('globalThis.__consoleMessages'), { timeout: 15_000 }).toEqual(
        expect.arrayContaining([{ origin: consoles[0], data: 'probe:421' }, { origin: nextOrigin, data: 'b' }]),
      )
      let reachedOtherPort = false
      let exposedCookie = false
      let exposedAuthorization = false
      otherPort = createHttpsServer({ cert: tls.certificate, key: tls.privateKey }, (request, response) => {
        reachedOtherPort = true
        exposedCookie = !!request.headers.cookie
        exposedAuthorization = !!request.headers.authorization
        response.writeHead(200).end('fixture')
      })
      await new Promise<void>(resolve => otherPort!.listen(0, '127.0.0.1', resolve))
      const otherAddress = otherPort.address()
      if (!otherAddress || typeof otherAddress === 'string') throw new Error('fixture listener unavailable')
      const hostname = new URL(consoles[0]!).hostname
      await active.send('Page.navigate', { url: 'https://' + hostname + ':' + otherAddress.port + '/probe' })
      await expect.poll(() => reachedOtherPort, { timeout: 15_000 }).toBe(true)
      expect(exposedCookie).toBe(false)
      expect(exposedAuthorization).toBe(false)
    } finally {
      await page?.close().catch(() => {})
      if (browser) await stopChrome(browser)
      if (otherPort?.listening) await new Promise<void>(resolve => otherPort!.close(() => resolve()))
      await ingress?.close()
      await web?.close()
      for (const controller of controllers) controller.abort()
      await Promise.all(gateways.map(async gateway => await gateway.close()))
      for (const reservation of reservations) {
        if (reservation.listening) await new Promise<void>(resolve => reservation.close(() => resolve()))
      }
      if (service.listening) await new Promise<void>(resolve => service.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
  90_000,
)
