import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const exec = promisify(execFile)
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

const browserPlugin = [
  "export const inject = ['pages', 'routes', 'slots', 'i18n']",
  'export function apply(ctx) {',
  "  ctx.i18n.define({ namespace: 'review-fixture', locale: 'en', default: true,",
  "    messages: { title: 'Review fixture', description: 'Review fixture page' } })",
  "  const title = { namespace: 'review-fixture', key: 'title', fallback: 'Review fixture' }",
  "  const description = { namespace: 'review-fixture', key: 'description', fallback: 'Review fixture page' }",
  '  ctx.pages.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v4.schema.json',",
  "    schemaVersion: 4, id: 'manager', title, description, icon: 'host:layers', chrome: 'standard'",
  '  }, context => {',
  "    const body = context.document.createElement('p')",
  "    body.dataset.installedReviewFixture = 'true'",
  "    body.textContent = 'Installed plugin page'",
  '    context.container.append(body)',
  '    return () => body.remove()',
  '  })',
  '  ctx.routes.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json',",
  "    schemaVersion: 2, id: 'manager', path: '/manager/extensions/review-fixture',",
  "    outlet: 'manager.content', page: 'manager', title, description",
  '  })',
  '  ctx.slots.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v11.schema.json',",
  "    schemaVersion: 11, name: 'manager.settings.navigation-items', id: 'manager', group: 'after-settings', order: 170",
  "  }, { route: { id: 'manager' }, navigationGroup: { id: 'external-accounts' } })",
  '}',
].join('\n')

it.skipIf(
  !managerPackage || !chrome || !codex || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'reviews an installed plugin in one real Manager tab and retires its grants on refresh or owner loss',
  async () => {
    if (!path.isAbsolute(managerPackage!)) throw new Error('fixture path must be absolute')
    const root = await realpath(process.env.CORDISX_REVIEW_TEST_ROOT ?? await mkdtemp('/tmp/cx-installed-review-'))
    if (!/^\/(?:private\/)?tmp\/cx-installed-review-[A-Za-z0-9]+$/u.test(root) || (await readdir(root)).length !== 0) {
      throw new Error('fixture root is invalid or not empty')
    }
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
      await exec(process.execPath, [cli, ...args], {
        cwd: root,
        env,
        timeout: 45_000,
      })
    const open = async () => {
      const url = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      url.searchParams.set('host', '1')
      return url.href
    }
    const pages: CdpClient[] = []
    let browser: ChildProcess | undefined
    let ownerAttempted = false
    let managerAttempted = false
    try {
      await Promise.all([homeDir, userHome, codexHome].map(directory => mkdir(directory, { mode: 0o700 })))
      await writeFile(configPath, JSON.stringify({ ...createDefaultHomeConfig(), marketplaceSources: [] }), {
        mode: 0o600,
      })
      await stageServiceModePlugin(root, homeDir, 'default', true, 'https://example.test/fixtures', browserPlugin, {
        version: 15,
        uiPoints: ['manager.content', 'manager.settings.navigation-items'],
        authentication: true,
      })
      await symlink(managerPackage!, path.join(root, 'package'), 'dir')
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      ownerAttempted = true
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      managerAttempted = true
      const firstUrl = await open()
      const launched = launchChrome(chrome!, browserProfile)
      browser = launched.browser
      const socket = await waitForChromeTarget(browserProfile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      const ready = async (page: CdpClient) => {
        await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
          .toBe('true')
        await expect.poll(
          () =>
            page.evaluate(
              'document.querySelector("[data-settings-navigation-item^=fixture-service]")?.dataset.permissionReview',
            ),
          { timeout: 20_000 },
        ).toBe('pending')
      }
      await ready(first)
      const response = await fetch('http://' + new URL(socket).host + '/json/new?' + encodeURIComponent(await open()), {
        method: 'PUT',
      })
      const second = await CdpClient.connect(
        (await response.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl,
      )
      pages.push(second)
      await second.send('Runtime.enable')
      await second.send('Page.enable')
      await ready(second)
      const permissionsBefore = (JSON.parse(await readFile(configPath, 'utf8')) as { permissions: unknown }).permissions
      const aliases = await Promise.all(pages.map(page =>
        page.evaluate<string>(
          'globalThis.__cordisxRuntime.activePluginGeneration().plugins[0].canonicalSource',
        )
      ))
      expect(aliases[0]).toMatch(/^https:\/\/renderer[.]cordisx[.]invalid\/plugin\/[a-f0-9]{64}$/u)
      expect(aliases[0]).not.toBe(aliases[1])
      const points = new Set<string>()
      for (let index = 0; index < 2; index += 1) {
        await first.evaluate('document.querySelector("[data-settings-navigation-item^=fixture-service]").click()')
        await expect.poll(
          () =>
            first.evaluate<string | undefined>(
              'document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview',
            ),
          { timeout: 15_000 },
        ).toBeTruthy()
        points.add(
          await first.evaluate<string>(
            'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
          ),
        )
        await first.evaluate('document.querySelector("[data-standalone-dom-review] button").click()')
        expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(false)
        await trustedClick(first, '[data-standalone-dom-review] button')
        await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'))
          .toBe(true)
        expect(
          await first.evaluate<string[]>(
            '[...document.querySelectorAll("[data-permission-decision]")].map(x => x.dataset.permissionDecision)',
          ),
        ).toEqual(['deny-once', 'allow-once'])
        await trustedClick(first, '[data-permission-decision=allow-once]')
        await trustedClick(first, '[data-permission-action=confirm]')
        await expect.poll(
          () => first.evaluate('document.querySelector("[data-standalone-dom-review] [role=status]")?.textContent'),
          { timeout: 15_000 },
        ).toMatch(/已在此标签页允许|Allowed in this tab/u)
      }
      expect([...points].sort()).toEqual(['manager.content', 'manager.settings.navigation-items'])
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=fixture-service]").click()')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-installed-review-fixture]"))'))
        .toBe(true)
      expect(
        await second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=fixture-service]")?.dataset.permissionReview',
        ),
      ).toBe('pending')
      expect((JSON.parse(await readFile(configPath, 'utf8')) as { permissions: unknown }).permissions)
        .toEqual(permissionsBefore)
      await first.evaluate('globalThis.__beforeReviewReload = true')
      await first.send('Page.reload')
      await expect.poll(() => first.evaluate('globalThis.__beforeReviewReload === undefined').catch(() => false))
        .toBe(true)
      await ready(first)
      expect(await first.evaluate('Boolean(document.querySelector("[data-installed-review-fixture]"))')).toBe(false)
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=fixture-service]").click()')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button"))'))
        .toBe(true)
      await trustedClick(first, '[data-standalone-dom-review] button')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))'))
        .toBe(true)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json')
      await expect.poll(() => first.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
        timeout: 30_000,
      }).toBe(true)
      expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(false)
    } finally {
      for (const page of pages) await page.close().catch(() => undefined)
      if (browser) await stopChrome(browser)
      let safe = true
      if (managerAttempted) {
        await run('manager', 'stop').catch(() => undefined)
        try {
          safe &&= JSON.parse((await run('manager', 'status')).stdout).status === 'stopped'
        } catch {
          safe = false
        }
      }
      if (ownerAttempted) {
        await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
        try {
          safe &&= JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout).status
            === 'stopped'
        } catch {
          safe = false
        }
      }
      if (!safe) throw new Error('fixture processes not confirmed stopped; temporary data retained')
      const makeRemovable = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700)
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
        }
      }
      await makeRemovable(root)
      await exec('/bin/rm', ['-rf', root])
    }
  },
  240_000,
)
