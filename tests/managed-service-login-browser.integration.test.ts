import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

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

const browserPlugin = `
export const inject = ['managedServices'];
export async function apply(ctx) {
  const result = await ctx.managedServices.get({ serviceId: 'gateway' });
  globalThis.__fixtureManagedStatus = result.status;
  if (result.status === 'available') {
    globalThis.__fixtureManagedService = result.service;
    globalThis.__fixtureManagedEvents = [];
    const observed = await result.service.subscribe();
    globalThis.__fixtureSubscribed = observed.status;
    if (observed.status === 'subscribed') void (async () => {
      for await (const page of observed.subscription.pages) {
        for (const update of page.updates) {
          const auth = update.kind === 'snapshot-replaced' ? update.projection.auth : update.delta.auth;
          if (auth) globalThis.__fixtureManagedEvents.push(auth.state);
        }
      }
    })();
  }
}`

async function makeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
  }
}

it.skipIf(chrome === undefined)(
  'coordinates login and state readback across two isolated Manager pages',
  async () => {
    const root = await mkdtemp('/tmp/cx-managed-login-')
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
      PATH: [path.join(root, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
    })
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 35_000 })
    const clients: CdpClient[] = []
    let browser: ChildProcess | undefined
    let modelRequest: AbortController | undefined
    try {
      await mkdir(home)
      await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
      await stageServiceModePlugin(
        root,
        home,
        'default',
        true,
        'https://example.test/fixtures',
        browserPlugin,
        { version: 15, authentication: true, logout: true },
      )
      const serviceHome = path.join(home, 'managed-services', 'fixture-service', 'gateway')
      await mkdir(serviceHome, { recursive: true, mode: 0o700 })
      await writeFile(path.join(serviceHome, 'fixture-authenticated'), 'ready', { mode: 0o600 })
      const started = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      expect(started).toMatchObject({ status: 'ready', mode: 'service' })
      const link = async () => {
        const output = (await run('manager', 'open', '--print-url')).stdout.trim().split(/\s+/u).at(-1)!
        const url = new URL(output)
        url.search = '?host=1'
        return url.href
      }
      const profile = await mkdtemp(path.join(root, 'chrome-'))
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socket = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      clients.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: await link() })
      const ready = async (client: CdpClient) => {
        await expect.poll(() => client.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 45_000 })
          .toBe('true')
        await expect.poll(() => client.evaluate('globalThis.__fixtureManagedStatus'), { timeout: 20_000 })
          .toBe('available')
        await expect.poll(() => client.evaluate('globalThis.__fixtureSubscribed'), { timeout: 20_000 })
          .toBe('subscribed')
        await expect.poll(() => client.evaluate('globalThis.__fixtureManagedEvents.includes("authenticated")'), {
          timeout: 20_000,
        }).toBe(true)
      }
      await ready(first)
      const debugOrigin = `http://${new URL(socket).host}`
      const secondResponse = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(await link())}`, {
        method: 'PUT',
      })
      const secondTarget = await secondResponse.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(secondTarget.webSocketDebuggerUrl)
      clients.push(second)
      await ready(second)
      const paths = pluginManagementRpcPaths(home, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(paths))!
      const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
        requestPluginManagementRpc(paths, endpoint, operation)
      expect(
        await request({
          kind: 'terminal-provider',
          request: { kind: 'wait', providerId: 'fixture-provider', model: 'fixture-model' },
        }),
      ).toEqual({ kind: 'ready' })
      const lease = await request({
        kind: 'terminal-provider',
        request: { kind: 'prepare', providerId: 'fixture-provider', model: 'fixture-model' },
      }) as { kind: string; leaseId: string }
      expect(lease.kind).toBe('prepared')
      const logout = [
        'async (id) => {',
        '  const service = globalThis.__fixtureManagedService;',
        '  const snapshot = await service.snapshot();',
        '  return await service.logout({',
        "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',",
        "    contract: 'cordisx.managed-service-logout-request/v1', schemaVersion: 1, requestId: id,",
        "    binding: service.binding, action: 'logout', expectedSequence: snapshot.projection.sequence,",
        "    userGesture: { kind: 'explicit-click', at: new Date().toISOString() },",
        '  });',
        '}',
      ].join('\n')
      const actionLog = path.join(serviceHome, 'fixture-auth-actions')
      expect(
        await first.evaluate('(' + logout + ")('blocked-logout').then(() => 'unexpected', error => error.message)"),
      )
        .toBe('owner-unavailable')
      expect((await readFile(actionLog, 'utf8')).split('\n')).not.toContain('logout')
      await request({ kind: 'terminal-provider', request: { kind: 'release', leaseId: lease.leaseId } })
      const accessKey = (await readFile(path.join(home, 'run', 'model-api', 'default', 'access-key'), 'utf8')).trim()
      modelRequest = new AbortController()
      const stream = await fetch(started.modelApiUrl + '/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture-provider::fixture-model', input: 'hold-open-fixture', stream: true }),
        signal: modelRequest.signal,
      })
      expect(stream.status).toBe(200)
      expect((await stream.body!.getReader().read()).done).toBe(false)
      expect(
        await first.evaluate('(' + logout + ")('api-blocked-logout').then(() => 'unexpected', error => error.message)"),
      ).toBe('owner-unavailable')
      expect((await readFile(actionLog, 'utf8')).split('\n')).not.toContain('logout')
      modelRequest.abort()
      const afterAbort = JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      expect(afterAbort.status).toBe('ready')
      await expect.poll(
        async () =>
          await first.evaluate(
            'globalThis.__fixtureManagedService.snapshot().then(value => value.projection.auth.state, () => "unavailable")',
          ),
        { timeout: 15_000 },
      ).toBe('authenticated')
      expect(await first.evaluate('(' + logout + ")('initial-logout')"))
        .toMatchObject({ status: 'accepted', stateAt: 'logged-out' })
      await expect.poll(() => second.evaluate('globalThis.__fixtureManagedEvents.includes("logged-out")'), {
        timeout: 20_000,
      }).toBe(true)
      for (const page of [first, second]) await page.evaluate('globalThis.__fixtureManagedEvents = []')
      const before = await first.evaluate<{ state: string; sequence: number }>(`(async () => {
        const result = await globalThis.__fixtureManagedService.snapshot();
        return { state: result.projection.auth.state, sequence: result.projection.sequence };
      })()`)
      expect(before.state).toBe('logged-out')
      const login = `async (id, expected) => {
        const service = globalThis.__fixtureManagedService;
        const snapshot = await service.snapshot();
        return await service.authenticate({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
          contract: 'cordisx.managed-service-login-request/v1', schemaVersion: 1, requestId: id,
          binding: service.binding, action: 'login', expectedSequence: expected ?? snapshot.projection.sequence,
          userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
        });
      }`
      const loginResult = await first.evaluate<{ status: string; error?: { code?: string } }>(
        `(${login})('first-login')`,
      )
      if (loginResult.status !== 'accepted') {
        const actions = await readFile(actionLog, 'utf8').catch(error => String(error.code))
        throw new Error(`Fixture login returned ${loginResult.status}/${loginResult.error?.code}; actions: ${actions}`)
      }
      expect(loginResult).toMatchObject({
        status: 'accepted',
        stateAt: 'authenticated',
      })
      expect(
        await first.evaluate(
          'globalThis.__fixtureManagedService.snapshot().then(value => value.projection.auth.state)',
        ),
      )
        .toBe('authenticated')
      await expect.poll(() => second.evaluate('globalThis.__fixtureManagedEvents.includes("authenticated")'), {
        timeout: 20_000,
      }).toBe(true)
      expect(
        await second.evaluate(
          'globalThis.__fixtureManagedService.snapshot().then(value => value.projection.auth.state)',
        ),
      )
        .toBe('authenticated')
      const actions = await readFile(actionLog, 'utf8')
      expect(actions.split('\n').filter(value => value === 'login')).toHaveLength(1)
      expect(
        await first.evaluate(
          `(${login})('stale-login', ${before.sequence}).then(() => 'unexpected', error => error.message)`,
        ),
      )
        .toBe('owner-unavailable')
      expect(await readFile(actionLog, 'utf8')).toBe(actions)
      const logoutResult = await second.evaluate<{ status: string; stateAt?: string }>([
        '(async () => {',
        '  const service = globalThis.__fixtureManagedService;',
        '  const snapshot = await service.snapshot();',
        '  return await service.logout({',
        "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',",
        "    contract: 'cordisx.managed-service-logout-request/v1', schemaVersion: 1, requestId: 'logout-after-login',",
        "    binding: service.binding, action: 'logout', expectedSequence: snapshot.projection.sequence,",
        "    userGesture: { kind: 'explicit-click', at: new Date().toISOString() },",
        '  });',
        '})()',
      ].join('\n'))
      expect(logoutResult).toMatchObject({ status: 'accepted', stateAt: 'logged-out' })
      await expect.poll(() => first.evaluate('globalThis.__fixtureManagedEvents.includes("logged-out")'), {
        timeout: 20_000,
      }).toBe(true)
      for (const page of [first, second]) {
        expect(
          await page.evaluate(
            'globalThis.__fixtureManagedService.snapshot().then(value => value.projection.auth.state)',
          ),
        ).toBe('logged-out')
      }
      const afterLogout = await readFile(actionLog, 'utf8')
      expect(afterLogout.split('\n').filter(value => value === 'logout')).toHaveLength(2)
    } finally {
      modelRequest?.abort()
      await Promise.allSettled(clients.map(async client => await client.close()))
      if (browser) await stopChrome(browser)
      await run('manager', 'stop').catch(() => undefined)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
      await makeRemovable(home)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  150_000,
)
