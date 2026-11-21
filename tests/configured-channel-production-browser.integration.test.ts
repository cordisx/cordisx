import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
      FIXTURE_CHANNEL_KEY: 'synthetic-fixture-value',
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
          providers: [{
            id: 'fixture-service',
            kind: 'model-service',
            displayName: 'Fixture Models',
            baseUrl: 'https://example.test',
            apiKeyEnv: 'FIXTURE_MODEL_KEY',
            protocols: ['openai-responses'],
            models: { codex: ['fixture-model'] },
          }],
          environmentVariables: [{ name: 'FIXTURE_MODEL_KEY', value: 'fixture-model-secret', enabled: true }],
          plugins: [{
            id: 'channel',
            entry: archive,
            services: {
              runtime: {
                profiles: {
                  default: {
                    revision: 1,
                    lastGoodRevision: 1,
                    config: {
                      ...SIMULATOR_CHANNEL_SERVICE_CONFIG,
                      connections: [
                        ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
                        {
                          ref: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture-tenant' },
                          adapterKind: 'feishu',
                          enabled: false,
                          transport: { mode: 'websocket' },
                          secretRef: 'host-secret:env/FIXTURE_CHANNEL_KEY',
                        },
                      ],
                    },
                  },
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
      expect(await first.evaluate('typeof globalThis.__cordisxChannelCredentialRequestV1')).toBe('function')
      const openRow = (labels: string[]) =>
        `(() => {
        const row = [...document.querySelectorAll('[data-manager-collection-item]')].find(item =>
          ${JSON.stringify(labels)}.some(label => item.textContent.includes(label)))
        const button = row?.querySelector('.cxr-manager-collection-open')
        if (!button) return false
        button.click()
        return true
      })()`
      await expect.poll(() => first.evaluate(openRow(['Feishu', '飞书', 'cli_fixture']))).toBe(true)
      await expect.poll(() =>
        first.evaluate(
          'Boolean(document.querySelector("#channel-credential-secret input"))',
        ), { timeout: 15_000 }).toBe(true)
      expect(await first.evaluate('document.querySelector("#channel-credential-secret input").value')).toBe('')
      expect(await first.evaluate('document.body.textContent.includes("FIXTURE_CHANNEL_KEY")')).toBe(false)
      await showChannel(first)

      await expect.poll(() => first.evaluate(openRow(['Simulator', '模拟器']))).toBe(true)
      try {
        await expect.poll(
          () => first.evaluate('Boolean(document.querySelector("#channel-connection-displayName input"))'),
          { timeout: 15_000 },
        ).toBe(true)
      } catch {
        const state = await first.evaluate(`({
          text: document.body.innerText.slice(0, 600),
          tabs: [...document.querySelectorAll('[data-manager-content-tab]')].map(item => item.getAttribute('data-manager-content-tab')),
          formError: document.querySelector('[data-channel-form-error]')?.getAttribute('data-channel-form-error'),
        })`)
        const descriptor = await first.evaluate(`(async () => {
          try {
            const value = await globalThis.__cordisxRuntime.listServiceConfigs('channel')
            return { count: value.length, writable: value[0]?.writable, revision: value[0]?.revision }
          } catch {
            return { unavailable: true }
          }
        })()`)
        throw new Error('Connection form did not mount: ' + JSON.stringify({ state, descriptor }))
      }
      expect(
        await first.evaluate(`(() => ({
        inlineStyle: Boolean(document.querySelector('[data-channel-connection-form] style')),
        grid: getComputedStyle(document.querySelector('[data-channel-connection-form] .cxf-form-grid')).display,
        credential: Boolean(document.querySelector('#channel-credential-secret input'))
      }))()`),
      ).toEqual({ inlineStyle: false, grid: 'grid', credential: false })
      await first.evaluate(`(() => {
        const input = document.querySelector('#channel-connection-displayName input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Configured Simulator')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await expect.poll(() =>
        first.evaluate(`(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })()`)
      ).toBe(true)
      const save = `(() => {
        const button = [...document.querySelectorAll('[data-channel-connection-form] button')].find(item =>
          ['Save', '保存'].includes(item.textContent.trim()))
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`
      await expect.poll(() => first.evaluate(save)).toBe(true)
      await expect.poll(() =>
        first.evaluate(
          'document.body.textContent.includes("Your draft was kept") || document.body.textContent.includes("草稿已保留")',
        ), { timeout: 15_000 }).toBe(true)
      expect(await first.evaluate('document.querySelector("#channel-connection-displayName input").value'))
        .toBe('Configured Simulator')
      const serviceRevision = async () => {
        const current = JSON.parse(await readFile(configPath, 'utf8'))
        return current.plugins[0].services.runtime.profiles.default.revision as number
      }
      expect(await serviceRevision()).toBe(1)
      await second.send('Page.enable')
      await second.send('Page.navigate', { url: 'about:blank' })
      await expect.poll(() => second.evaluate('location.href')).toBe('about:blank')
      try {
        await expect.poll(async () => {
          if (await serviceRevision() === 2) return true
          await first.evaluate(save).catch(() => false)
          return false
        }, { timeout: 30_000, interval: 500 }).toBe(true)
      } catch {
        const state = await first.evaluate(`({
          text: document.body.innerText.slice(0, 600),
          input: document.querySelector('#channel-connection-displayName input')?.value,
          buttons: [...document.querySelectorAll('[data-channel-connection-form] button')].map(item => ({
            label: item.textContent.trim(), disabled: item.disabled,
          })),
        })`)
        throw new Error(
          'Connection form did not save after retirement: '
            + JSON.stringify({ state, revision: await serviceRevision() }),
        )
      }
      const savedConfig = JSON.parse(await readFile(configPath, 'utf8'))
        .plugins[0].services.runtime.profiles.default.config
      expect(savedConfig).toMatchObject({
        contract: 'cordisx.channel-service-config/v2',
        schemaVersion: 2,
        connections: [
          { displayName: 'Configured Simulator' },
          { ref: { accountId: 'cli_fixture' }, secretRef: 'host-secret:env/FIXTURE_CHANNEL_KEY' },
        ],
      })
      await expect.poll(() =>
        first.evaluate(
          'document.body.textContent.includes("Operation completed") || document.body.textContent.includes("操作已完成")',
        ), { timeout: 15_000 }).toBe(true)
      await expect.poll(() =>
        first.evaluate(
          'document.querySelector("#channel-connection-displayName input")?.value',
        )
      ).toBe('Configured Simulator')
      const replacementUrl = await open()
      await second.send('Page.navigate', { url: replacementUrl })
      await showChannel(second)
      await showChannel(first)
      await first.evaluate('globalThis.__productionBeforeReload = true')
      await first.send('Page.reload')
      await expect.poll(
        async () => await first.evaluate('globalThis.__productionBeforeReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await expect.poll(
        () =>
          first.evaluate(
            'Boolean(document.querySelector("[data-manager-collection-item]")) && (document.body.textContent.includes("Simulator") || document.body.textContent.includes("模拟器"))',
          ),
        { timeout: 30_000 },
      ).toBe(true)
      await expect.poll(() => first.evaluate(openRow(['Simulator', '模拟器']))).toBe(true)
      await expect.poll(() =>
        first.evaluate(
          'document.querySelector("#channel-connection-displayName input")?.value',
        ), { timeout: 15_000 }).toBe('Configured Simulator')
      await expect.poll(() =>
        first.evaluate(`(() => {
        const shell = document.querySelector('[data-channel-manager]');
        return shell ? {
          display: getComputedStyle(shell).display,
          blockedInlineStyles: [...shell.children].filter(element => element.tagName === 'STYLE' && !element.sheet).length,
        } : undefined;
      })()`), { timeout: 15_000 }).toEqual({ display: 'flex', blockedInlineStyles: 0 })

      await first.evaluate('document.querySelector("[data-tab=model-services]").click()')
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-service]"))'),
        { timeout: 15_000 },
      ).toBe(true)
      await expect.poll(
        () => first.evaluate('getComputedStyle(document.querySelector(".cxms-shared-header")).display'),
      ).toBe('flex')
      await second.evaluate('document.querySelector("[data-tab=model-services]").click()')
      await expect.poll(
        () => second.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-service]"))'),
        { timeout: 15_000 },
      ).toBe(true)
      expect(await first.evaluate('document.body.textContent.includes("fixture-model-secret")')).toBe(false)
      await first.evaluate(`(() => {
        const row = document.querySelector('[data-shared-model-service=fixture-service]')
        const remove = [...row.querySelectorAll('button')].find(button =>
          ['Delete', '删除'].includes(button.textContent.trim()))
        if (!remove) throw new Error('Model service delete action is unavailable')
        remove.click()
      })()`)
      try {
        await expect.poll(
          () => first.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-service]"))'),
          { timeout: 15_000 },
        ).toBe(false)
      } catch {
        const state = await first.evaluate(`({
          notice: document.querySelector('.cxms-shared-notice')?.textContent?.slice(0, 300),
          disabled: document.querySelector('[data-shared-model-service=fixture-service] button:last-child')?.disabled,
        })`)
        const actual = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Array<{ id: string }> }
        throw new Error(
          'Model service removal did not complete: ' + JSON.stringify({
            state,
            providerStillPresent: actual.providers.some(item => item.id === 'fixture-service'),
          }),
        )
      }
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Array<{ id: string }> }
      expect(config.providers.some(item => item.id === 'fixture-service')).toBe(false)
      await expect.poll(
        () => second.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-service]"))'),
        { timeout: 20_000 },
      ).toBe(false)

      await first.evaluate(`(() => {
        const add = [...document.querySelectorAll('.cxms-shared-header button')].find(button =>
          ['Add shared service', '添加跨应用服务'].includes(button.textContent.trim()))
        if (!add) throw new Error('Model service add action is unavailable')
        add.click()
      })()`)
      await expect.poll(() =>
        first.evaluate('Boolean(document.querySelector(".cxmc-editor [data-config-path=id] input"))')
      )
        .toBe(true)
      for (
        const [field, value] of [
          ['id', 'fixture-created'],
          ['displayName', 'Created fixture'],
          ['baseUrl', 'https://example.test'],
          ['codexModels', 'fixture-model'],
          ['apiKey', 'fixture-created-secret'],
        ]
      ) {
        await first.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(`.cxmc-editor [data-config-path="${field}"] input`)})
          if (!input) throw new Error('Model service field is unavailable')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        })()`)
      }
      await expect.poll(
        () => first.evaluate('!document.querySelector(".cxmc-editor-actions button:last-child").disabled'),
        { timeout: 10_000 },
      ).toBe(true)
      await first.evaluate('document.querySelector(".cxmc-editor-actions button:last-child").click()')
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-created]"))'),
        { timeout: 15_000 },
      ).toBe(true)
      const created = JSON.parse(await readFile(configPath, 'utf8')) as {
        providers: Array<{ id: string; apiKeyEnv?: string }>
        environmentVariables: Array<{ name: string; value?: string }>
      }
      const declaration = created.providers.find(item => item.id === 'fixture-created')
      expect(declaration?.apiKeyEnv).toBeDefined()
      expect(
        created.environmentVariables.some(item =>
          item.name === declaration?.apiKeyEnv && item.value === 'fixture-created-secret'
        ),
      ).toBe(true)
      expect(await first.evaluate('document.body.textContent.includes("fixture-created-secret")')).toBe(false)
      await expect.poll(
        () => second.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-created]"))'),
        { timeout: 20_000 },
      ).toBe(true)
      await first.evaluate(
        'document.querySelector("[data-shared-model-service=fixture-created] .cxms-shared-actions button:first-child").click()',
      )
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector(".cxmc-editor [data-config-path=displayName] input"))'),
        { timeout: 10_000 },
      ).toBe(true)
      const inputPoint = await first.evaluate<{ x: number; y: number }>(
        '(() => { const rect = document.querySelector(".cxmc-editor [data-config-path=displayName] input").getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()',
      )
      await first.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...inputPoint,
        button: 'left',
        clickCount: 1,
      })
      await first.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...inputPoint,
        button: 'left',
        clickCount: 1,
      })
      await first.evaluate(
        '(() => { const input = document.querySelector(".cxmc-editor [data-config-path=displayName] input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Unsaved fixture"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })) })()',
      )
      await expect.poll(
        () =>
          first.evaluate(
            '(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()',
          ),
        { timeout: 10_000 },
      ).toBe(true)
      const dialogs = () =>
        first.diagnostics.filter(item => (item as { method?: string }).method === 'Page.javascriptDialogOpening').length
      const previousDialogs = dialogs()
      const attemptedReload = first.send('Page.reload', {}, 20_000)
      try {
        await expect.poll(dialogs, { timeout: 10_000 }).toBe(previousDialogs + 1)
        await first.send('Page.handleJavaScriptDialog', { accept: false })
        await attemptedReload
      } catch (error) {
        await first.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
        await attemptedReload.catch(() => undefined)
        throw error
      }
      expect(await first.evaluate('document.querySelector(".cxmc-editor [data-config-path=displayName] input").value'))
        .toBe('Unsaved fixture')
      await first.evaluate('document.querySelector(".cxmc-editor-actions button:first-child").click()')
      await first.evaluate('globalThis.__modelServicesBeforeReload = true')
      await first.send('Page.reload')
      await expect.poll(
        async () => await first.evaluate('globalThis.__modelServicesBeforeReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await expect.poll(
        () => first.evaluate('Boolean(document.querySelector("[data-shared-model-service=fixture-created]"))'),
        { timeout: 15_000 },
      ).toBe(true)

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
