import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'
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

it.skipIf(chrome === undefined).each([false, true])(
  'runs two browser clients against one real managed-service owner (unprojected configuration: %s)',
  async unprojectedConfig => {
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
    let ownerAttempted = false
    try {
      await mkdir(home)
      await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
      await stageServiceModePlugin(root, home, 'default', true, 'https://example.test/fixtures', fixturePlugin)
      if (unprojectedConfig) {
        const configs = new PackagePluginConfigStore(home, 'default', 'offline-fixture')
        await configs.stage('fixture-service', 0, { token: 'fixture-private-managed-configuration' }, 'fixture')
        await configs.commit('fixture-service', 1, 'fixture')
      }
      ownerAttempted = true
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
      if (unprojectedConfig) {
        const ready = async (client: CdpClient) => {
          await expect.poll(() =>
            client.evaluate(`({
            ready: document.documentElement.dataset.cordisxManagerReady === 'true',
            status: globalThis.__cordisxRuntime?.snapshot?.().plugins?.find(p => p.id === 'fixture-service')?.status,
          })`), { timeout: 45_000 }).toEqual({ ready: true, status: 'failed' })
          expect(await client.evaluate('Boolean(document.querySelector("[data-tab=plugins]"))')).toBe(true)
          expect(await client.evaluate('globalThis.__fixtureManagedStatus')).toBeUndefined()
          expect(
            await client.evaluate('JSON.stringify(globalThis.__cordisxRuntime.snapshot()) + document.body.textContent'),
          )
            .not.toContain('fixture-private-managed-configuration')
        }
        await ready(first)
        const debugOrigin = `http://${new URL(socket).host}`
        const response = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(await link())}`, { method: 'PUT' })
        const tab = await response.json() as { webSocketDebuggerUrl: string }
        const second = await CdpClient.connect(tab.webSocketDebuggerUrl)
        clients.push(second)
        await ready(second)
        const before = await first.evaluate('performance.timeOrigin')
        await first.send('Page.reload')
        await expect.poll(() => first.evaluate('performance.timeOrigin'), { timeout: 15_000 }).not.toBe(before)
        await ready(first)
        await ready(second)
        const paths = pluginManagementRpcPaths(home, 'codex', 'default')
        const endpoint = (await readPluginManagementRpcEndpoint(paths))!
        const terminalLeases = await Promise.all(
          [undefined, 'claude-code' as const].map(async client =>
            await requestPluginManagementRpc(paths, endpoint, {
              kind: 'terminal-provider',
              request: {
                kind: 'prepare',
                providerId: 'fixture-provider',
                model: 'fixture-model',
                ...(client === undefined ? {} : { client }),
              },
            }) as { kind: string; leaseId: string }
          ),
        )
        expect(terminalLeases.map(lease => lease.kind)).toEqual(['prepared', 'prepared'])
        const sourceDirectory = await localPackage({ root, id: 'healthy-browser-plugin' })
        const execute = async (request: Record<string, unknown>) => {
          const planned = await requestPluginManagementRpc(paths, endpoint, { kind: 'plan', request } as never) as any
          expect(planned.status).toBe('planned')
          const result = await requestPluginManagementRpc(paths, endpoint, {
            kind: 'execute',
            request: planned.executionRequest,
            expectedRevision: planned.snapshot.revision,
          }) as any
          expect(result.status).toBe('applied')
        }
        const checkEnabled = async (enabled: boolean) => {
          await expect.poll(
            async () =>
              await Promise.all(
                [first, second].map(async page =>
                  await page.evaluate(`globalThis.__cordisxRuntime.activePluginGeneration().plugins
              .find(plugin => plugin.id === 'healthy-browser-plugin')?.enabled`)
                ),
              ),
            { timeout: 20_000 },
          ).toEqual([enabled, enabled])
          await ready(first)
          await ready(second)
        }
        await execute({ kind: 'plugin-plan-local', sourceDirectory })
        await checkEnabled(true)
        await execute({ kind: 'plugin-disable', pluginId: 'healthy-browser-plugin' })
        await checkEnabled(false)
        await execute({ kind: 'plugin-enable', pluginId: 'healthy-browser-plugin' })
        await checkEnabled(true)
        for (const lease of terminalLeases) {
          expect(
            await requestPluginManagementRpc(paths, endpoint, {
              kind: 'terminal-provider',
              request: { kind: 'renew', leaseId: lease.leaseId },
            }),
          ).toEqual({ kind: 'renewed' })
          await requestPluginManagementRpc(paths, endpoint, {
            kind: 'terminal-provider',
            request: { kind: 'release', leaseId: lease.leaseId },
          })
        }
        expect(JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout).pid)
          .toBe(started.pid)
        return
      }
      const waitForSnapshot = async (client: CdpClient, label: string) => {
        try {
          await expect.poll(() => client.evaluate('globalThis.__fixtureManagedSnapshot'), { timeout: 45_000 })
            .toBe('available')
        } catch (cause) {
          const state = await client.evaluate(`({
            path: location.pathname + location.search,
            ready: document.documentElement.dataset.cordisxReady ?? null,
            status: document.querySelector('p[role=status]')?.textContent ?? null,
            managerReady: document.documentElement.dataset.cordisxManagerReady ?? null,
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
      const failures: unknown[] = []
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }
      for (const client of clients) await cleanup(async () => await client.close())
      await cleanup(async () => {
        if (browser) await stopChrome(browser)
      })
      await cleanup(async () => {
        if (ownerAttempted) {
          expect(JSON.parse((await run('stop', '--mode', 'service', 'codex', 'default', '--json')).stdout).status)
            .toBe('stopped')
        }
      })
      if (failures.length === 0) {
        await cleanup(async () => {
          await makeRemovable(home)
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        })
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          `fixture process cleanup was not confirmed: ${failures.map(String).join('; ')}`,
        )
      }
    }
  },
  150_000,
)
