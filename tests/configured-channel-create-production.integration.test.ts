import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'
import { clickDialogAction, findDialogAction } from './helpers/manager-dialog.js'

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
).each([
  { label: 'archive', channelEntry: archive!, missingBundle: false },
  { label: 'bundled alias', channelEntry: 'cordisx:channel', missingBundle: false },
  { label: 'missing bundled archive', channelEntry: 'cordisx:channel', missingBundle: true },
])(
  'keeps the packaged service and Manager usable with $label',
  async ({ channelEntry, missingBundle }) => {
    const root = await realpath(await mkdtemp('/tmp/cx-production-channel-'))
    const homeDir = path.join(root, 'h')
    const userHome = path.join(root, 'u')
    const codexHome = path.join(root, 'c')
    const browserProfile = path.join(root, 'browser')
    const configPath = path.join(homeDir, 'config.json')
    const packagePath = await realpath(managerPackage!)
    const loader = pathToFileURL(path.resolve('tests/fixtures/channel-create-process-loader.mjs')).href
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: userHome,
      CODEX_HOME: codexHome,
      CORDISX_HOME: homeDir,
      CORDISX_MODEL_API_PORT: '0',
      CORDISX_CHANNEL_CREATE_FIXTURE_ROOT: root,
      CORDISX_CHANNEL_CREATE_PACKAGE: packagePath,
      CORDISX_CHANNEL_CREATE_MISSING_BUNDLE: missingBundle ? '1' : '0',
      NODE_OPTIONS: `--import=${loader}`,
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
    }
    const cli = path.join(root, 'package', 'dist', 'src', 'cli.js')
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli, ...args], { cwd: root, env, timeout: 45_000 })
    const pages: CdpClient[] = []
    let browser: ChildProcess | undefined
    let attemptedOwner = false
    let attemptedManager = false
    const open = async () => {
      attemptedManager = true
      const value = (await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!
      const url = new URL(value)
      url.searchParams.set('host', '1')
      return url.href
    }
    const exists = (page: CdpClient, selector: string) =>
      page.evaluate<boolean>('Boolean(document.querySelector(' + JSON.stringify(selector) + '))')
    const showManager = async (page: CdpClient) => {
      await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
        .toBe('true')
      await expect.poll(
        () => page.evaluate('document.querySelector("[data-cordisx-react-manager]")?.hidden === false'),
        { timeout: 60_000 },
      ).toBe(true)
    }
    const showChannel = async (page: CdpClient) => {
      await showManager(page)
      await expect.poll(() => exists(page, '[data-settings-navigation-item^=channel]'), { timeout: 15_000 })
        .toBe(true)
      await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(
        () =>
          page.evaluate(
            'document.body.innerText.includes("Simulator") || document.body.innerText.includes("模拟器")',
          ),
        { timeout: 15_000 },
      ).toBe(true)
    }
    const set = (page: CdpClient, selector: string, value: string) =>
      page.evaluate(
        '(() => { const input = document.querySelector(' + JSON.stringify(selector) + ');'
          + ' Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, '
          + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", { bubbles: true }));'
          + ' input.dispatchEvent(new Event("change", { bubbles: true })); })()',
      )
    try {
      if (!path.isAbsolute(archive!) || !path.isAbsolute(managerPackage!)) throw new Error('Invalid fixture paths')
      await Promise.all([homeDir, userHome, codexHome].map(directory => mkdir(directory, { mode: 0o700 })))
      if (process.env.CORDISX_TEST_CODEX_AUTH_FILE) {
        const auth = path.join(codexHome, 'auth.json')
        await copyFile(process.env.CORDISX_TEST_CODEX_AUTH_FILE, auth, constants.COPYFILE_EXCL)
        await chmod(auth, 0o600)
      }
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          plugins: [{
            id: 'channel',
            entry: channelEntry,
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
      const plugin = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins[0]!
      const bundledDescriptor = JSON.parse(
        await readFile(
          path.join(packagePath, 'dist/bundled-plugins/@cordisx/channel/cordisx-package.json'),
          'utf8',
        ),
      ) as { canonicalSource?: string }
      const source = plugin.source ?? bundledDescriptor.canonicalSource
      expect(source).toBeDefined()
      const policies = exactDomPermissionPolicies('default', [{
        id: 'channel',
        entry: plugin.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: source! } },
      }))
      await persistPermissionPolicies({ configPath }, policies)
      await symlink(packagePath, path.join(root, 'package'), 'dir')
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      attemptedOwner = true
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const firstUrl = await open()
      const launched = launchChrome(chrome!, browserProfile)
      browser = launched.browser
      const socket = await waitForChromeTarget(browserProfile, browser, launched.stderr)
      const first = await CdpClient.connect(socket)
      pages.push(first)
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      if (missingBundle) {
        await showManager(first)
        expect(await exists(first, '[data-settings-navigation-item^=channel]')).toBe(false)
        const connections = JSON.parse((await run('channel', 'connections', '--profile', 'default')).stdout)
        expect(JSON.stringify(connections)).toContain('simulator')
        await first.evaluate('globalThis.__beforeChannelReload = true')
        await first.send('Page.reload')
        await expect.poll(
          () => first.evaluate('globalThis.__beforeChannelReload === undefined').catch(() => false),
          { timeout: 15_000 },
        ).toBe(true)
        await showManager(first)
        return
      }
      await showChannel(first)
      const secondUrl = await open()
      const debugOrigin = 'http://' + new URL(socket).host
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(secondUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
      await showChannel(second)

      const create = '[data-cordisx-page-header-action="create"]'
      try {
        await expect.poll(() =>
          first.evaluate(
            '(() => { const button = document.querySelector(' + JSON.stringify(create) + ');'
              + ' const rect = button?.getBoundingClientRect();'
              + ' return Boolean(button && !button.disabled && rect.width > 0 && rect.height > 0); })()',
          ), { timeout: 15_000 }).toBe(true)
      } catch {
        const state = await first.evaluate(`({
          button: document.querySelector('[data-cordisx-page-header-action="create"]')?.outerHTML,
          text: document.body.innerText.slice(0, 350),
          globals: Object.keys(globalThis).filter(name => name.startsWith('__cordisx')).sort(),
        })`)
        throw new Error('Channel creation was not available: ' + JSON.stringify(state))
      }
      await trustedClick(first, create)
      await expect.poll(() => exists(first, '[data-channel-page=create]'), { timeout: 15_000 }).toBe(true)
      await set(first, '[data-channel-page=create] input[type=text]', 'Created fixture')
      await trustedClick(first, '[data-channel-page=create] button[type=submit]')
      await expect.poll(() => exists(first, '#channel-credential-appId input')).toBe(true)
      await set(first, '#channel-credential-appId input', 'cli_created_fixture')
      await set(first, '#channel-credential-tenantId input', 'fixture-tenant')
      await set(first, '#channel-credential-secret input', 'synthetic-create-secret')
      await expect.poll(async () => {
        const action = await findDialogAction(first, 'capture')
        return !!action && !action.attributes?.includes('disabled')
      }, { timeout: 15_000 }).toBe(true)
      const capture = await findDialogAction(first, 'capture')
      if (!capture) throw new Error('Credential action disappeared')
      await clickDialogAction(first, capture)

      const readService = async () => {
        const config = JSON.parse(await readFile(configPath, 'utf8'))
        return config.plugins[0].services.runtime.profiles.default
      }
      await expect.poll(async () => (await readService()).revision, { timeout: 45_000 }).toBe(2)
      const service = await readService()
      const connection = service.config.connections.find(
        (item: { ref: { accountId: string } }) => item.ref.accountId === 'cli_created_fixture',
      )
      expect(connection).toMatchObject({ displayName: 'Created fixture', enabled: true })
      expect(connection.secretRef).toMatch(/^host-secret:channel\/default\/draft-[a-f0-9]{40}$/u)
      expect(JSON.stringify(service)).not.toContain('synthetic-create-secret')
      await expect.poll(
        () => readFile(path.join(homeDir, 'synthetic-adapter.log'), 'utf8').catch(() => ''),
        { timeout: 30_000 },
      ).toContain('connected')
      for (const page of [first, second]) {
        await expect.poll(() => page.evaluate('document.body.innerText.includes("Created fixture")'), {
          timeout: 30_000,
        }).toBe(true)
        expect(
          await page.evaluate(
            '(document.body.textContent + JSON.stringify(localStorage) + JSON.stringify(sessionStorage))'
              + '.includes("synthetic-create-secret")',
          ),
        ).toBe(false)
        await page.evaluate('globalThis.__beforeChannelReload = true')
        await page.send('Page.reload')
        await expect.poll(
          () => page.evaluate('globalThis.__beforeChannelReload === undefined').catch(() => false),
          { timeout: 15_000 },
        ).toBe(true)
        await showChannel(page)
        await expect.poll(() => page.evaluate('document.body.innerText.includes("Created fixture")'), {
          timeout: 20_000,
        }).toBe(true)
      }
    } finally {
      const failures: unknown[] = []
      for (const page of pages) await page.close().catch(error => failures.push(error))
      if (browser) await stopChrome(browser).catch(error => failures.push(error))
      if (attemptedManager) await run('manager', 'stop').catch(error => failures.push(error))
      if (attemptedOwner) {
        await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(error => failures.push(error))
      }
      const transport = await readFile(path.join(homeDir, 'synthetic-adapter.log'), 'utf8').catch(() => '')
      if (transport.includes('connected\n') && !transport.includes('disconnected\n')) {
        failures.push(new Error('Synthetic transport did not disconnect'))
      }
      // A failed stop keeps the private fixture for diagnosis instead of deleting live state.
      if (failures.length) throw new AggregateError(failures, 'Channel fixture cleanup was not confirmed')
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
