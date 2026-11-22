import { type ChildProcess, execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const exec = promisify(execFile)
const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
const executable = (candidate: string | undefined): candidate is string => {
  if (!candidate || !path.isAbsolute(candidate)) return false
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}
const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
    ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
  ),
].find(executable)
const codex = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'codex'))
  .find(executable)

it.skipIf(
  !archive || !managerPackage || !chrome || !codex || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'persists Channel UI decisions through the actual service owner and two Manager pages',
  async () => {
    const root = await mkdtemp('/tmp/cx-owner-policy-')
    const homeDir = path.join(root, 'h')
    const userHome = path.join(root, 'u')
    const codexHome = path.join(root, 'c')
    const browserProfile = path.join(root, 'browser')
    const configPath = path.join(homeDir, 'config.json')
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: userHome,
      CODEX_HOME: codexHome,
      CORDISX_HOME: homeDir,
      CORDISX_MODEL_API_PORT: '0',
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
    }
    const cli = path.join(root, 'package', 'dist', 'src', 'cli.js')
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli, ...args], {
        cwd: root,
        env: environment,
        timeout: 35_000,
      })
    const pages: CdpClient[] = []
    let browser: ChildProcess | undefined
    const open = async () => {
      const url = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      url.searchParams.set('host', '1')
      return url.href
    }
    const ready = async (page: CdpClient) => {
      try {
        await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
          .toBe('true')
      } catch (error) {
        const state = await page.evaluate(`({
          text: document.body?.innerText.slice(0, 300),
          readyState: document.readyState,
          controlled: Boolean(navigator.serviceWorker?.controller),
        })`).catch(() => ({ unavailable: true }))
        const events = page.diagnostics.map(item => (item as { method?: string }).method).slice(-20)
        throw new Error('Manager did not start: ' + JSON.stringify({ state, events }), { cause: error })
      }
      await expect.poll(
        () => page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))'),
        { timeout: 20_000 },
      ).toBe(true)
    }
    const policy = async (point: string) =>
      (await loadHomeConfig(configPath)).permissions.find(record =>
        record.key.identity.pluginId === 'channel' && 'extensionPoints' in record.key.scope
        && record.key.scope.extensionPoints?.includes(point)
      )?.policy
    const approve = async (page: CdpClient) => {
      await expect.poll(
        () => page.evaluate('document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview'),
        { timeout: 20_000 },
      ).toBeTruthy()
      const point = await page.evaluate<string>(
        'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
      )
      await expect.poll(
        () => page.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))'),
        { timeout: 15_000 },
      ).toBe(true)
      await trustedClick(page, '[data-standalone-dom-review] button')
      await expect.poll(
        () => page.evaluate('Boolean(document.querySelector("[data-permission-decision=allow-persistent]"))'),
        { timeout: 15_000 },
      ).toBe(true)
      await trustedClick(page, '[data-permission-decision=allow-persistent]')
      await expect.poll(
        () =>
          page.evaluate(
            'document.querySelector("[data-permission-decision=allow-persistent]")?.getAttribute("aria-checked")',
          ),
      ).toBe('true')
      await trustedClick(page, '[data-permission-action=confirm]')
      await expect.poll(() => policy(point), { timeout: 60_000 }).toBe('allow-persistent')
      await expect.poll(
        () =>
          page.evaluate(
            'document.querySelector("[data-standalone-dom-reset]:not(:disabled)")?.dataset.standaloneDomReset === '
              + JSON.stringify(point),
          ),
        { timeout: 60_000 },
      ).toBe(true)
      return point
    }
    try {
      if (!path.isAbsolute(archive!) || !path.isAbsolute(managerPackage!)) {
        throw new Error('fixture paths must be absolute')
      }
      await Promise.all([homeDir, userHome, codexHome].map(directory => mkdir(directory, { mode: 0o700 })))
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{
            id: 'channel',
            entry: archive,
            services: {
              runtime: {
                profiles: {
                  default: {
                    revision: 1,
                    lastGoodRevision: 1,
                    config: SIMULATOR_CHANNEL_SERVICE_CONFIG,
                  },
                },
              },
            },
          }],
        }),
        { mode: 0o600 },
      )
      await symlink(managerPackage!, path.join(root, 'package'), 'dir')
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const firstUrl = await open()
      const launched = launchChrome(chrome!, browserProfile)
      browser = launched.browser
      const socket = await waitForChromeTarget(browserProfile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      await first.send('Page.enable')
      await first.send('Runtime.enable')
      await first.send('Page.navigate', { url: firstUrl })
      await ready(first)
      const debugOrigin = 'http://' + new URL(socket).host
      const addPage = async (url: string) => {
        const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
        const target = await response.json() as { webSocketDebuggerUrl: string }
        const page = await CdpClient.connect(target.webSocketDebuggerUrl)
        pages.push(page)
        await page.send('Page.enable')
        await page.send('Runtime.enable')
        await ready(page)
        return page
      }
      const second = await addPage(await open())
      for (const page of [first, second]) {
        await expect.poll(() =>
          page.evaluate(
            'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
          )
        ).toBe('pending')
      }
      const reviewed = new Set<string>()
      for (let index = 0; index < 2; index++) {
        await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
        const point = await approve(first)
        expect(reviewed.has(point)).toBe(false)
        reviewed.add(point)
      }
      expect([...reviewed].sort()).toEqual(['manager.content', 'manager.settings.navigation-items'])
      await expect.poll(() =>
        second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
        )
      ).toBe(null)
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-reset]:not(:disabled)"))'),
        { timeout: 20_000 },
      ).toBe(true)
      const resetPoint = await first.evaluate<string>(
        'document.querySelector("[data-standalone-dom-reset]").dataset.standaloneDomReset',
      )
      await trustedClick(first, '[data-standalone-dom-reset]')
      await expect.poll(() => policy(resetPoint), { timeout: 60_000 }).toBe('ask')
      await expect.poll(() =>
        second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
        )
      ).toBe('pending')
      expect(await approve(first)).toBe(resetPoint)
      await expect.poll(() =>
        second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
        )
      ).toBe(null)
      await second.evaluate('globalThis.__policyBeforeReload = true')
      await second.send('Page.reload', { ignoreCache: true })
      await expect.poll(
        async () => await second.evaluate('globalThis.__policyBeforeReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await ready(second)
      await expect.poll(() =>
        second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
        )
      ).toBe(null)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json')
      await expect.poll(() => first.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
        timeout: 30_000,
      }).toBe(true)
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const recovered = await addPage(await open())
      await expect.poll(() =>
        recovered.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
        )
      ).toBe(null)
      await recovered.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(
        () => recovered.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'),
        { timeout: 20_000 },
      ).toBe(true)
    } finally {
      for (const page of pages) await page.close().catch(() => undefined)
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
      await rm(root, { recursive: true, force: true })
    }
  },
  240_000,
)
