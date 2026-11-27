import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { managerChildEnvironment } from '../packages/cli/src/cli/manager-supervisor.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { assertOwnedServicesStopped, captureOwnedService } from './fixtures/owned-service-cleanup.js'
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
    const codexHome = path.join(root, 'codex')
    const profile = path.join(root, 'chrome-profile')
    const env = managerChildEnvironment(process.env, 'unused')
    delete env.CORDISX_MANAGER_CHILD_KEY
    Object.assign(env, {
      HOME: root,
      CODEX_HOME: codexHome,
      CORDISX_HOME: homeDir,
      CORDISX_MODEL_API_PORT: '0',
    })
    await mkdir(homeDir, { mode: 0o700 })
    await mkdir(codexHome, { mode: 0o700 })
    const homeConfig = JSON.parse(JSON.stringify(createDefaultHomeConfig()))
    homeConfig.apps.codex.profiles.default.configModelCatalogs = { fixture: 'fixture-models.json' }
    await writeFile(path.join(homeDir, 'config.json'), JSON.stringify(homeConfig), { mode: 0o600 })
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.fixture]',
        'name = "Fixture provider"',
        'base_url = "https://fixture-private.example.test/v1"',
        'env_key = "FIXTURE_PRIVATE_ENV"',
        'experimental_bearer_token = "fixture-private-token"',
      ].join('\n'),
    )
    const modelCatalog = path.join(codexHome, 'fixture-models.json')
    await writeFile(
      modelCatalog,
      JSON.stringify({
        models: [{ slug: 'fixture-model', base_instructions: 'fixture-private-instructions' }],
      }),
    )
    let cli: string | undefined
    let browser: ChildProcess | undefined
    let first: CdpClient | undefined
    let second: CdpClient | undefined
    let third: CdpClient | undefined
    let startupRequested = false
    let failed = false
    const owners: Awaited<ReturnType<typeof captureOwnedService>>[] = []
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli!, ...args], { env, cwd: root, timeout: 30_000 })
    try {
      const fixturePackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
      if (fixturePackage !== undefined) {
        if (!path.isAbsolute(fixturePackage)) throw new Error('fixture package must be an absolute path')
        await symlink(fixturePackage, path.join(root, 'package'), 'dir')
      } else {
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
        const modules = path.join(root, 'package', 'node_modules')
        await mkdir(modules, { recursive: true })
        for (const name of ['@vitejs', 'vite']) {
          await symlink(
            path.resolve('packages/cli/node_modules', name),
            path.join(modules, name),
            'dir',
          )
        }
      }
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
      cli = path.join(root, 'package', 'dist', 'src', 'cli.js')
      startupRequested = true
      const service = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout)
      owners.push(await captureOwnedService(homeDir))
      expect(service).toMatchObject({ status: 'ready', mode: 'service', webEntry: expect.stringMatching(/^file:/u) })
      const open = async () => {
        const link = new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
        expect(link.search).toBe('')
        return link.href
      }
      const firstUrl = service.webEntry as string
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      first = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await first.send('Runtime.enable')
      await first.send('Page.enable')
      // The startup migration is a real write. Its localStorage removal is the
      // renderer's acknowledgement that the write and readback completed.
      await first.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `if (location.origin === ${JSON.stringify(service.webOrigin)}) {
          globalThis.__fixtureDialogRoots = []
          const attachShadow = Element.prototype.attachShadow
          Element.prototype.attachShadow = function(options) {
            const root = attachShadow.call(this, options)
            globalThis.__fixtureDialogRoots.push(root)
            return root
          }
          if (!sessionStorage.getItem('fixture-migration-seeded')) {
            sessionStorage.setItem('fixture-migration-seeded', '1')
            localStorage.setItem('cordisx.manager.marketplaceSources.v2', '[]')
          }
          globalThis.__fixtureHttpFailures = []
          const send = window.fetch.bind(window)
          const original = (request, options) => {
            const result = send(request, options)
            if (typeof request === 'string' && request.startsWith('/api/')) {
              const route = request.split('?')[0].replace(/[a-f0-9]{64}/g, '[id]')
              result.then(response => {
                if (!response.ok) globalThis.__fixtureHttpFailures.push({ route, status: response.status })
              }, () => globalThis.__fixtureHttpFailures.push({ route, status: 0 }))
            }
            return result
          }
          window.fetch = (request, options) => {
            if (request === '/api/session' && !sessionStorage.getItem('fixture-exchange-issued')) {
              return original(request, options).then(response => {
                if (!response.ok) return response
                sessionStorage.setItem('fixture-exchange-issued', '1')
                return new Promise(() => {})
              })
            }
            if (typeof request === 'string' && request.startsWith('/api/session/resume/')
              && sessionStorage.getItem('fixture-interrupt-resume') === '1') {
              return original(request, options).then(response => {
                if (!response.ok) return response
                sessionStorage.removeItem('fixture-interrupt-resume')
                sessionStorage.setItem('fixture-resume-issued', '1')
                return new Promise(() => {})
              })
            }
            if (request === '/api/renderer/close' && sessionStorage.getItem('fixture-drop-close') === '1') {
              sessionStorage.removeItem('fixture-drop-close')
              sessionStorage.setItem('fixture-close-dropped', '1')
              return Promise.reject(new Error('simulated lost unload request'))
            }
            return original(request, options)
          }
        }`,
      })
      await first.send('Page.navigate', { url: firstUrl })
      let readinessCheckpoint = 0
      const ready = async (page: CdpClient) => {
        const checkpoint = ++readinessCheckpoint
        await vi.waitFor(async () => {
          const state = await page.evaluate<{ ready: boolean; status: string }>(`({
        ready: document.documentElement.dataset.cordisxReady === 'true' && !!globalThis.__cordisxRuntime
          && document.documentElement.dataset.cordisxManagerReady === 'true',
        status: document.querySelector('p[role=status]')?.textContent ?? ''
      })`)
          expect(state.ready, state.status).toBe(true)
        }, { timeout: 45_000 }).catch(error => {
          throw new Error(`Browser readiness checkpoint ${checkpoint} failed`, { cause: error })
        })
      }
      // The server consumed the bootstrap, but the browser lost the first
      // response. Reload must retry the same tab attempt before bootstrapping.
      await vi.waitFor(async () => {
        expect(await first!.evaluate("sessionStorage.getItem('fixture-exchange-issued')")).toBe('1')
      }, { timeout: 15_000 })
      expect(await first.evaluate('location.hash.length > 1')).toBe(true)
      await first.send('Page.reload')
      await ready(first)
      expect(await first.evaluate('location.hash')).toBe('')
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-entry-attempt')")).toBeNull()
      // Browser annotations inject their own style element into a shadow root.
      // Allow that UI while keeping inline script and style attributes blocked.
      const annotationPolicy = await first.evaluate(`(() => {
        const host = document.createElement('div')
        const shadow = host.attachShadow({ mode: 'open' })
        const style = document.createElement('style')
        style.textContent = '.annotation-policy-probe { color: rgb(12, 34, 56) }'
        const box = document.createElement('div')
        box.className = 'annotation-policy-probe'
        shadow.append(style, box)
        const attribute = document.createElement('div')
        attribute.setAttribute('style', 'position: fixed')
        const script = document.createElement('script')
        script.textContent = 'globalThis.__annotationInlineScriptRan = true'
        document.body.append(host, attribute, script)
        const result = {
          styleSheets: shadow.styleSheets.length,
          color: getComputedStyle(box).color,
          attributePosition: getComputedStyle(attribute).position,
          scriptRan: globalThis.__annotationInlineScriptRan === true,
        }
        host.remove()
        attribute.remove()
        script.remove()
        delete globalThis.__annotationInlineScriptRan
        return result
      })()`)
      expect(annotationPolicy).toEqual({
        styleSheets: 1,
        color: 'rgb(12, 34, 56)',
        attributePosition: 'static',
        scriptRan: false,
      })
      let priorResume = await first.evaluate<string>("sessionStorage.getItem('cordisx-manager-resume-id')")
      expect(priorResume).toMatch(/^[a-f0-9]{64}$/u)
      const migrationComplete = async () => {
        const config = JSON.parse(await readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
          apps?: {
            codex?: { profiles?: { default?: { management?: { migrations?: { legacyBrowserSourcesV2?: boolean } } } } }
          }
        }
        return config.apps?.codex?.profiles?.default?.management?.migrations?.legacyBrowserSourcesV2 === true
      }
      const migratedAtReady = await migrationComplete()
      await vi.waitFor(async () => {
        expect(await first!.evaluate("localStorage.getItem('cordisx.manager.marketplaceSources.v2')")).toBeNull()
      }, { timeout: 15_000 })
      const migratedBeforeReload = await migrationComplete()
      expect(migratedBeforeReload).toBe(true)
      // A lost read-only heartbeat must not retire an otherwise live owner
      // session. Exercise the browser transport against the real service;
      // no lifecycle command or configuration write is replayed.
      await first.evaluate(`(() => {
        const previous = window.fetch
        const state = globalThis.__fixtureSessionTransport = { failed: 0, succeeded: 0 }
        window.fetch = function(request, options) {
          if (request === '/api/renderer/session') {
            if (state.failed === 0) {
              state.failed++
              return Promise.reject(new TypeError('controlled temporary network failure'))
            }
            return previous.call(this, request, options).then(response => {
              if (response.ok) state.succeeded++
              return response
            })
          }
          return previous.call(this, request, options)
        }
        globalThis.__fixtureRestoreSessionFetch = () => { window.fetch = previous }
      })()`)
      await vi.waitFor(async () => {
        const state = await first!.evaluate<{ failed: number; succeeded: number; available: boolean }>(`({
          ...globalThis.__fixtureSessionTransport,
          available: document.documentElement.dataset.cordisxManagerReady === 'true'
        })`)
        expect(state.failed).toBe(1)
        expect(state.succeeded).toBeGreaterThanOrEqual(1)
        expect(state.available).toBe(true)
      }, { timeout: 25_000 })
      await first.evaluate('globalThis.__fixtureRestoreSessionFetch()')
      // If both read-only heartbeat attempts lose transport while idle, the
      // same tab may resume only after the owner retires its old renderer.
      await first.evaluate(`(() => {
        const previous = window.fetch
        const state = globalThis.__fixtureHeartbeatFailures = { count: 0 }
        window.fetch = function(request, options) {
          if (request === '/api/renderer/session' && state.count < 2) {
            state.count++
            return Promise.reject(new TypeError('controlled temporary network failure'))
          }
          return previous.call(this, request, options)
        }
      })()`)
      await vi.waitFor(async () => {
        const state = await first!.evaluate<{ count: number; status: string }>(`({
          count: globalThis.__fixtureHeartbeatFailures.count,
          status: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
        expect(state.count).toBe(2)
        expect(state.status).toMatch(/Connection interrupted|连接中断/u)
      }, { timeout: 25_000 })
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")).toBe(priorResume)
      await first.send('Page.reload')
      await ready(first)
      const recoveredResume = await first.evaluate<string>("sessionStorage.getItem('cordisx-manager-resume-id')")
      expect(recoveredResume).toMatch(/^[a-f0-9]{64}$/u)
      expect(recoveredResume).not.toBe(priorResume)
      priorResume = recoveredResume
      // Browsers may drop an unload keepalive. The authenticated replacement
      // must still retire the old owner session before joining.
      await first.evaluate("sessionStorage.setItem('fixture-drop-close', '1')")
      await first.send('Page.reload')
      try {
        await vi.waitFor(async () => {
          const current = await first!.evaluate<string | null>("sessionStorage.getItem('cordisx-manager-resume-id')")
          expect(current).toMatch(/^[a-f0-9]{64}$/u)
          expect(current).not.toBe(priorResume)
        }, { timeout: 20_000 })
      } catch (error) {
        const page = await first.evaluate(`({
          status: document.querySelector('p[role=status]')?.textContent ?? '',
          hasResume: sessionStorage.getItem('cordisx-manager-resume-id') !== null,
          requests: performance.getEntriesByType('resource').filter(item =>
            new URL(item.name).pathname.startsWith('/api/')
          ).map(item => ({ path: new URL(item.name).pathname.replace(/[a-f0-9]{64}/g, '[id]'), status: item.responseStatus }))
        })`)
        throw new Error(
          'Manager refresh did not resume: ' + JSON.stringify({
            migratedAtReady,
            migratedBeforeReload,
            migratedAfterReload: await migrationComplete(),
            page,
          }),
          { cause: error },
        )
      }
      await ready(first)
      expect(await first.evaluate("sessionStorage.getItem('fixture-close-dropped')")).toBe('1')
      expect(await first.evaluate('location.hash')).toBe('')
      const beforeInterruptedResume = await first.evaluate<string>(
        "sessionStorage.getItem('cordisx-manager-resume-id')",
      )
      await first.evaluate("sessionStorage.setItem('fixture-interrupt-resume', '1')")
      await first.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await first!.evaluate("sessionStorage.getItem('fixture-resume-issued')")).toBe('1')
      }, { timeout: 20_000 })
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")).toBe(beforeInterruptedResume)
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-attempt')"))
        .toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/u)
      await first.send('Page.reload')
      await ready(first)
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')"))
        .not.toBe(beforeInterruptedResume)
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-attempt')")).toBeNull()
      const cookies = await first.send('Network.getAllCookies') as { cookies: Array<{ name: string; path: string }> }
      const resumeCookies = cookies.cookies.filter(cookie => cookie.name === 'cordisx_manager_resume')
      const currentResume = await first.evaluate<string>("sessionStorage.getItem('cordisx-manager-resume-id')")
      expect(resumeCookies.length).toBe(1)
      expect(resumeCookies[0]?.path === `/api/session/resume/${currentResume}`).toBe(true)
      const firstTarget = await first.send('Target.getTargetInfo') as { targetInfo: { targetId: string } }
      const created = await first.send('Target.createTarget', { url: await open() }) as { targetId: string }
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
      // A lost idle poll can continue only after the sidecar confirms that no
      // command was offered. Keep this page's in-memory search and session.
      const beforeLostPoll = await first.evaluate<string>(
        "sessionStorage.getItem('cordisx-manager-resume-id')",
      )
      await first.evaluate("document.querySelector('[data-unified-plugins-page] input[type=search]').focus()")
      await first.send('Input.insertText', { text: 'fixture-search-draft' })
      expect(await first.evaluate("document.querySelector('[data-unified-plugins-page] input[type=search]').value"))
        .toBe('fixture-search-draft')
      await first.evaluate(`(() => {
        const send = window.fetch.bind(window)
        let dropped = false
        window.fetch = (resource, options) => {
          if (resource === '/api/renderer/poll' && !dropped) {
            dropped = true
            return Promise.reject(new TypeError('controlled lost poll'))
          }
          if (resource === '/api/renderer/poll-recover') {
            return send(resource, options).then(async response => {
              const value = await response.clone().json()
              globalThis.__fixturePollRecovered = value.recovered === true
              return response
            })
          }
          return send(resource, options)
        }
      })()`)
      await vi.waitFor(async () => {
        expect(await first!.evaluate('globalThis.__fixturePollRecovered')).toBe(true)
      }, { timeout: 25_000 })
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")).toBe(beforeLostPoll)
      expect(await first.evaluate("document.querySelector('[data-unified-plugins-page] input[type=search]').value"))
        .toBe('fixture-search-draft')
      expect(await first.evaluate('document.documentElement.dataset.cordisxManagerReady')).toBe('true')
      expect(await second.evaluate('document.documentElement.dataset.cordisxManagerReady')).toBe('true')
      // Also lose the response after the sidecar completed an empty poll.
      await first.evaluate(`(() => {
        const send = window.fetch.bind(window)
        let dropped = false
        window.fetch = (resource, options) => {
          if (resource === '/api/renderer/poll' && !dropped) {
            return send(resource, options).then(async response => {
              const value = await response.clone().json()
              if (value.command === null) {
                dropped = true
                throw new TypeError('controlled lost empty response')
              }
              return response
            })
          }
          if (resource === '/api/renderer/poll-recover') {
            return send(resource, options).then(async response => {
              globalThis.__fixtureEmptyPollRecovered = (await response.clone().json()).recovered === true
              return response
            })
          }
          return send(resource, options)
        }
      })()`)
      await vi.waitFor(async () => {
        expect(await first!.evaluate('globalThis.__fixtureEmptyPollRecovered')).toBe(true)
      }, { timeout: 45_000 })
      expect(await first.evaluate("sessionStorage.getItem('cordisx-manager-resume-id')")).toBe(beforeLostPoll)
      expect(await first.evaluate("document.querySelector('[data-unified-plugins-page] input[type=search]').value"))
        .toBe('fixture-search-draft')
      expect(await second.evaluate('document.documentElement.dataset.cordisxManagerReady')).toBe('true')
      // Inspect only the privacy result, never the response or its private inputs.
      await first.evaluate(`(() => {
        const send = window.fetch.bind(window)
        window.fetch = (resource, options) => {
          const result = send(resource, options)
          if (resource !== '/api/renderer/binding') return result
          try {
            if (JSON.parse(options.body).channel !== 'native-catalog') return result
            return result.then(async response => {
              const text = await response.clone().text()
              globalThis.__fixtureNativeCatalog = {
                ok: response.ok,
                leaked: ['fixture-private-token', 'FIXTURE_PRIVATE_ENV', 'fixture-private.example.test',
                  'fixture-private-instructions', ${JSON.stringify(root)}].some(value => text.includes(value)),
              }
              return response
            })
          } catch { return result }
        }
      })()`)
      for (const page of [first, second]) {
        await page.evaluate('document.querySelector("[data-tab=model-services]").click()')
        await vi.waitFor(async () => {
          expect(await page.evaluate("document.querySelector('.cxms-provider-identity')?.textContent"))
            .toContain('Fixture provider')
        }, { timeout: 20_000 })
        expect(await page.evaluate("document.querySelector('[data-empty-state=unavailable]') === null")).toBe(true)
        await page.evaluate("document.querySelector('.cxms-provider-toggle').click()")
        expect(await page.evaluate("document.querySelector('.cxms-model-identity')?.textContent"))
          .toContain('fixture-model')
        expect(await page.evaluate("document.querySelector('.cxmc-muted')?.textContent"))
          .toMatch(/Read only|只读/u)
      }
      await vi.waitFor(async () => {
        expect(await first!.evaluate('globalThis.__fixtureNativeCatalog')).toEqual({ ok: true, leaked: false })
      }, { timeout: 20_000 })
      await writeFile(modelCatalog, JSON.stringify({ models: [{ slug: 'updated-model' }] }))
      await first.evaluate('globalThis.__fixtureBeforeCatalogReload = true')
      await first.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await first!.evaluate('globalThis.__fixtureBeforeCatalogReload')).toBeUndefined()
      }, { timeout: 15_000 })
      await ready(first)
      await first.evaluate('document.querySelector("[data-tab=model-services]").click()')
      await vi.waitFor(async () => {
        expect(await first!.evaluate("document.querySelector('.cxms-provider-identity')?.textContent"))
          .toContain('Fixture provider')
      }, { timeout: 20_000 })
      await first.evaluate("document.querySelector('.cxms-provider-toggle').click()")
      await vi.waitFor(async () => {
        expect(await first!.evaluate("document.querySelector('.cxms-model-identity')?.textContent"))
          .toContain('updated-model')
      }, { timeout: 20_000 })
      expect(await first.evaluate("document.querySelector('[data-empty-state=unavailable]') === null")).toBe(true)
      for (const page of [first, second]) {
        await page.evaluate('document.querySelector("[data-tab=plugins]").click()')
      }
      const snapshot = async (page: CdpClient) =>
        await page.evaluate<{ active: any; epoch: number }>(`({
      active: globalThis.__cordisxRuntime.activePluginGeneration(),
      epoch: globalThis.__cordisxRuntime.pluginRegistryEpoch()
    })`)
      expect(await snapshot(first)).toEqual(await snapshot(second))
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      const install = async (
        id: string,
        dependencies: readonly { id: string; version: string }[] = [],
        unsupported = false,
      ) => {
        const sourceDirectory = await localPackage({
          root,
          id,
          dependencies,
          requiredCapability: unsupported,
          ...(unsupported ? { canonicalSource: 'https://example.test/unavailable-source' } : {}),
          code: `export function apply() { globalThis.__${id.replaceAll('-', '_')} = true }`,
        })
        if (unsupported) {
          const manifestPath = path.join(sourceDirectory, 'cordisx.plugin.json')
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          manifest.runtimeManifest.capabilities[0].required = false
          await writeFile(manifestPath, JSON.stringify(manifest))
        }
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
      await vi.waitFor(async () => {
        expect(await first!.evaluate('Boolean(document.querySelector("[data-plugin-id=first-browser-plugin]"))'))
          .toBe(true)
      }, { timeout: 20_000 })
      await first.evaluate('document.querySelector("[data-plugin-id=first-browser-plugin]").click()')
      await vi.waitFor(async () => {
        const clicked = await first!.evaluate([
          '(() => {',
          "  const button = document.querySelector('[data-plugin-lifecycle-action=disable]')",
          "  if (!button || button.hasAttribute('disabled') || button.classList.contains('t-is-disabled')) return false",
          '  button.click()',
          '  return true',
          '})()',
        ].join('\n'))
        expect(clicked).toBe(true)
      }, { timeout: 20_000 })
      await vi.waitFor(async () => {
        const description = await first!.evaluate<string>([
          'globalThis.__fixtureDialogRoots',
          "  .find(root => root.querySelector('dialog[open] [data-action=confirm]'))",
          "  ?.querySelector('dialog')?.textContent ?? ''",
        ].join('\n'))
        expect(description).toContain('first-browser-plugin')
        expect(description).toContain('dependent-browser-plugin')
      }, { timeout: 20_000 })
      // A renderer can publish its staged snapshot before the owner finishes
      // committing. Observe the actual management receipt before the next write.
      await first.evaluate(`(() => {
        const send = window.fetch.bind(window)
        window.fetch = (resource, options) => {
          const result = send(resource, options)
          try {
            const envelope = JSON.parse(options?.body ?? '{}')
            const payload = JSON.parse(envelope.payload ?? '{}')
            if (resource === '/api/renderer/binding' && envelope.channel === 'plugin-management'
              && payload.operation?.kind === 'execute') {
              result.then(async response => {
                try {
                  const receipt = await response.clone().json()
                  globalThis.__fixtureDisableReceipt = response.ok && receipt.ok
                    && receipt.value?.status === 'applied' && receipt.value?.request?.kind === 'plugin-disable'
                      ? 'applied' : 'rejected'
                } catch {
                  globalThis.__fixtureDisableReceipt = 'unavailable'
                }
              }, () => globalThis.__fixtureDisableReceipt = 'unavailable')
            }
          } catch {}
          return result
        }
      })()`)
      await first.evaluate([
        'globalThis.__fixtureDialogRoots',
        "  .find(root => root.querySelector('dialog[open] [data-action=confirm]'))",
        "  .querySelector('[data-action=confirm]').click()",
      ].join('\n'))
      await vi.waitFor(
        async () => expect(await first!.evaluate('globalThis.__fixtureDisableReceipt')).toBe('applied'),
        {
          timeout: 45_000,
        },
      )
      await vi.waitFor(async () => {
        for (const page of [first!, second!]) {
          expect((await snapshot(page)).active.plugins.map((item: { enabled: boolean }) => item.enabled))
            .toEqual([false, false])
        }
      }, { timeout: 45_000 })
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
      await install('unsupported-browser-plugin', [], true)
      await install('unavailable-dependent-plugin', [{ id: 'unsupported-browser-plugin', version: '1.0.0' }])
      await install('configured-browser-plugin')
      await install('configured-dependent-plugin', [{ id: 'configured-browser-plugin', version: '1.0.0' }])
      const configs = new PackagePluginConfigStore(homeDir, 'default', endpoint.generation)
      await configs.stage('configured-browser-plugin', 0, { token: 'fixture-private-plugin-configuration' }, 'fixture')
      await configs.commit('configured-browser-plugin', 1, 'fixture')
      const final = await requestPluginManagementRpc(rpcPaths, endpoint, { kind: 'query' }) as any
      expect(final.activationRevision).toBe(11)
      // A new renderer must cold-boot all currently active package graphs,
      // not just packages installed after it joins.
      third = await CdpClient.connect(await socketFor(spare.targetId))
      await third.send('Runtime.enable')
      await third.send('Page.enable')
      await third.send('Page.navigate', { url: await open() })
      await ready(third)
      expect((await snapshot(third)).active.plugins.map((item: { id: string }) => item.id).sort())
        .toEqual([
          'configured-browser-plugin',
          'configured-dependent-plugin',
          'dependent-browser-plugin',
          'first-browser-plugin',
          'headless-after-browser',
          'second-browser-plugin',
          'unavailable-dependent-plugin',
          'unsupported-browser-plugin',
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
      const unavailable = [
        'unsupported-browser-plugin',
        'unavailable-dependent-plugin',
        'configured-browser-plugin',
        'configured-dependent-plugin',
      ]
      const verifyUnavailable = async (page: CdpClient) => {
        const plugins = await page.evaluate<Array<{ id: string; status: string }>>(
          'globalThis.__cordisxRuntime.snapshot().plugins',
        )
        expect(JSON.stringify(plugins)).not.toContain('fixture-private-plugin-configuration')
        for (const id of unavailable) {
          expect(plugins.find(plugin => plugin.id === id)).toMatchObject({ status: 'failed' })
          expect(await page.evaluate(`globalThis.__${id.replaceAll('-', '_')} === undefined`)).toBe(true)
        }
      }
      await verifyUnavailable(third)
      const previousDocument = await third.evaluate<number>('performance.timeOrigin')
      await third.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await third!.evaluate<number>('performance.timeOrigin')).not.toBe(previousDocument)
      }, { timeout: 15_000 })
      await ready(third)
      await verifyUnavailable(third)
      const peerTarget = await third.send('Target.createTarget', { url: await open() }) as { targetId: string }
      second = await CdpClient.connect(await socketFor(peerTarget.targetId))
      await second.send('Runtime.enable')
      await ready(second)
      await verifyUnavailable(second)
      expect(await second.evaluate('globalThis.__first_browser_plugin === true')).toBe(true)
      await change('plugin-disable', 'headless-after-browser')
      await vi.waitFor(async () => {
        for (const page of [third!, second!]) {
          const active = (await snapshot(page)).active.plugins as Array<{ id: string; enabled: boolean }>
          expect(active.find(item => item.id === 'headless-after-browser')?.enabled).toBe(false)
          await verifyUnavailable(page)
        }
      }, { timeout: 20_000 })
      await change('plugin-enable', 'headless-after-browser')
      await vi.waitFor(async () => {
        for (const page of [third!, second!]) {
          const active = (await snapshot(page)).active.plugins as Array<{ id: string; enabled: boolean }>
          expect(active.find(item => item.id === 'headless-after-browser')?.enabled).toBe(true)
        }
      }, { timeout: 20_000 })
    } catch (error) {
      failed = true
      if (process.env.CORDISX_TEST_RETAIN_ON_FAILURE === '1') {
        const pages = await Promise.all([first, second, third].map(async page => {
          if (!page) return undefined
          const state = await page.evaluate(`({
            status: document.querySelector('p[role=status]')?.textContent ?? '',
            ready: document.documentElement.dataset.cordisxManagerReady ?? '',
            runtime: !!globalThis.__cordisxRuntime,
            failures: globalThis.__fixtureHttpFailures ?? [],
          })`).catch(() => undefined)
          return { state, diagnostics: page.diagnostics }
        }))
        await writeFile(path.join(root, 'browser-diagnostics.json'), JSON.stringify({ pages }), { mode: 0o600 })
      }
      throw error
    } finally {
      await first?.close().catch(() => undefined)
      await second?.close().catch(() => undefined)
      await third?.close().catch(() => undefined)
      let browserCleanupFailure: unknown
      if (browser) {
        try {
          await stopChrome(browser)
        } catch (error) {
          browserCleanupFailure = error ?? new Error('test browser exit unconfirmed')
        }
      }
      if (cli) {
        await run('manager', 'stop').catch(() => undefined)
        await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
      }
      await assertOwnedServicesStopped(homeDir, owners, startupRequested)
      if (browserCleanupFailure !== undefined) {
        throw new Error(`test browser exit unconfirmed; retained ${root}`, { cause: browserCleanupFailure })
      }
      const makeRemovable = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700)
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isDirectory()) {
            await makeRemovable(path.join(directory, item.name))
          }
        }
      }
      if (failed && process.env.CORDISX_TEST_RETAIN_ON_FAILURE === '1') {
        console.error(`Retained browser fixture for diagnosis: ${root}`)
      } else {
        await makeRemovable(root)
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  },
  300_000,
)
