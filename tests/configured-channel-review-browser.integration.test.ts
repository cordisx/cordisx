import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
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
  'reviews a configured Channel only for one live Manager tab and retires it on refresh or owner loss',
  async () => {
    if (!path.isAbsolute(archive!) || !path.isAbsolute(managerPackage!)) {
      throw new Error('fixture paths must be absolute')
    }
    const root = await mkdtemp('/tmp/cx-channel-review-')
    const homeDir = path.join(root, 'h')
    const userHome = path.join(root, 'u')
    const codexHome = path.join(root, 'c')
    const browserProfile = path.join(root, 'browser')
    const configPath = path.join(homeDir, 'config.json')
    const env: NodeJS.ProcessEnv = {
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
      await exec(process.execPath, [cli, ...args], { cwd: root, env, timeout: 35_000 })
    const open = async () => {
      const url = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      url.searchParams.set('host', '1')
      return url.href
    }
    const pages: CdpClient[] = []
    let browser: ChildProcess | undefined
    try {
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
                profiles: { default: { revision: 1, lastGoodRevision: 1, config: SIMULATOR_CHANNEL_SERVICE_CONFIG } },
              },
            },
          }],
        }),
        { mode: 0o600 },
      )
      const plugin = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins[0]!
      const artifact = plugin.distributionArtifact!
      expect(artifact.version).toBeTruthy()
      expect(artifact.integrity).toMatch(/^sha256:[a-f0-9]{64}$/u)
      await symlink(managerPackage!, path.join(root, 'package'), 'dir')
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      const started = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout) as {
        status: string
        mode: string
      }
      expect({ status: started.status, mode: started.mode }).toEqual({ status: 'ready', mode: 'service' })
      const firstUrl = await open()
      const launched = launchChrome(chrome!, browserProfile)
      browser = launched.browser
      const socket = await waitForChromeTarget(browserProfile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      await expect.poll(() => first.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
        .toBe('true')

      const debugOrigin = 'http://' + new URL(socket).host
      const secondUrl = await open()
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(secondUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
      await second.send('Runtime.enable')
      await second.send('Page.enable')
      await expect.poll(() => second.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
        .toBe('true')
      for (const page of [first, second]) {
        await expect.poll(
          () =>
            page.evaluate(
              'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
            ),
          { timeout: 20_000 },
        ).toBe('pending')
        expect(
          await page.evaluate(
            'Boolean(document.querySelector("[data-channel-manager], [data-manager-collection-item]"))',
          ),
        )
          .toBe(false)
      }

      const reviewed = new Set<string>()
      for (let index = 0; index < 2; index += 1) {
        await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
        try {
          await expect.poll(
            () => first.evaluate('document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview'),
            { timeout: 15_000 },
          ).toBeTruthy()
        } catch (error) {
          const state = await first.evaluate(
            '(() => { const snapshot = globalThis.__cordisxRuntime?.snapshot();'
              + ' return { text: document.body.innerText.slice(0, 800),'
              + ' permissions: snapshot?.permissions?.filter(item => item.identity.id === "channel").map(item => ({'
              + ' capability: item.capability, scope: item.scope, policy: item.policy })),'
              + ' plugins: snapshot?.plugins?.filter(item => item.id === "channel").map(item => ({'
              + ' id: item.id, status: item.status })) }; })()',
          )
          throw new Error('Standalone review control unavailable: ' + JSON.stringify(state), { cause: error })
        }
        const point = await first.evaluate<string>(
          'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
        )
        expect(reviewed.has(point)).toBe(false)
        reviewed.add(point)
        await expect.poll(
          () => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))'),
          { timeout: 15_000 },
        ).toBe(true)
        const control = await first.evaluate<{ hasButton: boolean; text: string }>(
          '(() => { const section = document.querySelector("[data-standalone-dom-review]");'
            + ' return { hasButton: !!section.querySelector("button"), text: section.innerText }; })()',
        )
        if (!control.hasButton) {
          throw new Error('Review control has no button: ' + JSON.stringify({ index, point, control }))
        }
        await first.evaluate('document.querySelector("[data-standalone-dom-review] button").click()')
        expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(false)
        await trustedClick(first, '[data-standalone-dom-review] button')
        await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'), {
          timeout: 15_000,
        }).toBe(true)
        const prompt = await first.evaluate<{
          digest: boolean
          version: boolean
          inlineStyles: number
          display: string
          panelBackground: string
          panelRadius: number
          optionsDisplay: string
          decisions: string[]
        }>(
          '(() => { const dialog = document.querySelector("[data-permission-authorization]"); return {'
            + ' digest: dialog.textContent.includes(' + JSON.stringify(artifact.integrity) + '),'
            + ' version: dialog.textContent.includes(' + JSON.stringify(artifact.version) + '),'
            + ' inlineStyles: dialog.querySelectorAll("style").length,'
            + ' display: getComputedStyle(dialog).display,'
            + ' panelBackground: getComputedStyle(dialog.querySelector(".cxp-dialog")).backgroundColor,'
            + ' panelRadius: parseFloat(getComputedStyle(dialog.querySelector(".cxp-dialog")).borderRadius),'
            + ' optionsDisplay: getComputedStyle(dialog.querySelector(".cxp-options")).display,'
            + ' decisions: [...dialog.querySelectorAll("[data-permission-decision]")].map(x => x.dataset.permissionDecision)'
            + ' }; })()',
        )
        expect(prompt).toMatchObject({
          digest: true,
          version: true,
          inlineStyles: 0,
          display: 'grid',
          optionsDisplay: 'grid',
          decisions: ['deny-once', 'allow-once'],
        })
        expect(prompt.panelBackground).not.toBe('rgba(0, 0, 0, 0)')
        expect(prompt.panelRadius).toBeGreaterThan(0)
        await first.evaluate('document.querySelector("[data-permission-decision=allow-once]").click()')
        await first.evaluate('document.querySelector("[data-permission-action=confirm]").click()')
        expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(true)
        expect(
          await first.evaluate(
            'document.querySelector("[data-permission-decision=deny-once]").getAttribute("aria-checked")',
          ),
        )
          .toBe('true')
        await trustedClick(first, '[data-permission-decision=allow-once]')
        await expect.poll(
          () =>
            first.evaluate(
              'document.querySelector("[data-permission-decision=allow-once]")?.getAttribute("aria-checked")',
            ),
        ).toBe('true')
        await trustedClick(first, '[data-permission-action=confirm]')
        await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'))
          .toBe(false)
        await expect.poll(
          () => first.evaluate('document.querySelector("[data-standalone-dom-review] [role=status]")?.textContent'),
          { timeout: 15_000 },
        ).toMatch(/已在此标签页允许|Allowed in this tab/u)
      }
      expect([...reviewed].sort()).toEqual(['manager.content', 'manager.settings.navigation-items'])
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'), {
        timeout: 20_000,
      }).toBe(true)
      expect(
        await second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
        ),
      )
        .toBe('pending')
      expect(await second.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(false)
      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as { permissions: unknown[] }
      expect(persisted.permissions).toEqual([])

      await first.evaluate('globalThis.__beforeReviewReload = true')
      await first.send('Page.reload')
      await expect.poll(
        () => first.evaluate('globalThis.__beforeReviewReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await expect.poll(() => first.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 40_000 })
        .toBe('true')
      await expect.poll(
        () =>
          first.evaluate(
            'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
          ),
        { timeout: 20_000 },
      ).toBe('pending')
      expect(await first.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(false)
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button"))'))
        .toBe(true)
      await trustedClick(first, '[data-standalone-dom-review] button')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'))
        .toBe(true)
      const firstPoint = await first.evaluate<string>(
        'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
      )
      await trustedClick(first, '[data-permission-decision=allow-once]')
      await trustedClick(first, '[data-permission-action=confirm]')
      await expect.poll(
        () => first.evaluate('document.querySelector("[data-standalone-dom-review] [role=status]")?.textContent'),
        { timeout: 15_000 },
      ).toMatch(/已在此标签页允许|Allowed in this tab/u)
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(
        () => first.evaluate('document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview'),
        { timeout: 15_000 },
      ).toBe(firstPoint === 'manager.content' ? 'manager.settings.navigation-items' : 'manager.content')
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))'),
        { timeout: 15_000 },
      ).toBe(true)
      await trustedClick(first, '[data-standalone-dom-review] button')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'))
        .toBe(true)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json')
      await expect.poll(() => first.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
        timeout: 30_000,
      }).toBe(true)
      expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(false)
      expect(
        await first.evaluate(
          'Boolean(document.querySelector("[data-channel-manager], [data-manager-collection-item]"))',
        ),
      )
        .toBe(false)
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
