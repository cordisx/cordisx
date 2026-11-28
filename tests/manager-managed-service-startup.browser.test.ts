import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  createDefaultHomeConfig,
  loadHomeConfig,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const exec = promisify(execFile)
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => {
  if (!value || !path.isAbsolute(value)) return false
  try {
    accessSync(value, constants.X_OK)
    return true
  } catch {
    return false
  }
})

it.skipIf(!managerPackage || !chrome || process.platform !== 'darwin' && process.platform !== 'linux').each(
  [15, 16] as const,
)(
  'binds a v%s managed-service owner and browser to the selected private startup configuration',
  async version => {
    const root = await mkdtemp('/tmp/cx-managed-startup-browser-')
    const home = path.join(root, 'home')
    const configPath = path.join(home, 'config.json')
    const marker = 'synthetic-private-startup-value'
    const cli = path.join(managerPackage!, 'dist/src/cli.js')
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
      await exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 35_000 })
    const updateMarker = async (value: string) =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              default: {
                ...current.apps.codex!.profiles.default!,
                managedServiceStartupConfig: { 'fixture-service': { marker: value } },
              },
            },
          },
        },
      }), configPath)
    const open = async () => {
      const value = (await run('manager', 'open', '--print-url')).stdout.trim().split(/\s+/u).at(-1)!
      const url = new URL(value)
      url.searchParams.set('host', '1')
      return url.href
    }
    let browser: ChildProcess | undefined
    const pages: CdpClient[] = []
    try {
      await mkdir(home)
      const config = createDefaultHomeConfig()
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          apps: {
            ...config.apps,
            codex: {
              ...config.apps.codex!,
              profiles: {
                ...config.apps.codex!.profiles,
                default: {
                  ...config.apps.codex!.profiles.default!,
                  managedServiceStartupConfig: { 'fixture-service': { marker } },
                },
              },
            },
          },
        }),
        { mode: 0o600 },
      )
      const pluginSource = [
        "export const inject = ['managedServices'];",
        'export async function apply(ctx) {',
        "  const result = await ctx.managedServices.get({ serviceId: 'gateway' });",
        "  globalThis.__startupFixtureAvailable = result.status === 'available';",
        '}',
      ].join('\n')
      await stageServiceModePlugin(
        root,
        home,
        'default',
        true,
        'https://example.test/fixtures',
        pluginSource,
        { version, nodeConfig: true, expectedConfigMarker: marker },
      )
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      await updateMarker('newer-synthetic-value')
      const firstUrl = await open()
      const profile = await mkdtemp(path.join(root, 'chrome-'))
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socket = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      await expect.poll(
        () => first.evaluate('(/连接不可用|connection unavailable/i).test(document.body.textContent || "")'),
        { timeout: 30_000 },
      ).toBe(true)
      await expect.poll(async () => {
        try {
          await updateMarker(marker)
          return true
        } catch (error) {
          if (error instanceof Error && error.name === 'ProfilePluginConfigFenceBusyError') return false
          throw error
        }
      }, { timeout: 15_000 }).toBe(true)
      const debugOrigin = 'http://' + new URL(socket).host
      const nextUrl = await open()
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(nextUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
      await expect.poll(() => second.evaluate('globalThis.__startupFixtureAvailable'), { timeout: 45_000 }).toBe(true)
      expect(
        await second.evaluate(
          'JSON.stringify(globalThis.__cordisxRuntime?.snapshot?.() ?? {}).includes(' + JSON.stringify(marker) + ')',
        ),
      )
        .toBe(false)
      expect(await second.evaluate('document.body.textContent.includes(' + JSON.stringify(marker) + ')')).toBe(false)
      await expect(updateMarker('blocked-synthetic-value')).rejects.toThrow('plugin configuration is in use')
      const current = await loadHomeConfig(configPath)
      await writeFile(
        configPath,
        JSON.stringify({
          ...current,
          apps: {
            ...current.apps,
            codex: {
              ...current.apps.codex!,
              profiles: {
                ...current.apps.codex!.profiles,
                default: {
                  ...current.apps.codex!.profiles.default!,
                  managedServiceStartupConfig: { 'fixture-service': { marker: 'bypassed-synthetic-value' } },
                },
              },
            },
          },
        }),
      )
      try {
        await expect.poll(
          () =>
            second.evaluate(
              '(/连接不可用|连接中断|操作结果未确认|connection unavailable|connection interrupted|operation result is unknown/i)'
                + '.test(document.body.textContent || "")',
            ),
          { timeout: 30_000 },
        ).toBe(true)
        expect(await second.evaluate('typeof globalThis.__cordisxRuntime?.snapshot')).not.toBe('function')
      } catch (cause) {
        const state = await second.evaluate<unknown>(
          '({ body: document.body.textContent?.slice(0, 400), '
            + 'ready: document.documentElement.dataset.cordisxReady, '
            + 'plugins: globalThis.__cordisxRuntime?.snapshot?.().plugins.map(({id, status}) => ({id, status})) })',
        )
        throw new Error('Expected stale profile retirement: ' + JSON.stringify(state), { cause })
      }
    } finally {
      await Promise.allSettled(pages.map(async page => await page.close()))
      if (browser) await stopChrome(browser)
      await run('manager', 'stop').catch(() => undefined)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
      const makeRemovable = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700)
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
        }
      }
      await makeRemovable(root)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  180_000,
)
