import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
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
  if (result.status === 'available') globalThis.__fixtureManagedService = result.service;
}`

async function makeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
  }
}

it.skipIf(chrome === undefined)(
  'logs in through an isolated service owner and rejects an uncoordinated second Manager',
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
        { authentication: true },
      )
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
      }
      await ready(first)
      const before = await first.evaluate<{ state: string }>(`(async () => {
        const result = await globalThis.__fixtureManagedService.snapshot();
        return { state: result.projection.auth.state };
      })()`)
      expect(before.state).toBe('missing')
      const login = `async (id) => {
        const service = globalThis.__fixtureManagedService;
        const snapshot = await service.snapshot();
        return await service.authenticate({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
          contract: 'cordisx.managed-service-login-request/v1', schemaVersion: 1, requestId: id,
          binding: service.binding, action: 'login', expectedSequence: snapshot.projection.sequence,
          userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
        });
      }`
      const actionLog = path.join(home, 'managed-services', 'fixture-service', 'gateway', 'fixture-auth-actions')
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
      const actions = await readFile(actionLog, 'utf8')
      expect(actions.split('\n').filter(value => value === 'login')).toHaveLength(1)
      const debugOrigin = `http://${new URL(socket).host}`
      const secondResponse = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(await link())}`, {
        method: 'PUT',
      })
      const secondTarget = await secondResponse.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(secondTarget.webSocketDebuggerUrl)
      clients.push(second)
      await ready(second)
      expect(await first.evaluate(`(${login})('second-login').then(() => 'unexpected', error => error.message)`))
        .toBe('owner-unavailable')
      expect(await readFile(actionLog, 'utf8')).toBe(actions)
      expect(await second.evaluate('globalThis.__fixtureManagedService.snapshot().then(value => value.status)'))
        .toBe('available')
    } finally {
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
