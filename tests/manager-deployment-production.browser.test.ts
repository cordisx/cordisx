import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { consoleBrowserPlugin } from './fixtures/managed-public-console-plugin.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const exec = promisify(execFile)
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

async function makeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
  }
}

it.skipIf(chrome === undefined)(
  'boots and refreshes two managed console frames through an HTTPS proxy with a real service owner',
  async () => {
    // macOS Unix sockets have a short path limit; the owner creates nested sockets below this root.
    const root = await mkdtemp('/tmp/cx-manager-public-')
    const home = path.join(root, 'home')
    const cli = path.resolve('packages/cli/dist/src/cli.js')
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
    )
    Object.assign(env, {
      CORDISX_HOME: home,
      CORDISX_MODEL_API_PORT: '0',
      HOME: root,
      CODEX_HOME: path.join(root, 'codex'),
    })
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli, ...args], {
        env,
        cwd: root,
        timeout: args[0] === 'start' ? 100_000 : 35_000,
      })
    let browser: ChildProcess | undefined
    let proxy: HttpsServer | undefined
    const pages: CdpClient[] = []
    let managerAttempted = false
    let ownerAttempted = false
    let cleanupConfirmed = true
    try {
      await mkdir(home, { mode: 0o700 })
      await writeFile(
        path.join(home, 'config.json'),
        JSON.stringify({ ...createDefaultHomeConfig(), marketplaceSources: [] }),
        { mode: 0o600 },
      )
      await stageServiceModePlugin(
        root,
        home,
        'default',
        true,
        'https://example.test/fixtures',
        consoleBrowserPlugin,
        { browserConsole: true, uiPoints: ['manager.content', 'manager.settings.navigation-items'] },
      )
      const policies = exactDomPermissionPolicies('default', [{
        id: 'fixture-service',
        entry: '/fixture/entry.js',
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: 'https://example.test/fixtures' } },
      }))
      await persistPermissionPolicies({ configPath: path.join(home, 'config.json') }, policies)
      const certificateFile = path.join(root, 'certificate.pem')
      const privateKeyFile = path.join(root, 'key.pem')
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
      const certificate = await readFile(certificateFile)
      const publicKey = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })
      const certificateFingerprint = createHash('sha256').update(publicKey).digest('base64')
      const reservation = createServer()
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
      const address = reservation.address()
      if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
      const ingressPort = address.port
      await new Promise<void>(resolve => reservation.close(() => resolve()))
      proxy = createHttpsServer(
        { cert: certificate, key: await readFile(privateKeyFile) },
        (incoming, outgoing) => {
          const upstream = request({
            hostname: '127.0.0.1',
            port: ingressPort,
            method: incoming.method,
            path: incoming.url,
            headers: { ...incoming.headers, 'x-forwarded-proto': 'https' },
          }, response => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(outgoing)
          })
          upstream.on('error', () => outgoing.destroy())
          incoming.pipe(upstream)
        },
      )
      await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve))
      const proxyAddress = proxy.address()
      if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('fixture proxy unavailable')
      const origin = 'https://127.0.0.1:' + proxyAddress.port
      const deployment = path.join(root, 'deployment.json')
      await writeFile(
        deployment,
        JSON.stringify({
          publicOrigin: origin,
          consoleOrigins: { template: 'https://{view}.console.localhost:' + proxyAddress.port },
          listeners: [{ host: '127.0.0.1', port: ingressPort }],
        }),
        { mode: 0o600 },
      )
      ownerAttempted = true
      const started = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      expect(started).toMatchObject({ status: 'ready', mode: 'service' })
      managerAttempted = true
      expect(JSON.parse((await run('manager', 'start', '--deployment', deployment)).stdout).status).toBe('running')
      const link = async () => {
        const url = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(/\s+/u).at(-1)!)
        expect(url.origin).toBe(origin)
        url.search = '?host=1'
        return url.href
      }
      const launched = launchChrome(chrome!, path.join(root, 'chrome'), [
        '--ignore-certificate-errors-spki-list=' + certificateFingerprint,
      ])
      browser = launched.browser
      const socket = await waitForChromeTarget(path.join(root, 'chrome'), browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      const instrument = async (page: CdpClient) => {
        await page.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `
          globalThis.__publicFixtureEvents = [];
          const log = event => globalThis.__publicFixtureEvents.push(event);
          const fetchOriginal = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
            let operation;
            try {
              if (path === '/api/renderer/binding' && typeof init?.body === 'string') {
                const value = JSON.parse(JSON.parse(init.body).payload).operation;
                operation = typeof value === 'string' ? value : value?.kind;
              }
            } catch {}
            try {
              const response = await fetchOriginal(input, init);
              log({ path, operation, status: response.status });
              return response;
            } catch (error) {
              log({ path, error: String(error) });
              throw error;
            }
          };
          if (navigator.serviceWorker) {
            const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
            navigator.serviceWorker.register = async (...args) => {
              try {
                const result = await register(...args);
                log({ worker: 'registered' });
                return result;
              } catch (error) {
                log({ worker: String(error) });
                throw error;
              }
            };
          }
          addEventListener('error', event => log({ error: event.message }));
          addEventListener('unhandledrejection', event => log({ rejection: String(event.reason) }));
        `,
        })
      }
      await instrument(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: await link() })
      const expression = "({ ready: document.documentElement.dataset.cordisxManagerReady === 'true', "
        + 'plugin: globalThis.__fixturePublicPlugin ?? null, controlled: !!navigator.serviceWorker?.controller, '
        + "status: document.querySelector('p[role=status]')?.textContent ?? null, "
        + 'plugins: globalThis.__cordisxRuntime?.snapshot?.().plugins?.map(({ id, status }) => ({ id, status })) ?? [], '
        + 'secure: isSecureContext, serviceWorker: !!navigator.serviceWorker, events: globalThis.__publicFixtureEvents ?? [] })'
      const ready = async (page: CdpClient) => {
        let state: { ready?: boolean; plugin?: string; controlled?: boolean; status?: string | null } = {}
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline) {
          state = await page.evaluate<typeof state>(expression).catch(() => ({}))
          if (state.ready && state.plugin === 'active' && state.controlled) return
          if (state.status?.includes('连接中断') || state.status?.includes('连接不可用')) break
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        throw new Error('HTTPS Manager did not become ready: ' + JSON.stringify(state))
      }
      const consoleReady = async (page: CdpClient) => {
        try {
          await expect.poll(
            () =>
              page.evaluate(
                'globalThis.__publicFixtureEvents?.some(event => event.path === "/api/renderer/admit" && event.status === 200)',
              ),
            { timeout: 15_000 },
          ).toBe(true)
          await expect.poll(
            () => page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=fixture-service]"))'),
            { timeout: 15_000 },
          ).toBe(true)
          await page.evaluate(
            'if (!document.querySelector("[data-fixture-console-seat]")) '
              + 'document.querySelector("[data-settings-navigation-item^=fixture-service]").click()',
          )
          await expect.poll(
            () => page.evaluate('Boolean(document.querySelector("[data-fixture-console-seat]"))'),
            { timeout: 15_000 },
          ).toBe(true)
          await page.evaluate('globalThis.__fixtureOpenConsole()')
          await expect.poll(
            () => page.evaluate('globalThis.__fixtureConsoleSignals?.includes("fixture-console-ready") ?? false'),
            { timeout: 20_000 },
          ).toBe(true)
        } catch (cause) {
          const state = await page.evaluate<unknown>(
            '({ status: globalThis.__fixtureConsoleStatus, hasHandle: globalThis.__fixtureConsoleHasHandle,'
              + ' reason: globalThis.__fixtureConsoleReason, hasOrigin: !!globalThis.__fixtureConsoleOrigin,'
              + ' signals: globalThis.__fixtureConsoleSignals, frames: document.querySelectorAll("iframe").length,'
              + ' navigation: [...document.querySelectorAll("[data-settings-navigation-item]")].map(item => ({'
              + ' id: item.getAttribute("data-settings-navigation-item"), current: item.getAttribute("aria-current") })), '
              + ' plugins: globalThis.__cordisxRuntime?.snapshot?.().plugins?.map(({ id, status }) => ({ id, status })), '
              + ' events: globalThis.__publicFixtureEvents })',
          )
          throw new Error('HTTPS managed console did not become ready: ' + JSON.stringify(state), { cause })
        }
        return await page.evaluate<string>('globalThis.__fixtureConsoleOrigin')
      }
      await ready(first)
      const firstConsole = await consoleReady(first)
      const policy = await first.evaluate<string>(
        "fetch('/').then(response => response.headers.get('content-security-policy'))",
      )
      expect(policy).toContain('frame-src https://*.console.localhost:' + proxyAddress.port)
      const debugOrigin = 'http://' + new URL(socket).host
      const response = await fetch(debugOrigin + '/json/new?about:blank', { method: 'PUT' })
      const tab = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(tab.webSocketDebuggerUrl)
      pages.push(second)
      await instrument(second)
      await second.send('Page.enable')
      await second.send('Page.navigate', { url: await link() })
      await ready(second)
      const secondConsole = await consoleReady(second)
      expect(secondConsole).not.toBe(firstConsole)
      const firstResume = await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")
      const secondResume = await second.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")
      expect(typeof firstResume === 'string' && typeof secondResume === 'string' && firstResume !== secondResume)
        .toBe(true)
      const timeOrigin = await first.evaluate('performance.timeOrigin')
      await first.send('Page.reload')
      await expect.poll(() => first.evaluate('performance.timeOrigin'), { timeout: 15_000 }).not.toBe(timeOrigin)
      await ready(first)
      expect(await consoleReady(first)).not.toBe(firstConsole)
      await ready(second)
      await second.evaluate(
        'document.querySelector("iframe[data-fixture-console]").contentWindow.postMessage("probe", "*")',
      )
      await expect.poll(
        () => second.evaluate('globalThis.__fixtureConsoleSignals?.includes("fixture-console-probe") ?? false'),
        { timeout: 15_000 },
      ).toBe(true)
      expect(JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout).pid)
        .toBe(started.pid)
    } finally {
      const failures: unknown[] = []
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          cleanupConfirmed = false
          failures.push(error)
        }
      }
      for (const page of pages) await cleanup(async () => await page.close())
      await cleanup(async () => {
        if (browser) await stopChrome(browser)
      })
      await cleanup(async () => {
        if (!proxy?.listening) return
        proxy.closeAllConnections()
        await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve()))
      })
      await cleanup(async () => {
        if (managerAttempted) expect(JSON.parse((await run('manager', 'stop')).stdout).status).toBe('stopped')
      })
      await cleanup(async () => {
        if (ownerAttempted) {
          expect(JSON.parse((await run('stop', '--mode', 'service', 'codex', 'default', '--json')).stdout).status)
            .toBe('stopped')
        }
      })
      if (cleanupConfirmed) {
        await cleanup(async () => {
          await makeRemovable(home)
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        })
      }
      if (failures.length) throw new AggregateError(failures, 'fixture process cleanup was not confirmed')
    }
  },
  200_000,
)
