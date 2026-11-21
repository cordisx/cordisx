import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

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
  'connects the configured Channel through the actual service-owner process and manager sidecar',
  async () => {
    const root = await mkdtemp('/tmp/cx-production-channel-')
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
        timeout: 35_000,
      })
    const pages: CdpClient[] = []
    let browser: ChildProcess | undefined
    const open = async () => {
      const url = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
      url.searchParams.set('host', '1')
      return url.href
    }
    const showChannel = async (page: CdpClient) => {
      try {
        await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
          .toBe('true')
      } catch {
        const state = await page.evaluate(`({
          text: document.body.innerText.slice(0, 300),
          path: location.pathname,
        })`)
        throw new Error(
          'Manager did not start: ' + JSON.stringify({
            state,
            diagnostics: page.diagnostics.map(item => (item as { method?: string }).method),
          }),
        )
      }
      try {
        await expect.poll(
          () => page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))'),
          { timeout: 15_000 },
        ).toBe(true)
      } catch {
        const text = await page.evaluate(`({
          visible: document.body.innerText.slice(0, 400),
          content: document.body.textContent.slice(0, 400),
          elements: document.body.querySelectorAll('*').length,
          roots: document.querySelectorAll('[data-manager-root], [data-cordisx-manager]').length,
        })`)
        const redact = (value: unknown) =>
          String(value ?? '')
            .replace(/(?:https?|file):\/\/[^\s)]+/gu, '[url]')
            .replace(/\/(?:[^\s/]+\/)+[^\s)]*/gu, '[path]')
            .replace(/[a-f0-9]{32,}/giu, '[id]')
            .slice(0, 300)
        const diagnostics = page.diagnostics.map(item => {
          const value = item as {
            method?: string
            params?: {
              type?: string
              args?: Array<{ value?: unknown; description?: string }>
              exceptionDetails?: { text?: string; exception?: { description?: string } }
            }
          }
          return {
            method: value.method,
            level: value.params?.type,
            exception: redact(value.params?.exceptionDetails?.exception?.description),
            messages: value.params?.args?.map(arg => redact(arg.value ?? arg.description)),
          }
        })
        throw new Error('Channel navigation did not register: ' + JSON.stringify({ text, diagnostics }))
      }
      await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() => page.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'))
        .toBe(true)
      await expect.poll(() =>
        page.evaluate(
          'document.body.textContent.includes("Simulator") || document.body.textContent.includes("模拟器")',
        )
      ).toBe(true)
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
                  default: { revision: 1, lastGoodRevision: 1, config: SIMULATOR_CHANNEL_SERVICE_CONFIG },
                },
              },
            },
          }],
        }),
        { mode: 0o600 },
      )
      const plugin = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins[0]!
      expect(plugin.source).toBeDefined()
      const policies = exactDomPermissionPolicies('default', [{
        id: 'channel',
        entry: plugin.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: plugin.source! } },
      }))
      await persistPermissionPolicies({ configPath }, policies)
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
      await first.send('Runtime.enable')
      await first.send('Network.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      await showChannel(first)

      const debugOrigin = 'http://' + new URL(socket).host
      const secondUrl = await open()
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(secondUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
      await showChannel(second)
      await first.evaluate('globalThis.__productionBeforeReload = true')
      await first.send('Page.reload')
      await expect.poll(
        async () => await first.evaluate('globalThis.__productionBeforeReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await showChannel(first)

      await expect(updateHomeConfigAtomic(current => ({ ...current, permissions: [] }), configPath))
        .rejects.toThrow('permission policy is in use')
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(item => ({ ...item, enabled: false })),
      }), configPath)).rejects.toThrow('plugin configuration is in use')

      await run('stop', '--mode', 'service', 'codex', 'default', '--json')
      for (const page of [first, second]) {
        await expect.poll(() => page.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
          timeout: 30_000,
        }).toBe(true)
      }
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const recoveredUrl = await open()
      const recoveredResponse = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(recoveredUrl), {
        method: 'PUT',
      })
      const recoveredTarget = await recoveredResponse.json() as { webSocketDebuggerUrl: string }
      const recovered = await CdpClient.connect(recoveredTarget.webSocketDebuggerUrl)
      pages.push(recovered)
      await showChannel(recovered)
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
