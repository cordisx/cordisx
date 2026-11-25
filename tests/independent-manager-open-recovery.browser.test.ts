import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { encodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

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

const active = {
  recordKind: 'active',
  profileId: 'work',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}

const fixtureBundle = [
  'export async function startStandaloneManagerComposition(signal) {',
  '  signal.throwIfAborted();',
  '  const active = ' + JSON.stringify(active) + ';',
  '  let view;',
  '  const unstage = globalThis.__cordisxManagerStartupV1.stage(() => {',
  '    view = document.createElement("main"); view.dataset.fixtureManager = "ready"; document.body.append(view);',
  '  });',
  '  globalThis.__cordisxPluginGenerationResourcesV1 = { stage() {}, publish() {}, retire() {}, dispose() {} };',
  '  const runtime = {',
  '    activePluginGeneration() { return active }, pluginRegistryEpoch() { return 3 },',
  '    async settleRegistryProjection() {}, async adoptRecoveredActivation() {}, async stagePluginMutation() {},',
  '    async publishPluginMutation() {}, async completePluginMutation() {}, async finalizePluginMutation() {},',
  '    async rollbackPluginMutation() {}, async dispose() { unstage(); view?.remove(); }',
  '  };',
  '  globalThis.__cordisxRuntime = runtime; return runtime;',
  '}',
].join(String.fromCharCode(10))

it.skipIf(chrome === undefined).each(['manual', 'automatic', 'unconfirmed', 'entry-transport'] as const)(
  'recovers an interrupted admission through the Manager session authority: %s',
  async mode => {
    const built = await build({
      entryPoints: ['packages/cli/src/independent-manager/standalone-entry.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: ['chrome120'],
      jsx: 'automatic',
      preserveSymlinks: true,
      loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      logLevel: 'silent',
    })
    const script = built.outputFiles[0]!.contents
    const bundle = await encodeManagerRendererBundle(Buffer.from(fixtureBundle))
    const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: randomBytes(32).toString('hex') }
    const authority = new ManagerRendererSessions({
      profileId: 'work',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
      channels: new Map([
        ['plugin-management', {
          prepare: () => {
            throw new Error('unused')
          },
        }],
        ['manager-bootstrap', {
          prepare(payload) {
            const input = payload as { action: string; graphs?: unknown[] }
            return {
              mode: 'read',
              dispatch: async () =>
                input.action === 'status'
                  ? { status: 'ok', current: true }
                  : input.action === 'prepare'
                  ? { status: 'ok', snapshot: {}, privateGraphs: [] }
                  : { status: 'ok', bundle, initialGraphs: input.graphs },
            }
          },
        }],
      ]),
      participant: {
        create({ handle, browserSessionId }) {
          return new ManagerRendererCommandPeer({
            scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' },
            identity: {
              appId: 'codex',
              adapterId: 'manager',
              rendererId: handle.rendererId,
              pid: gateway.pid,
              processStartedAt: gateway.processStartedAt,
            },
            sessionId: browserSessionId,
          })
        },
        attach: async peer => {
          await peer.request('synchronize', { active, registryEpoch: 3 })
        },
      },
    })
    const fence = await authority.suspendMutations()
    let released = false
    let opens = 0
    let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
    let proxy: ReturnType<typeof createServer> | undefined
    let profile: string | undefined
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    try {
      if (mode === 'entry-transport') {
        expect(fence.release()).toBe(true)
        released = true
      }
      web = await startManagerWeb({
        appId: 'codex',
        profileId: 'work',
        generation: 'owner-1',
        isCurrent: async () => true,
        request: async operation => {
          const result = await dispatchManagerRendererOperation(authority, operation)
          if (operation.kind === 'manager-renderer' && operation.action === 'open') {
            opens++
            if ((mode === 'automatic' || mode === 'unconfirmed') && opens === 1) {
              expect(result).toEqual({ status: 'unavailable' })
              expect(fence.release()).toBe(true)
              released = true
            }
          }
          if (mode === 'unconfirmed' && operation.kind === 'manager-renderer' && operation.action === 'revoke') {
            return { status: 'unavailable' }
          }
          return result
        },
      }, { rendererGateway: gateway })
      const target = new URL(web.url)
      const managerOrigin = target.origin
      const managerHost = target.host
      // Supply the changed browser source while exercising the real HTTP and
      // owner session implementation, without changing any installed assets.
      const server = createServer((incoming, outgoing) => {
        if (incoming.url === '/manager-standalone.js') {
          outgoing.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(script)
          return
        }
        const headers = { ...incoming.headers, host: managerHost }
        if (headers.origin !== undefined) headers.origin = managerOrigin
        const upstream = httpRequest(
          managerOrigin + (incoming.url ?? '/'),
          { method: incoming.method, headers },
          response => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(outgoing)
          },
        )
        upstream.on('error', () => {
          if (!outgoing.headersSent) outgoing.writeHead(502).end()
          else outgoing.destroy()
        })
        outgoing.on('close', () => {
          if (!outgoing.writableFinished) upstream.destroy()
        })
        incoming.pipe(upstream)
      })
      proxy = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const port = (server.address() as AddressInfo).port
      target.host = '127.0.0.1:' + port
      target.search = '?host=1'
      profile = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-open-recovery-'))
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await page.send('Runtime.enable')
      await page.send('Page.enable')
      if (mode === 'entry-transport') {
        await page.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `{
            const original = window.fetch.bind(window)
            globalThis.__entryAttempts = []
            window.fetch = async (request, options) => {
              if (request !== '/api/session') return await original(request, options)
              globalThis.__entryAttempts.push(JSON.parse(options.body).attempt)
              const response = await original(request, options)
              if (globalThis.__entryAttempts.length === 1 && response.ok) {
                globalThis.__firstEntryToken = (await response.clone().json()).token
                throw new TypeError('simulated lost entry response')
              }
              return response
            }
          }`,
        })
      }
      await page.send('Page.navigate', { url: target.href })
      if (mode === 'unconfirmed') {
        await vi.waitFor(async () => {
          const text = await page!.evaluate(
            "document.querySelector('.cxr-standalone-unavailable')?.textContent ?? ''",
          )
          expect(text).toContain('连接不可用')
        }, { timeout: 20_000 })
        expect(opens).toBe(1)
        expect(await page.evaluate("document.querySelector('[data-fixture-manager]') !== null")).toBe(false)
        return
      }
      if (mode === 'manual') {
        await vi.waitFor(async () => {
          const state = await page!.evaluate<{ text: string; resume: boolean }>(
            "({ text: document.querySelector('.cxr-standalone-unavailable')?.textContent ?? '', "
              + "resume: !!sessionStorage.getItem('cordisx-manager-resume-id') })",
          )
          expect(state.text).toContain('刷新页面重试')
          expect(state.resume).toBe(true)
        }, { timeout: 20_000 })
        expect(opens).toBe(2)
        expect(fence.release()).toBe(true)
        released = true
        await page.send('Page.reload')
      }
      await vi.waitFor(async () => {
        const state = await page!.evaluate<{ ready: boolean; view: boolean }>(
          "({ ready: document.documentElement.dataset.cordisxManagerReady === 'true', "
            + "view: document.querySelector('[data-fixture-manager]') !== null })",
        )
        expect(state).toEqual({ ready: true, view: true })
      }, { timeout: mode === 'automatic' ? 8_000 : 30_000 })
      if (mode === 'automatic') expect(opens).toBe(2)
      if (mode === 'entry-transport') {
        const state = await page.evaluate<{ attempts: number; same: boolean; oldStatus: number }>(`(async () => ({
          attempts: globalThis.__entryAttempts.length,
          same: /^[a-f0-9]{64}$/.test(globalThis.__entryAttempts[0])
            && globalThis.__entryAttempts[0] === globalThis.__entryAttempts[1],
          oldStatus: (await fetch('/api/renderer/session', {
            method: 'POST', headers: { 'content-type': 'application/json',
              authorization: 'Bearer ' + globalThis.__firstEntryToken }, body: '{}'
          })).status
        }))()`)
        expect(state).toEqual({ attempts: 2, same: true, oldStatus: 401 })
        expect(opens).toBe(1)
      }
    } finally {
      if (!released) fence.release()
      const failures: unknown[] = []
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }
      await cleanup(async () => await page?.close())
      await cleanup(async () => {
        if (browser) await stopChrome(browser)
      })
      await cleanup(async () => {
        if (!proxy?.listening) return
        proxy.closeAllConnections()
        await new Promise<void>(resolve => proxy!.close(() => resolve()))
      })
      authority.dispose()
      await cleanup(async () => await web?.close())
      await cleanup(async () => {
        if (profile) await rm(profile, { recursive: true, force: true })
      })
      if (failures.length) throw new AggregateError(failures, 'browser recovery test cleanup failed')
    }
  },
  60_000,
)
