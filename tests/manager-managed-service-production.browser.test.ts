import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
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

const fixturePlugin = `
export const inject = ['managedServices'];
export async function apply(ctx) {
  const result = await ctx.managedServices.get({ serviceId: 'gateway' });
  globalThis.__fixtureManagedStatus = result.status;
  if (result.status === 'available') {
    globalThis.__fixtureManagedService = result.service;
    globalThis.__fixtureManagedScope = result.service.binding.scope;
    globalThis.__fixtureManagedAlias = ctx.managedServices.token;
    globalThis.__fixturePluginGeneration = ctx.managedServices.owner.pluginGeneration;
    globalThis.__fixtureManagedSnapshot = (await result.service.snapshot()).status;
  }
}`

async function makeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
  }
}

it.skipIf(chrome === undefined)(
  'runs two browser clients against one real managed-service owner with isolated read-only aliases',
  async () => {
    const root = await mkdtemp('/tmp/cx-managed-browser-')
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
        timeout: 35_000,
      })
    let browser: ChildProcess | undefined
    const clients: CdpClient[] = []
    try {
      await mkdir(home)
      await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
      await stageServiceModePlugin(root, home, 'default', true, 'https://example.test/fixtures', fixturePlugin)
      const started = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      expect(started).toMatchObject({ status: 'ready', mode: 'service' })
      const link = async () => {
        const output = (await run('manager', 'open', '--print-url')).stdout.trim().split(/\s+/u).at(-1)!
        const url = new URL(output)
        url.search = '?host=1'
        return url.href
      }
      const firstLink = await link()
      const profile = await mkdtemp(path.join(root, 'chrome-'))
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socket = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      clients.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstLink })
      const waitForSnapshot = async (client: CdpClient, label: string) => {
        try {
          await expect.poll(() => client.evaluate('globalThis.__fixtureManagedSnapshot'), { timeout: 45_000 })
            .toBe('available')
        } catch (cause) {
          const state = await client.evaluate(`({
            path: location.pathname + location.search,
            ready: document.documentElement.dataset.cordisxReady ?? null,
            status: document.querySelector('p[role=status]')?.textContent ?? null,
            statusHidden: document.querySelector('p[role=status]')?.hidden ?? null,
            managed: globalThis.__fixtureManagedStatus ?? null,
            hasRuntime: !!globalThis.__cordisxRuntime,
            workerControlled: !!navigator.serviceWorker?.controller,
            plugins: globalThis.__cordisxRuntime?.snapshot?.().plugins?.map(({ id, status }) => ({ id, status })) ?? []
          })`).catch(() => ({ unavailable: true }))
          throw new Error(`${label} managed-service page did not become ready: ${JSON.stringify(state)}`, { cause })
        }
      }
      await waitForSnapshot(first, 'first')
      expect(await first.evaluate('globalThis.__fixtureManagedStatus')).toBe('available')
      const debugOrigin = `http://${new URL(socket).host}`
      // Each entry is valid for only one minute; issue the second immediately
      // before navigation instead of spending its lifetime booting the first.
      const secondLink = await link()
      const tabResponse = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(secondLink)}`, { method: 'PUT' })
      const tab = await tabResponse.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(tab.webSocketDebuggerUrl)
      clients.push(second)
      await waitForSnapshot(second, 'second')
      const firstAlias = await first.evaluate<string>('globalThis.__fixtureManagedAlias')
      const secondAlias = await second.evaluate<string>('globalThis.__fixtureManagedAlias')
      expect(typeof firstAlias === 'string' && typeof secondAlias === 'string' && firstAlias !== secondAlias).toBe(true)
      const scope = await second.evaluate<{ profileId: string; generation: string }>('globalThis.__fixtureManagedScope')
      const pluginGeneration = await second.evaluate<string>('globalThis.__fixturePluginGeneration')
      const request = JSON.stringify({
        version: 1,
        token: firstAlias,
        requestId: 'fixture-cross-session',
        operation: 'get',
        scope: { profileId: scope.profileId, runtimeGeneration: scope.generation, pluginGeneration },
        serviceId: 'gateway',
      })
      const rejected = await second.evaluate<{ ok: boolean }>(`new Promise(resolve => {
        const receiver = globalThis.__cordisxManagedServiceUIReceiveV1;
        const timer = setTimeout(() => { globalThis.__cordisxManagedServiceUIReceiveV1 = receiver; resolve(null); }, 5000);
        globalThis.__cordisxManagedServiceUIReceiveV1 = payload => {
          const value = JSON.parse(payload);
          if (value.requestId !== 'fixture-cross-session') return receiver(payload);
          clearTimeout(timer); globalThis.__cordisxManagedServiceUIReceiveV1 = receiver; resolve(value);
        };
        globalThis.__cordisxManagedServiceUIRequestV1(${JSON.stringify(request)});
      })`)
      expect(rejected?.ok).toBe(false)
      expect(
        await second.evaluate(
          `globalThis.__fixtureManagedService.subscribe().then(async value => value.status === 'subscribed'
          ? (await value.subscription.unsubscribe()).reason : value.status)`,
        ),
      ).toBe('explicit')
      await first.evaluate("dispatchEvent(new Event('pagehide'))")
      await expect.poll(() => first.evaluate('typeof globalThis.__cordisxManagedServiceUIRequestV1'), {
        timeout: 10_000,
      }).toBe('undefined')
      expect(await second.evaluate('globalThis.__fixtureManagedService.snapshot().then(value => value.status)'))
        .toBe('available')
      const current = JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      expect(current.pid).toBe(started.pid)
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
