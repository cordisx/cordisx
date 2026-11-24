import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { managerChildEnvironment } from '../packages/cli/src/cli/manager-supervisor.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { configuredManagerPlugin } from './fixtures/configured-manager-plugin.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const execute = promisify(execFile)
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

it.skipIf(chrome === undefined)(
  'keeps the real Manager available when a configured plugin fails and opens a healthy configured page',
  async () => {
    const root = await mkdtemp('/tmp/cx-configured-browser-')
    const homeDir = path.join(root, 'cordisx')
    const profile = path.join(root, 'chrome')
    const configPath = path.join(homeDir, 'config.json')
    const env = managerChildEnvironment(process.env, 'unused')
    delete env.CORDISX_MANAGER_CHILD_KEY
    Object.assign(env, {
      HOME: root,
      CODEX_HOME: path.join(root, 'codex'),
      CORDISX_HOME: homeDir,
      CORDISX_MODEL_API_PORT: '0',
    })
    let cli: string | undefined
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    let peer: CdpClient | undefined
    const run = async (...args: string[]) =>
      await execute(process.execPath, [cli!, ...args], {
        env,
        cwd: root,
        timeout: 45_000,
      })
    try {
      await mkdir(homeDir, { mode: 0o700 })
      const good = await configuredManagerPlugin(root)
      const broken = await configuredManagerPlugin(root, 'broken-demo', { invalidPage: true })
      const unsupported = await configuredManagerPlugin(root, 'needs-config')
      const review = await configuredManagerPlugin(root, 'review-demo')
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [
            { id: 'configured-demo', entry: good.archive },
            { id: 'broken-demo', entry: broken.archive },
            { id: 'needs-config', entry: unsupported.archive, config: { token: 'fixture-private' } },
            { id: 'review-demo', entry: review.archive },
          ],
        }),
        { mode: 0o600 },
      )
      const configured = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins
        .find(plugin => plugin.id === 'configured-demo')!
      const reviewSource = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins
        .find(plugin => plugin.id === 'review-demo')!.source
      const policies = exactDomPermissionPolicies('default', [{
        id: configured.id,
        entry: configured.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: configured.source! } },
      }))
      await persistPermissionPolicies({ configPath }, policies)

      const fixturePackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
      if (fixturePackage !== undefined) {
        if (!path.isAbsolute(fixturePackage)) throw new Error('fixture package must be an absolute path')
        await symlink(fixturePackage, path.join(root, 'package'), 'dir')
      } else {
        const packed = await execute('npm', [
          'pack',
          '--workspace',
          'cordisx',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          root,
          '--cache',
          path.join(root, 'npm-cache'),
        ], { env, cwd: process.cwd(), timeout: 45_000 })
        const name = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename
        expect(name).toBe(path.basename(name))
        await execute('tar', ['-xzf', path.join(root, name), '-C', root], { env, timeout: 45_000 })
        const modules = path.join(root, 'package', 'node_modules')
        await mkdir(modules, { recursive: true })
        for (const name of ['@vitejs', 'vite']) {
          await symlink(path.resolve('packages/cli/node_modules', name), path.join(modules, name), 'dir')
        }
      }
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      cli = path.join(root, 'package', 'dist', 'src', 'cli.js')
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const link = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      link.searchParams.set('host', '1')
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socket = await waitForChromeTarget(profile, browser, launched.stderr)
      page = await CdpClient.connect(socket)
      await page.send('Runtime.enable')
      await page.send('Page.enable')
      // The owner completes the idempotent startup migration, but the page
      // never receives its response before the user refreshes.
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: [
          '(() => {',
          '  const send = window.fetch.bind(window)',
          '  window.fetch = (resource, options) => {',
          '    if (typeof resource === "string" && resource.startsWith("/api/session/resume/") && sessionStorage.getItem("fixture-auto-resume") === "1") {',
          '      return send(resource, options).then(response => {',
          '        if (!response.ok) return response',
          '        sessionStorage.removeItem("fixture-auto-resume")',
          '        sessionStorage.setItem("fixture-auto-resume-lost", "1")',
          '        throw new TypeError("simulated lost recovery response")',
          '      })',
          '    }',
          '    if (resource === "/api/renderer/binding") {',
          '      try {',
          '        const envelope = JSON.parse(options.body)',
          '        const operation = JSON.parse(envelope.payload).operation',
          '        if (envelope.channel === "permission-policy" && sessionStorage.getItem("fixture-hold-permission") === "1" && !sessionStorage.getItem("fixture-permission-lost")) {',
          '          const count = Number(sessionStorage.getItem("fixture-permission-count") || "0")',
          '          sessionStorage.setItem("fixture-permission-count", String(count + 1))',
          '          return send(resource, options).then(async response => {',
          '            const result = await response.clone().json().catch(() => ({}))',
          '            if (!response.ok || result.ok !== true) return response',
          '            sessionStorage.setItem("fixture-permission-lost", "1")',
          '            return new Promise((_, reject) => { window.__fixtureRejectPermission = reject })',
          '          })',
          '        }',
          '        if (!sessionStorage.getItem("fixture-migration-lost") && envelope.channel === "plugin-management" && operation.kind === "migrate-legacy-sources") {',
          '          const count = Number(sessionStorage.getItem("fixture-migration-count") || "0")',
          '          sessionStorage.setItem("fixture-migration-count", String(count + 1))',
          '          return send(resource, options).then(response => {',
          '            if (!response.ok) return response',
          '            sessionStorage.setItem("fixture-migration-lost", "1")',
          '            return new Promise((_, reject) => { window.__fixtureRejectMigration = reject })',
          '          })',
          '        }',
          '      } catch {}',
          '    }',
          '    return send(resource, options)',
          '  }',
          '})()',
        ].join('\n'),
      })
      await page.send('Page.navigate', { url: link.href })
      const ready = async () =>
        await vi.waitFor(async () => {
          expect(
            await page!.evaluate(
              "document.documentElement.dataset.cordisxReady === 'true' && document.documentElement.dataset.cordisxManagerReady === 'true'",
            ),
          ).toBe(true)
        }, { timeout: 45_000 })
      const states = async () =>
        await page!.evaluate<Array<{ id: string; status: string }>>(
          'globalThis.__cordisxRuntime.snapshot().plugins.map(({id, status}) => ({id, status}))',
        )
      await ready()
      expect(await states()).toEqual(expect.arrayContaining([
        { id: 'configured-demo', status: 'active' },
        { id: 'broken-demo', status: 'failed' },
        { id: 'needs-config', status: 'failed' },
      ]))
      expect(await page.evaluate("document.body.textContent.includes('fixture-private')")).toBe(false)
      await page.evaluate('document.querySelector("[data-plugin-id=needs-config]").click()')
      await vi.waitFor(async () => {
        const state = await page!.evaluate<{ locale: string; error?: string; notice?: string }>(`(() => {
          const snapshot = globalThis.__cordisxRuntime.snapshot()
          const plugin = snapshot.plugins.find(item => item.id === 'needs-config')
          const detail = document.querySelector('[data-plugin-detail="needs-config"]')
          return { locale: snapshot.localization.locale, error: plugin?.error,
            notice: detail?.querySelector('[role="alert"]')?.textContent }
        })()`)
        const expected = state.locale.startsWith('zh')
          ? '此插件暂不支持独立管理页面。'
          : 'This plugin is not yet available in the standalone Manager.'
        expect(state).toMatchObject({ error: expected, notice: expected })
      }, { timeout: 10_000 })
      const actions = await page.evaluate<Array<{ label: string | null; disabled: boolean; className: string }>>(
        `(() => {
        return [...document.querySelectorAll('[data-plugin-detail="needs-config"] .cxr-plugin-identity-actions [aria-label]')]
          .map(button => ({ label: button.getAttribute('aria-label'), disabled: button.matches(':disabled'),
            className: button.className }))
      })()`,
      )
      const disable = actions.find(button => ['Disable plugin', '禁用插件'].includes(button.label ?? ''))
      if (!disable?.disabled) throw new Error('Plugin disable action is not disabled: ' + JSON.stringify(actions))
      const navigationSelector = '[data-settings-navigation-item="configured-demo:navigation"]'
      const openFixturePage = async () => {
        await vi.waitFor(async () => {
          expect(
            await page!.evaluate(
              'Boolean(document.querySelector(' + JSON.stringify(navigationSelector) + '))',
            ),
          ).toBe(true)
        }, { timeout: 10_000 })
        await page!.evaluate('document.querySelector(' + JSON.stringify(navigationSelector) + ').click()')
        await vi.waitFor(async () => {
          expect(await page!.evaluate("document.body.textContent.includes('Configured fixture page')")).toBe(true)
        }, { timeout: 10_000 })
      }
      await openFixturePage()
      await vi.waitFor(async () => {
        const home = JSON.parse(await readFile(configPath, 'utf8'))
        expect(home.apps?.codex?.profiles?.default?.management?.migrations?.legacyBrowserSourcesV2).toBe(true)
        expect(await page!.evaluate("sessionStorage.getItem('fixture-migration-lost')")).toBe('1')
      }, { timeout: 20_000 })

      const secondLink = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      secondLink.searchParams.set('host', '1')
      const response = await fetch(
        'http://' + new URL(socket).host + '/json/new?' + encodeURIComponent(secondLink.href),
        {
          method: 'PUT',
        },
      )
      peer = await CdpClient.connect((await response.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl)
      await peer.send('Page.enable')
      await peer.send('Runtime.enable')
      const peerReady = async () =>
        await vi.waitFor(async () => {
          expect(
            await peer!.evaluate(
              "document.documentElement.dataset.cordisxReady === 'true' && document.documentElement.dataset.cordisxManagerReady === 'true'",
            ),
          ).toBe(true)
        }, { timeout: 45_000 })
      await peerReady()
      const reviewNavigation = '[data-settings-navigation-item="review-demo:navigation"]'
      const policy = async (point: string) => {
        const home = JSON.parse(await readFile(configPath, 'utf8')) as {
          permissions: Array<{
            key: { identity: { pluginId: string; source: string }; scope: { extensionPoints?: string[] } }
            policy: string
          }>
        }
        return home.permissions.find(record =>
          record.key.identity.pluginId === 'review-demo'
          && record.key.scope.extensionPoints?.[0] === point
        )
      }
      const peerPolicy = async (point: string) =>
        await peer!.evaluate<string | undefined>(
          'globalThis.__cordisxRuntime.snapshot().permissions.find(item => item.identity.id === "review-demo"'
            + ' && item.scope.extensionPoints?.[0] === ' + JSON.stringify(point) + ')?.policy',
        )
      const points = new Set<string>()
      for (let index = 0; index < 2; index++) {
        await vi.waitFor(async () => {
          expect(await page!.evaluate('Boolean(document.querySelector(' + JSON.stringify(reviewNavigation) + '))'))
            .toBe(true)
        }, { timeout: 15_000 })
        await page.evaluate('document.querySelector(' + JSON.stringify(reviewNavigation) + ').click()')
        await vi.waitFor(async () => {
          expect(
            await page!.evaluate(
              'Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))',
            ),
          )
            .toBe(true)
        }, { timeout: 15_000 })
        const point = await page.evaluate<string>(
          'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
        )
        points.add(point)
        await trustedClick(page, '[data-standalone-dom-review] button')
        await vi.waitFor(async () => {
          expect(await page!.evaluate('Boolean(document.querySelector("[data-permission-decision=allow-persistent]"))'))
            .toBe(true)
        }, { timeout: 15_000 })
        await trustedClick(page, '[data-permission-decision=allow-persistent]')
        await trustedClick(page, '[data-permission-action=confirm]')
        await vi.waitFor(async () => expect((await policy(point))?.policy).toBe('allow-persistent'), {
          timeout: 60_000,
        })
        expect((await policy(point))?.key.identity.source).toBe(reviewSource)
        await vi.waitFor(async () => expect(await peerPolicy(point)).toBe('allow'), { timeout: 60_000 })
        await vi.waitFor(async () => {
          expect(await page!.evaluate('Boolean(document.querySelector("[data-standalone-dom-reset]:not(:disabled)"))'))
            .toBe(true)
        }, { timeout: 60_000 })
      }
      expect([...points].sort()).toEqual(['manager.content', 'manager.settings.navigation-items'])
      await peer.evaluate('globalThis.__beforeConfiguredPolicyReload = true')
      await peer.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await peer!.evaluate('globalThis.__beforeConfiguredPolicyReload === undefined')).toBe(true)
      }, { timeout: 30_000 })
      await peerReady()
      for (const point of points) {
        await vi.waitFor(async () => expect(await peerPolicy(point)).toBe('allow'), { timeout: 30_000 })
      }
      const resetPoint = await page.evaluate<string>(
        'document.querySelector("[data-standalone-dom-reset]").dataset.standaloneDomReset',
      )
      await page.evaluate("sessionStorage.setItem('fixture-hold-permission', '1')")
      await trustedClick(page, '[data-standalone-dom-reset]')
      await vi.waitFor(async () => expect((await policy(resetPoint))?.policy).toBe('ask'), { timeout: 60_000 })
      await vi.waitFor(async () => expect(await peerPolicy(resetPoint)).toBe('ask'), { timeout: 60_000 })
      await vi.waitFor(async () => {
        expect(await page!.evaluate("sessionStorage.getItem('fixture-permission-lost')")).toBe('1')
      }, { timeout: 30_000 })

      const previousResume = await page.evaluate<string | null>("sessionStorage.getItem('cordisx-manager-resume-id')")
      expect(previousResume).toMatch(/^[a-f0-9]{64}$/u)
      await page.evaluate([
        "window.addEventListener('beforeunload', () => {",
        "  sessionStorage.setItem('fixture-migration-aborted', '1')",
        "  window.__fixtureRejectMigration?.(new Error('simulated interrupted response'))",
        "  window.__fixtureRejectPermission?.(new Error('simulated interrupted response'))",
        '}, { once: true })',
      ].join('\n'))
      await page.send('Page.reload')
      try {
        await vi.waitFor(async () => {
          const next = await page!.evaluate<string | null>("sessionStorage.getItem('cordisx-manager-resume-id')")
          expect(next).toMatch(/^[a-f0-9]{64}$/u)
          expect(next).not.toBe(previousResume)
        }, { timeout: 30_000 })
      } catch (error) {
        const state = await page.evaluate(
          "({ status: document.querySelector('p[role=status]')?.textContent, hasResume: !!sessionStorage.getItem('cordisx-manager-resume-id'), hasAttempt: !!sessionStorage.getItem('cordisx-manager-resume-attempt') })",
        )
        throw new Error('Configured Manager did not recover: ' + JSON.stringify(state), { cause: error })
      }
      await ready()
      expect(await states()).toEqual(expect.arrayContaining([
        { id: 'configured-demo', status: 'active' },
        { id: 'broken-demo', status: 'failed' },
        { id: 'needs-config', status: 'failed' },
      ]))
      await openFixturePage()
      expect(await page.evaluate("sessionStorage.getItem('fixture-migration-count')")).toBe('1')
      expect(await page.evaluate("sessionStorage.getItem('fixture-migration-aborted')")).toBe('1')
      expect(await page.evaluate("sessionStorage.getItem('fixture-permission-count')")).toBe('1')
      expect(
        await page.evaluate(
          'globalThis.__cordisxRuntime.snapshot().permissions.find(item => item.identity.id === "review-demo"'
            + ' && item.scope.extensionPoints?.[0] === ' + JSON.stringify(resetPoint) + ')?.policy',
        ),
      ).toBe('ask')
      const beforeAutoRetry = await page.evaluate<string>("sessionStorage.getItem('cordisx-manager-resume-id')")
      await page.evaluate("sessionStorage.setItem('fixture-auto-resume', '1')")
      await page.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await page!.evaluate("sessionStorage.getItem('fixture-auto-resume-lost')")).toBe('1')
        expect(await page!.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")).not.toBe(beforeAutoRetry)
      }, { timeout: 30_000 })
      await ready()
      expect(await page.evaluate("sessionStorage.getItem('fixture-permission-count')")).toBe('1')
      expect(await page.evaluate("sessionStorage.getItem('fixture-migration-count')")).toBe('1')
    } finally {
      await peer?.close().catch(() => undefined)
      await page?.close().catch(() => undefined)
      if (browser) await stopChrome(browser)
      if (cli) {
        await run('manager', 'stop').catch(() => undefined)
        await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
      }
      const makeRemovable = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700)
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isDirectory()) await makeRemovable(path.join(directory, item.name))
        }
      }
      await makeRemovable(root)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  120_000,
)
