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
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'
import { localPackage } from './suites/plugin-lifecycle.fixtures.js'

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

const fixture = [
  "export const inject = ['pages', 'routes', 'slots', 'i18n', 'managedServices', 'startup']",
  'export async function apply(ctx) {',
  '  const fetch = globalThis.fetch.bind(globalThis)',
  '  const transport = globalThis.__fixtureTransport = []',
  '  globalThis.fetch = (url, options) => {',
  '    let operation',
  "    if (url === '/api/renderer/binding' && typeof options?.body === 'string') {",
  '      const payload = JSON.parse(JSON.parse(options.body).payload)',
  "      operation = typeof payload.operation === 'object' ? payload.operation.kind : payload.operation",
  "      transport.push({ operation, status: 'started' })",
  '    }',
  '    return fetch(url, options).then(async response => {',
  '      const error = !response.ok ? (await response.clone().json().catch(() => ({}))).error : undefined',
  '      if (operation) transport.push({ operation, status: response.status, ...(error ? { error } : {}) })',
  '      return response',
  '    })',
  '  }',
  "  ctx.i18n.define({ namespace: 'managed-fixture', locale: 'en', default: true,",
  "    messages: { title: 'Managed fixture', description: 'Managed backend status' } })",
  "  const title = { namespace: 'managed-fixture', key: 'title', fallback: 'Managed fixture' }",
  "  const description = { namespace: 'managed-fixture', key: 'description', fallback: 'Managed backend status' }",
  '  ctx.pages.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v4.schema.json',",
  "    schemaVersion: 4, id: 'manager', title, description, icon: 'host:layers', chrome: 'standard'",
  '  }, context => {',
  "    const body = context.document.createElement('p')",
  "    body.dataset.managedFixture = 'true'",
  "    body.textContent = 'Managed backend page'",
  '    context.container.append(body)',
  '    return () => body.remove()',
  '  })',
  '  ctx.routes.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json',",
  "    schemaVersion: 2, id: 'manager', path: '/manager/extensions/managed-fixture',",
  "    outlet: 'manager.content', page: 'manager', title, description",
  '  })',
  '  ctx.slots.register({',
  "    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v11.schema.json',",
  "    schemaVersion: 11, name: 'manager.settings.navigation-items', id: 'manager', group: 'after-settings', order: 170",
  "  }, { route: { id: 'manager' }, navigationGroup: { id: 'external-accounts' } })",
  "  const result = await ctx.managedServices.get({ serviceId: 'gateway' })",
  '  globalThis.__fixtureManagedStatus = result.status',
  "  if (result.status === 'available') {",
  '    globalThis.__fixtureManagedService = result.service',
  '    globalThis.__fixtureManagedEvents = []',
  '    globalThis.__fixtureManagedSnapshot = (await result.service.snapshot()).status',
  '    const observed = await result.service.subscribe()',
  '    globalThis.__fixtureServiceStatus = observed.status',
  "    if (observed.status === 'subscribed') {",
  '      globalThis.__fixtureServiceSubscription = observed.subscription',
  '      globalThis.__fixtureServicePublicId = observed.subscription.descriptor.subscriptionId',
  '      void (async () => {',
  '        for await (const page of observed.subscription.pages) {',
  "          globalThis.__fixtureServicePage = 'page'",
  '          for (const update of page.updates) {',
  "            const auth = update.kind === 'snapshot-replaced' ? update.projection.auth : update.delta.auth",
  '            if (auth) globalThis.__fixtureManagedEvents.push(auth.state)',
  '          }',
  '        }',
  "      })().catch(() => { globalThis.__fixtureServicePage = 'error' })",
  '    }',
  '  }',
  '  globalThis.__fixtureStartup = ctx.startup',
  '  globalThis.__fixtureStartupSnapshot = await ctx.startup.read()',
  '  globalThis.__fixtureStartupEvents = []',
  '  globalThis.__fixtureStartupSubscription = await ctx.startup.subscribe(event =>',
  '    globalThis.__fixtureStartupEvents.push(event.kind))',
  '  globalThis.__fixtureStartupSubscribed = true',
  '}',
].join('\n')

it.skipIf(
  !archive || !managerPackage || !chrome || !codex || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'opens a managed plugin and configured Channel in two real Manager pages and recovers after owner loss',
  async () => {
    const root = await mkdtemp('/tmp/cx-managed-ui-browser-')
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
    const ready = async (page: CdpClient) => {
      await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 60_000 })
        .toBe('true')
      await expect.poll(() => page.evaluate('globalThis.__fixtureManagedSnapshot'), { timeout: 20_000 })
        .toBe('available')
      await expect.poll(() => page.evaluate('globalThis.__fixtureServiceStatus'), { timeout: 20_000 })
        .toBe('subscribed')
      await expect.poll(() => page.evaluate('globalThis.__fixtureServicePage'), { timeout: 20_000 })
        .toBe('page')
      await expect.poll(() =>
        page.evaluate(
          'globalThis.__fixtureTransport.filter(item => item.operation === "next" && item.status === "started").length >= 2',
        ), { timeout: 20_000 }).toBe(true)
      try {
        await expect.poll(() => page.evaluate('globalThis.__fixtureStartupSubscribed'), { timeout: 20_000 })
          .toBe(true)
      } catch (cause) {
        const state = await page.evaluate<unknown>(
          '({ service: globalThis.__fixtureServiceStatus, page: globalThis.__fixtureServicePage,'
            + ' startup: !!globalThis.__fixtureStartup, startupSnapshot: !!globalThis.__fixtureStartupSnapshot,'
            + ' transport: globalThis.__fixtureTransport?.slice(-30),'
            + ' plugins: globalThis.__cordisxRuntime?.snapshot().plugins.map(({ id, status }) => ({ id, status })) })',
        )
        throw new Error('Fixture startup observation did not become ready: ' + JSON.stringify(state), { cause })
      }
      await expect.poll(() =>
        page.evaluate('globalThis.__fixtureTransport.some(item => item.operation === "startupNext")')
      ).toBe(true)
      expect(await page.evaluate('globalThis.__fixtureStartupSnapshot.contract'))
        .toBe('cordisx.startup-snapshot/v1')
      expect(await page.evaluate('globalThis.__fixtureStartupEvents.includes("snapshot")')).toBe(true)
      await expect.poll(() =>
        page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))')
      )
        .toBe(true)
      await expect.poll(() =>
        page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=fixture-service]"))')
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
      await stageServiceModePlugin(root, homeDir, 'default', true, 'https://example.test/fixtures', fixture, {
        version: 15,
        uiPoints: ['manager.content', 'manager.settings.navigation-items'],
        authentication: true,
      })
      const channel = (await loadConfig(configPath, { profileId: 'default', projectRoot: homeDir })).plugins[0]!
      const policies = [
        { id: 'channel', entry: channel.entry, source: channel.source! },
        { id: 'fixture-service', entry: '/fixture/entry.js', source: 'https://example.test/fixtures' },
      ].flatMap(plugin =>
        exactDomPermissionPolicies('default', [{
          id: plugin.id,
          entry: plugin.entry,
          pointIds: ['manager.settings.navigation-items', 'manager.content'],
        }]).map(policy => ({
          ...policy,
          key: { ...policy.key, identity: { ...policy.key.identity, source: plugin.source } },
        }))
      )
      await persistPermissionPolicies({ configPath }, policies)
      await symlink(managerPackage!, path.join(root, 'package'), 'dir')
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      const launched = launchChrome(chrome!, browserProfile)
      browser = launched.browser
      const first = await CdpClient.connect(await waitForChromeTarget(browserProfile, browser, launched.stderr))
      pages.push(first)
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: await open() })
      await ready(first)
      const port = Number((await readFile(path.join(browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
      const debugOrigin = 'http://127.0.0.1:' + port
      const newPage = async () => {
        const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(await open()), { method: 'PUT' })
        const target = await response.json() as { webSocketDebuggerUrl: string }
        const page = await CdpClient.connect(target.webSocketDebuggerUrl)
        pages.push(page)
        await page.send('Runtime.enable')
        await page.send('Page.enable')
        await ready(page)
        return page
      }
      const second = await newPage()
      const firstServiceId = await first.evaluate<string>('globalThis.__fixtureServicePublicId')
      const secondServiceId = await second.evaluate<string>('globalThis.__fixtureServicePublicId')
      expect(firstServiceId !== secondServiceId).toBe(true)
      const alias = async (page: CdpClient) =>
        await page.evaluate<string>(
          'globalThis.__cordisxRuntime.activePluginGeneration().plugins[0].canonicalSource',
        )
      expect(await alias(first)).toMatch(/^https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}$/u)
      expect(await alias(first)).not.toBe(await alias(second))
      const managementState = async (page: CdpClient) =>
        await page.evaluate<{ source: string; operations: unknown[] }>([
          '(async () => {',
          "  const id = 'fixture-query-' + crypto.randomUUID()",
          '  const old = window.__cordisxPluginManagementReceiveV1',
          '  return await new Promise((resolve, reject) => {',
          '    const timer = setTimeout(() => { window.__cordisxPluginManagementReceiveV1 = old; reject(new Error("timeout")) }, 5000)',
          '    window.__cordisxPluginManagementReceiveV1 = raw => {',
          '      const response = JSON.parse(raw)',
          '      if (response.requestId !== id) return old?.(raw)',
          '      clearTimeout(timer); window.__cordisxPluginManagementReceiveV1 = old',
          "      const item = response.value?.plugins.find(value => value.id === 'fixture-service')",
          '      if (!response.ok || !item) return reject(new Error("management unavailable: " + JSON.stringify({',
          '        code: response.code, error: response.error, transport: globalThis.__fixtureTransport.slice(-20),',
          '        events: globalThis.__fixtureStartupEvents.slice(-20)',
          '      })))',
          '      resolve({ source: item.canonicalSource, operations: item.availableOperations })',
          '    }',
          '    window.__cordisxPluginManagementRequestV1(JSON.stringify({ version: 1, requestId: id,',
          "      token: 'renderer-binding-placeholder', profileId: 'default', operation: { kind: 'query' } }))",
          '  })',
          '})()',
        ].join('\n'))
      for (const page of [first, second]) {
        expect(await managementState(page)).toEqual({ source: await alias(page), operations: [] })
      }
      const refusal = await first.evaluate<{ ok: boolean; error: string }>([
        '(async () => {',
        "  const id = 'fixture-plan-' + crypto.randomUUID()",
        '  const old = window.__cordisxPluginManagementReceiveV1',
        '  return await new Promise((resolve, reject) => {',
        '    const timer = setTimeout(() => { window.__cordisxPluginManagementReceiveV1 = old; reject(new Error("timeout")) }, 5000)',
        '    window.__cordisxPluginManagementReceiveV1 = raw => {',
        '      const response = JSON.parse(raw)',
        '      if (response.requestId !== id) return old?.(raw)',
        '      clearTimeout(timer); window.__cordisxPluginManagementReceiveV1 = old',
        '      resolve({ ok: response.ok, error: response.error })',
        '    }',
        '    window.__cordisxPluginManagementRequestV1(JSON.stringify({ version: 1, requestId: id,',
        "      token: 'renderer-binding-placeholder', profileId: 'default', operation: {",
        "        kind: 'plan', request: { kind: 'plugin-disable', pluginId: 'fixture-service' } } }))",
        '  })',
        '})()',
      ].join('\n'))
      expect(refusal).toMatchObject({ ok: false, error: expect.stringContaining('read-only') })
      expect(await managementState(first)).toEqual({ source: await alias(first), operations: [] })
      for (const page of [first, second]) {
        await page.evaluate(`(() => {
          const forward = window.fetch.bind(window)
          const trace = globalThis.__fixtureLifecycleTrace = []
          window.fetch = (url, options) => {
            const route = typeof url === 'string' ? url : ''
            if (route === '/api/renderer/acknowledge') {
              const receipt = JSON.parse(options.body).receipt
              trace.push({ action: 'acknowledge', ok: receipt.ok })
            }
            return forward(url, options).then(response => {
              if (route === '/api/renderer/poll') {
                if (!response.ok) trace.push({ action: 'poll', status: response.status })
                else void response.clone().json().then(value => {
                  if (value.command) trace.push({ action: 'command', method: value.command.method })
                }).catch(() => {})
              }
              if (route === '/api/renderer/acknowledge') trace.push({ action: 'response', status: response.status })
              return response
            })
          }
        })()`)
      }
      // Both pages hold real startup and service observations. An unrelated
      // package change must finish without losing those existing projections.
      const sourceDirectory = await localPackage({
        root,
        id: 'lifecycle-fixture',
        code: 'export function apply() { globalThis.__lifecycleFixtureReady = true }',
      })
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = await readPluginManagementRpcEndpoint(rpcPaths)
      if (!endpoint) throw new Error('isolated management endpoint is unavailable')
      const plan = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'plan',
        request: { kind: 'plugin-plan-local', sourceDirectory },
      }) as any
      expect(plan.status).toBe('planned')
      const applied = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'execute',
        request: plan.executionRequest,
        expectedRevision: plan.snapshot.revision,
      }).catch(async cause => {
        const details = await Promise.all(
          [first, second].map(async page =>
            await page.evaluate(
              `({ trace: globalThis.__fixtureLifecycleTrace, failure: globalThis.__fixtureLifecycleFailure })`,
            )
              .catch(() => ({ trace: [], failure: 'page-unavailable' }))
          ),
        )
        throw new Error('Isolated lifecycle failed: ' + JSON.stringify(details), { cause })
      }) as any
      expect(applied.status).toBe('applied')
      for (const page of [first, second]) {
        await expect.poll(() => page.evaluate('globalThis.__lifecycleFixtureReady === true'), { timeout: 20_000 })
          .toBe(true)
        expect(await managementState(page)).toEqual({ source: await alias(page), operations: [] })
        expect(await page.evaluate('globalThis.__fixtureManagedService.snapshot().then(value => value.status)'))
          .toBe('available')
      }
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=fixture-service]").click()')
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-managed-fixture]"))')).toBe(true)
      await first.send('Page.reload')
      await ready(first)
      await expect.poll(() => first.evaluate('Boolean(document.querySelector("[data-managed-fixture]"))')).toBe(true)
      const channelForm = async (page: CdpClient) => {
        await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
        await expect.poll(
          () => page.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'),
          { timeout: 15_000 },
        )
          .toBe(true)
        await expect.poll(() =>
          page.evaluate([
            '(() => {',
            "  const row = [...document.querySelectorAll('[data-manager-collection-item]')].find(item =>",
            "    item.textContent.includes('Simulator') || item.textContent.includes('模拟器'))",
            "  const button = row?.querySelector('.cxr-manager-collection-open')",
            '  if (!button) return false',
            '  button.click(); return true',
            '})()',
          ].join('\n')), { timeout: 15_000 }).toBe(true)
        await expect.poll(
          () => page.evaluate('Boolean(document.querySelector("#channel-connection-displayName input"))'),
          { timeout: 15_000 },
        )
          .toBe(true)
      }
      await channelForm(first)
      await channelForm(second)
      const login = await first.evaluate<{ status: string; stateAt?: string }>(`(async () => {
        const service = globalThis.__fixtureManagedService;
        const snapshot = await service.snapshot();
        return await service.authenticate({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
          contract: 'cordisx.managed-service-login-request/v1', schemaVersion: 1, requestId: 'channel-login',
          binding: service.binding, action: 'login', expectedSequence: snapshot.projection.sequence,
          userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
        });
      })()`)
      expect(login).toMatchObject({ status: 'accepted', stateAt: 'authenticated' })
      await expect.poll(() => second.evaluate('globalThis.__fixtureManagedEvents.includes("authenticated")'), {
        timeout: 20_000,
      }).toBe(true)
      for (const page of [first, second]) {
        expect(
          await page.evaluate(
            'globalThis.__fixtureManagedService.snapshot().then(value => value.projection.auth.state)',
          ),
        ).toBe('authenticated')
      }
      const actions = await readFile(
        path.join(homeDir, 'managed-services', 'fixture-service', 'gateway', 'fixture-auth-actions'),
        'utf8',
      )
      expect(actions.split('\n').filter(value => value === 'login')).toHaveLength(1)
      const editName = async (page: CdpClient, value: string) =>
        await page.evaluate([
          '(() => {',
          "  const input = document.querySelector('#channel-connection-displayName input')",
          "  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, "
          + JSON.stringify(value) + ')',
          "  input.dispatchEvent(new Event('input', { bubbles: true }))",
          "  input.dispatchEvent(new Event('change', { bubbles: true }))",
          '})()',
        ].join('\n'))
      await editName(second, 'Other page draft')
      await editName(first, 'Managed fixture channel')
      await expect.poll(() =>
        first.evaluate([
          '(() => {',
          "  const button = [...document.querySelectorAll('[data-channel-connection-form] button')].find(item =>",
          "    ['Save', '保存'].includes(item.textContent.trim()))",
          '  if (!button || button.disabled) return false',
          '  button.click(); return true',
          '})()',
        ].join('\n'))
      ).toBe(true)
      await expect.poll(async () => {
        const config = JSON.parse(await readFile(configPath, 'utf8'))
        return config.plugins[0].services.runtime.profiles.default.revision
      }, { timeout: 30_000 }).toBe(2)
      await expect.poll(() =>
        second.evaluate(
          'document.body.textContent.includes("Your draft was kept") || document.body.textContent.includes("草稿已保留")',
        ), { timeout: 15_000 }).toBe(true)
      expect(await second.evaluate('document.querySelector("#channel-connection-displayName input").value'))
        .toBe('Other page draft')
      for (const label of [['Use latest version', '使用最新版本'], ['Undo changes', '撤销修改']]) {
        await expect.poll(() =>
          second.evaluate([
            '(() => {',
            "  const button = [...document.querySelectorAll('[data-channel-connection-form] button')].find(item =>",
            '    ' + JSON.stringify(label) + '.includes(item.textContent.trim()))',
            '  if (!button || button.disabled) return false',
            '  button.click(); return true',
            '})()',
          ].join('\n'))
        ).toBe(true)
      }
      await expect.poll(() => second.evaluate('document.querySelector("#channel-connection-displayName input").value'))
        .toBe('Managed fixture channel')
      for (const page of [first, second]) {
        expect(await page.evaluate('globalThis.__fixtureStartup.read().then(value => value.contract)'))
          .toBe('cordisx.startup-snapshot/v1')
      }
      expect(await managementState(first)).toEqual({ source: await alias(first), operations: [] })
      await run('stop', '--mode', 'service', 'codex', 'default', '--json')
      for (const page of [first, second]) {
        await expect.poll(() => page.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
          timeout: 30_000,
        }).toBe(true)
      }
      await expect.poll(async () => {
        try {
          return JSON.parse((await run('manager', 'status', '--profile', 'default')).stdout).status
        } catch {
          return 'stopping'
        }
      }, { timeout: 20_000, interval: 250 }).toBe('stopped')
      expect(JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout))
        .toMatchObject({ status: 'ready', mode: 'service' })
      await newPage()
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
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  240_000,
)
