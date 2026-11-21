import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { managerChildEnvironment } from '../packages/cli/src/cli/manager-supervisor.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { localPackage } from './suites/plugin-lifecycle.fixtures.js'

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

it.skipIf(chrome === undefined)(
  'synchronizes two real standalone browser pages with the packaged service owner',
  async () => {
    const root = await mkdtemp('/tmp/cx-manager-real-browser-')
    const homeDir = path.join(root, 'home')
    const profile = path.join(root, 'chrome-profile')
    const env = managerChildEnvironment(process.env, 'unused')
    delete env.CORDISX_MANAGER_CHILD_KEY
    Object.assign(env, {
      HOME: root,
      CODEX_HOME: path.join(root, 'codex'),
      CORDISX_HOME: homeDir,
      CORDISX_MODEL_API_PORT: '0',
    })
    await mkdir(homeDir)
    await writeFile(path.join(homeDir, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    let cli: string | undefined
    let browser: ChildProcess | undefined
    let first: CdpClient | undefined
    let second: CdpClient | undefined
    let third: CdpClient | undefined
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli!, ...args], { env, cwd: root, timeout: 30_000 })
    try {
      const packed = await exec('npm', [
        'pack',
        '--workspace',
        'cordisx',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        root,
        '--cache',
        path.join(root, 'npm-cache'),
      ], { env, cwd: process.cwd(), timeout: 30_000 })
      const name = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename
      expect(name).toBe(path.basename(name))
      await exec('tar', ['-xzf', path.join(root, name), '-C', root], { env, timeout: 30_000 })
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      const modules = path.join(root, 'package', 'node_modules')
      await mkdir(modules, { recursive: true })
      for (const name of ['@vitejs', 'vite']) {
        await symlink(
          path.resolve('packages/cli/node_modules', name),
          path.join(modules, name),
          'dir',
        )
      }
      cli = path.join(root, 'package', 'dist', 'src', 'cli.js')
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const open = async () => {
        const link = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
        link.searchParams.set('host', '1')
        return link.href
      }
      const firstUrl = await open()
      const secondUrl = await open()
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      first = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: firstUrl })
      const ready = async (page: CdpClient) =>
        await vi.waitFor(async () => {
          const state = await page.evaluate<{ ready: boolean; status: string }>(`({
        ready: document.documentElement.dataset.cordisxReady === 'true' && !!globalThis.__cordisxRuntime
          && document.querySelector('p[role=status]')?.hidden === true,
        status: document.querySelector('p[role=status]')?.textContent ?? ''
      })`)
          expect(state.ready, state.status).toBe(true)
        }, { timeout: 45_000 })
      await ready(first)
      const firstTarget = await first.send('Target.getTargetInfo') as { targetInfo: { targetId: string } }
      const created = await first.send('Target.createTarget', { url: secondUrl }) as { targetId: string }
      const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
      const socketFor = async (targetId: string): Promise<string> => {
        let socket = ''
        await vi.waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`)
          const targets = await response.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>
          socket = targets.find(item => item.id === targetId)?.webSocketDebuggerUrl ?? ''
          expect(socket).not.toBe('')
        }, { timeout: 10_000 })
        return socket
      }
      second = await CdpClient.connect(await socketFor(created.targetId))
      await second.send('Runtime.enable')
      await ready(second)
      const snapshot = async (page: CdpClient) =>
        await page.evaluate<{ active: any; epoch: number }>(`({
      active: globalThis.__cordisxRuntime.activePluginGeneration(),
      epoch: globalThis.__cordisxRuntime.pluginRegistryEpoch()
    })`)
      expect(await snapshot(first)).toEqual(await snapshot(second))
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      const install = async (id: string, dependencies: readonly { id: string; version: string }[] = []) => {
        const sourceDirectory = await localPackage({
          root,
          id,
          dependencies,
          code: `export function apply() { globalThis.__${id.replaceAll('-', '_')} = true }`,
        })
        const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'plan',
          request: { kind: 'plugin-plan-local', sourceDirectory },
        }) as any
        expect(planned.status).toBe('planned')
        const result = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'execute',
          request: planned.executionRequest,
          expectedRevision: planned.snapshot.revision,
        }).catch(error => {
          throw new Error(`install ${id}: ${String(error)}`)
        }) as any
        expect(result.status, JSON.stringify(result.error ?? result.lifecycle?.error ?? {})).toBe('applied')
      }
      await install('first-browser-plugin')
      await vi.waitFor(async () => {
        expect((await snapshot(first!)).active.plugins).toMatchObject([{ id: 'first-browser-plugin', enabled: true }])
        expect(await snapshot(first!)).toEqual(await snapshot(second!))
        expect(await first!.evaluate('globalThis.__first_browser_plugin === true')).toBe(true)
        expect(await second!.evaluate('globalThis.__first_browser_plugin === true')).toBe(true)
      }, { timeout: 20_000 })
      await install('dependent-browser-plugin', [{ id: 'first-browser-plugin', version: '1.0.0' }])
      const change = async (kind: 'plugin-disable' | 'plugin-enable', pluginId: string) => {
        const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'plan',
          request: { kind, pluginId },
        }) as any
        expect(planned.status).toBe('planned')
        const result = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'execute',
          request: planned.executionRequest,
          expectedRevision: planned.snapshot.revision,
        }).catch(error => {
          throw new Error(`${kind} ${pluginId}: ${String(error)}`)
        }) as any
        expect(result.status, JSON.stringify(result.error ?? result.lifecycle?.error ?? {})).toBe('applied')
      }
      // The owner and renderer may enumerate this dependency closure in
      // opposite order. Both real pages must still confirm the same members.
      await change('plugin-disable', 'first-browser-plugin')
      for (const page of [first, second]) {
        expect((await snapshot(page)).active.plugins.map((item: { enabled: boolean }) => item.enabled))
          .toEqual([false, false])
      }
      await change('plugin-enable', 'first-browser-plugin')
      await change('plugin-enable', 'dependent-browser-plugin')
      // pagehide sends a keepalive revoke asynchronously. Wait for its owner
      // receipt before starting the next unrelated package transaction. A
      // disconnect during a transaction remains a separate fail-closed case.
      const retire = async (page: CdpClient) => {
        const status = await page.evaluate<number>(`(async () => {
          const original = window.fetch.bind(window)
          let finish
          const receipt = new Promise(resolve => { finish = resolve })
          window.fetch = (...args) => {
            const result = original(...args)
            if (args[0] === '/api/renderer/close') result.then(value => finish(value.status), () => finish(0))
            return result
          }
          window.dispatchEvent(new Event('pagehide'))
          return await receipt
        })()`)
        expect(status).toBe(200)
      }
      await retire(first)
      await second.send('Target.closeTarget', { targetId: firstTarget.targetInfo.targetId })
      await first.close().catch(() => undefined)
      first = undefined
      await install('second-browser-plugin')
      await vi.waitFor(async () => {
        expect((await snapshot(second!)).active.plugins.map((item: { id: string }) => item.id).sort())
          .toEqual(['dependent-browser-plugin', 'first-browser-plugin', 'second-browser-plugin'])
      }, { timeout: 20_000 })
      // Keep one unrelated blank target alive while both Manager seats close.
      const spare = await second.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
      await retire(second)
      await second.send('Target.closeTarget', { targetId: created.targetId }).catch(() => undefined)
      await second.close().catch(() => undefined)
      second = undefined
      // Wait for pagehide/peer disconnect before checking the zero-renderer path.
      await vi.waitFor(async () => {
        const planned = await requestPluginManagementRpc(rpcPaths, endpoint, { kind: 'query' }) as any
        expect(planned.activationRevision).toBe(6)
      }, { timeout: 10_000 })
      await install('headless-after-browser')
      const final = await requestPluginManagementRpc(rpcPaths, endpoint, { kind: 'query' }) as any
      expect(final.activationRevision).toBe(7)
      // A new renderer must cold-boot all currently active package graphs,
      // not just packages installed after it joins.
      third = await CdpClient.connect(await socketFor(spare.targetId))
      await third.send('Runtime.enable')
      await third.send('Page.enable')
      await third.send('Page.navigate', { url: await open() })
      await ready(third)
      expect((await snapshot(third)).active.plugins.map((item: { id: string }) => item.id).sort())
        .toEqual([
          'dependent-browser-plugin',
          'first-browser-plugin',
          'headless-after-browser',
          'second-browser-plugin',
        ])
      for (
        const marker of [
          'dependent_browser_plugin',
          'first_browser_plugin',
          'second_browser_plugin',
          'headless_after_browser',
        ]
      ) {
        expect(await third.evaluate(`globalThis.__${marker} === true`)).toBe(true)
      }
    } finally {
      await first?.close().catch(() => undefined)
      await second?.close().catch(() => undefined)
      await third?.close().catch(() => undefined)
      if (browser) await stopChrome(browser)
      if (cli) {
        await run('manager', 'stop').catch(() => undefined)
        await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
      }
      const makeRemovable = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700)
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isDirectory()) {
            await makeRemovable(path.join(directory, item.name))
          }
        }
      }
      await makeRemovable(root)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  180_000,
)
