import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import WebSocket from 'ws'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { cordisXPluginViteConfig } from '../packages/cli/src/vite.js'

interface ArtifactFile {
  readonly path: `./${string}`
  readonly kind: 'module' | 'stylesheet' | 'asset'
}

interface ArtifactManifest {
  readonly contract: string
  readonly entry: `./${string}`
  readonly files: readonly ArtifactFile[]
}

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...temporary].map(async directory =>
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    ),
  )
  temporary.clear()
})

function chromeExecutable(): string | undefined {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter)
    .flatMap(directory =>
      ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
        .map(name => path.join(directory, name))
    )
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...fromPath,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || !path.isAbsolute(candidate)) continue
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep searching; absence is the only supported skip condition.
    }
  }
  return undefined
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Chrome test could not reserve a CDP port')
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

async function waitForChromeTarget(port: number, process: ChildProcess, stderr: () => string): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Chrome exited before CDP was ready: ${stderr()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json() as Array<
          { readonly type?: string; readonly webSocketDebuggerUrl?: string }
        >
        const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
        if (target?.webSocketDebuggerUrl !== undefined) return target.webSocketDebuggerUrl
      }
    } catch {
      // Chrome has not bound its loopback endpoint yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for Chrome CDP: ${stderr()}`)
}

class CdpClient {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #nextId = 1

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as {
        readonly id?: number
        readonly error?: { readonly message?: string }
        readonly result?: unknown
      }
      if (message.id === undefined) return
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'Chrome CDP request failed'))
      else pending.resolve(message.result)
    })
    socket.on('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Chrome CDP connection closed'))
      this.#pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return new CdpClient(socket)
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId
    this.#nextId += 1
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Chrome CDP request timed out: ${method}`))
      }, 5_000)
      const succeed = (value: unknown): void => {
        clearTimeout(timer)
        resolve(value)
      }
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      this.#pending.set(id, { resolve: succeed, reject: fail })
      this.#socket.send(JSON.stringify({ id, method, params }), error => {
        if (error == null) return
        const pending = this.#pending.get(id)
        this.#pending.delete(id)
        pending?.reject(error)
      })
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as {
      readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } }
      readonly result?: { readonly value?: T }
    }
    if (response.exceptionDetails !== undefined) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
          ?? 'Chrome evaluation failed',
      )
    }
    return response.result?.value as T
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return
    const closed = once(this.#socket, 'close')
    this.#socket.close()
    await closed
  }
}

async function stopChrome(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  process.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (stopped || process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGKILL')
  if (process.exitCode !== null || process.signalCode !== null) return
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
  ])
  if (!killed && process.exitCode === null && process.signalCode === null) {
    throw new Error('Chrome did not exit after SIGKILL')
  }
}

const chrome = chromeExecutable()
const nativeIt = chrome === undefined ? it.skip : it

function javascriptModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

describe('plugin generation native browser graph', () => {
  nativeIt('requires a new strict-CSP document before a loopback graph can load', async () => {
    if (chrome === undefined) throw new Error('Chrome executable disappeared after test discovery')
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-strict-csp-reload-'))
    temporary.add(root)
    const profile = path.join(root, 'chrome-profile')
    const moduleSource = 'export const marker = "strict-csp-graph-loaded"\n'
    await writeFile(path.join(root, 'module.js'), moduleSource)
    const artifact = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
      contract: 'cordisx.plugin-generation-artifact/v1',
      schemaVersion: 1,
      format: 'browser-esm-graph',
      entry: './module.js',
      initialStyles: [],
      sharedImports: [],
      files: [{
        path: './module.js',
        kind: 'module',
        mediaType: 'text/javascript',
        digest: `sha256:${createHash('sha256').update(moduleSource).digest('hex')}`,
        byteLength: Buffer.byteLength(moduleSource),
        imports: [],
        dynamicImports: [],
        styles: [],
        assets: [],
      }],
    } as const

    let artifactServer: PluginGenerationArtifactServer | undefined
    let documentServer: HttpServer | undefined
    let browser: ChildProcess | undefined
    let cdp: CdpClient | undefined
    let browserStderr = ''
    try {
      artifactServer = await startPluginGenerationArtifactServer()
      const lease = await artifactServer.lease(
        {
          packageIdentity: {
            pluginId: 'strict-csp-fixture',
            version: '1.0.0',
            integrity: `sha256:${'b'.repeat(64)}`,
          },
          artifactDirectory: root,
          runtimeEntry: './module.js',
        },
        'strict-csp-generation',
        artifact,
      )
      documentServer = createHttpServer((_request, response) => {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'none'",
        })
        response.end('<!doctype html><title>strict CSP fixture</title>')
      })
      await new Promise<void>((resolve, reject) => {
        documentServer!.once('error', reject)
        documentServer!.listen(0, '127.0.0.1', () => resolve())
      })
      const address = documentServer.address()
      if (address === null || typeof address === 'string') throw new Error('strict CSP fixture did not bind')
      const documentUrl = `http://127.0.0.1:${address.port}/`

      const port = await unusedPort()
      browser = spawn(chrome, [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--remote-allow-origins=*',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      browser.stderr?.on('data', data => {
        browserStderr = `${browserStderr}${data.toString()}`.slice(-8_192)
      })
      const target = await waitForChromeTarget(port, browser, () => browserStderr)
      cdp = await CdpClient.connect(target)
      await cdp.send('Runtime.enable')
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: documentUrl })
      await expect.poll(
        async () => await cdp!.evaluate(`location.href === ${JSON.stringify(documentUrl)} && document.readyState`),
        { timeout: 5_000 },
      ).toBe('complete')

      // Enabling bypass after this document's policy was initialized is too late.
      await cdp.send('Page.setBypassCSP', { enabled: true })
      expect(
        await cdp.evaluate(`(async () => {
        const [module, diagnostic] = await Promise.allSettled([
          import(${JSON.stringify(lease.entryUrl)}),
          fetch(${JSON.stringify(lease.entryUrl)}),
        ])
        return { module: module.status, diagnostic: diagnostic.status }
      })()`),
      ).toEqual({ module: 'rejected', diagnostic: 'rejected' })
      expect(artifactServer.requestTrace()).toEqual([])

      const installId = randomUUID()
      const registration = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `globalThis.__cordisxStrictCspInstallId = ${JSON.stringify(installId)};
globalThis.__cordisxStrictCspBoot = import(${JSON.stringify(lease.entryUrl)}).then(module => {
  globalThis.__cordisxRuntime = { marker: module.marker };
  return globalThis.__cordisxRuntime;
});`,
      }) as { readonly identifier?: string }
      expect(registration.identifier).toBeTypeOf('string')
      await cdp.send('Page.reload')
      await expect.poll(async () => {
        try {
          return await cdp!.evaluate(`(async () => {
            if (globalThis.__cordisxStrictCspInstallId !== ${JSON.stringify(installId)}) return 'pending'
            const runtime = await globalThis.__cordisxStrictCspBoot
            return runtime?.marker ?? 'missing'
          })()`)
        } catch {
          return 'pending'
        }
      }, { timeout: 5_000 }).toBe('strict-csp-graph-loaded')
      expect(
        artifactServer.requestTrace().filter(request => request.method === 'GET' && request.status === 200),
      ).toEqual([expect.objectContaining({ artifactPath: './module.js' })])
      const loadedTrace = artifactServer.requestTrace()
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: registration.identifier })
      await cdp.send('Page.setBypassCSP', { enabled: false })
      await cdp.send('Page.reload')
      await expect.poll(async () => {
        try {
          return await cdp!.evaluate(`document.readyState === 'complete'
            && globalThis.__cordisxStrictCspInstallId === undefined`)
        } catch {
          return false
        }
      }, { timeout: 5_000 }).toBe(true)
      expect(
        await cdp.evaluate(`(async () => {
          const [module, diagnostic] = await Promise.allSettled([
            import(${JSON.stringify(lease.entryUrl)}),
            fetch(${JSON.stringify(lease.entryUrl)}),
          ])
          return { module: module.status, diagnostic: diagnostic.status }
        })()`),
      ).toEqual({ module: 'rejected', diagnostic: 'rejected' })
      expect(artifactServer.requestTrace()).toEqual(loadedTrace)
    } finally {
      if (cdp !== undefined) await cdp.close().catch(() => undefined)
      if (browser !== undefined) await stopChrome(browser)
      if (documentServer !== undefined) {
        await new Promise<void>((resolve, reject) =>
          documentServer!.close(error => error === undefined ? resolve() : reject(error))
        )
      }
      if (artifactServer !== undefined) await artifactServer.close()
    }
  }, 30_000)

  nativeIt('exposes composition boot before a delayed production graph settles', async () => {
    if (chrome === undefined) throw new Error('Chrome executable disappeared after test discovery')
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-composition-boot-'))
    temporary.add(root)
    const profile = path.join(root, 'chrome-profile')
    const entry = path.join(root, 'plugin.js')
    await writeFile(entry, 'export const fixture = true\n')
    const runtimeImport = javascriptModuleUrl(`
      export async function installCordisX(plugins) {
        globalThis.__controlledInstallCalls = (globalThis.__controlledInstallCalls ?? 0) + 1
        const runtime = {
          kind: 'installed-runtime',
          graphMarker: plugins[0].module.marker,
        }
        globalThis.__cordisxRuntime = runtime
        globalThis.__cordisxBoot = Promise.resolve(runtime)
        return runtime
      }
      export function installCordisXComposition(loadPlugins, _metadata, publish, retire) {
        const boot = Promise.resolve().then(async () => {
          globalThis.__cordisxSharedReactRuntime = { kind: 'prepared-react' }
          try {
            const plugins = await loadPlugins()
            const runtime = await installCordisX(plugins)
            publish()
            return runtime
          } catch (error) {
            retire()
            delete globalThis.__cordisxRuntime
            delete globalThis.__cordisxSharedReactRuntime
            throw error
          }
        })
        globalThis.__cordisxBoot = boot
        return boot
      }
    `)
    const config = (loadSource: string, publishSource: string, retireSource: string): CordisXConfig => ({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: 'controlled-graph',
        entry,
        enabled: true,
        config: {},
        runtimeGraph: {
          moduleGeneration: 'controlled-generation',
          loadSource,
          publishSource,
          retireSource,
        },
      }],
    })
    const successful = await buildRendererCompositionSource(
      config(
        `(() => {
          globalThis.__controlledCompositionVisibleAtGraphLoad =
            typeof globalThis.__cordisxCompositionBoot?.then === 'function'
          globalThis.__controlledReactAtGraphLoad = globalThis.__cordisxSharedReactRuntime?.kind === 'prepared-react'
          return globalThis.__controlledGraphPromise
        })()`,
        'globalThis.__controlledGraphPublished = true',
        'globalThis.__controlledGraphRetired = true',
      ),
      {},
      { runtimeImport },
    )
    const rejected = await buildRendererCompositionSource(
      config(
        `(() => {
          globalThis.__rejectedCompositionVisibleAtGraphLoad =
            typeof globalThis.__cordisxCompositionBoot?.then === 'function'
          globalThis.__rejectedReactAtGraphLoad = globalThis.__cordisxSharedReactRuntime?.kind === 'prepared-react'
          return globalThis.__rejectedGraphPromise
        })()`,
        'globalThis.__rejectedGraphPublished = true',
        'globalThis.__rejectedGraphRetired = true',
      ),
      {},
      { runtimeImport },
    )

    let browser: ChildProcess | undefined
    let cdp: CdpClient | undefined
    let browserStderr = ''
    try {
      const port = await unusedPort()
      browser = spawn(chrome, [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--remote-allow-origins=*',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      browser.stderr?.on('data', data => {
        browserStderr = `${browserStderr}${data.toString()}`.slice(-8_192)
      })
      const target = await waitForChromeTarget(port, browser, () => browserStderr)
      cdp = await CdpClient.connect(target)
      await cdp.send('Runtime.enable')

      await cdp.evaluate(`(() => {
        delete globalThis.__cordisxBoot
        delete globalThis.__cordisxRuntime
        delete globalThis.__cordisxSharedReactRuntime
        globalThis.__controlledInstallCalls = 0
        globalThis.__controlledGraphPromise = new Promise((resolve, reject) => {
          globalThis.__resolveControlledGraph = resolve
          globalThis.__rejectControlledGraph = reject
        })
        globalThis.__controlledCompositionImport = import(${JSON.stringify(javascriptModuleUrl(successful.source))})
        return true
      })()`)
      const pending = await cdp.evaluate<{
        readonly compositionBoot: boolean
        readonly serializedBoot: boolean
        readonly runtimeMissing: boolean
        readonly compositionVisibleAtGraphLoad: boolean
        readonly reactReadyAtGraphLoad: boolean
        readonly installCalls: number
      }>(`(async () => {
        await globalThis.__controlledCompositionImport
        return {
          compositionBoot: typeof globalThis.__cordisxCompositionBoot?.then === 'function',
          serializedBoot: globalThis.__cordisxCompositionBoot === globalThis.__cordisxBoot,
          runtimeMissing: globalThis.__cordisxRuntime === undefined,
          compositionVisibleAtGraphLoad: globalThis.__controlledCompositionVisibleAtGraphLoad === true,
          reactReadyAtGraphLoad: globalThis.__controlledReactAtGraphLoad === true,
          installCalls: globalThis.__controlledInstallCalls,
        }
      })()`)
      expect(pending).toEqual({
        compositionBoot: true,
        serializedBoot: true,
        runtimeMissing: true,
        compositionVisibleAtGraphLoad: true,
        reactReadyAtGraphLoad: true,
        installCalls: 0,
      })

      await cdp.evaluate(`(() => {
        globalThis.__resolveControlledGraph({ marker: 'controlled-module' })
        return true
      })()`)
      expect(
        await cdp.evaluate(`(async () => {
          const runtime = await globalThis.__cordisxCompositionBoot
          const bootRuntime = await globalThis.__cordisxBoot
          return {
            kind: runtime.kind,
            graphMarker: runtime.graphMarker,
            installedRuntime: runtime === globalThis.__cordisxRuntime,
            bootRuntime: runtime === bootRuntime,
            published: globalThis.__controlledGraphPublished === true,
            installCalls: globalThis.__controlledInstallCalls,
          }
        })()`),
      ).toEqual({
        kind: 'installed-runtime',
        graphMarker: 'controlled-module',
        installedRuntime: true,
        bootRuntime: true,
        published: true,
        installCalls: 1,
      })

      await cdp.evaluate(`(() => {
        delete globalThis.__cordisxBoot
        delete globalThis.__cordisxRuntime
        delete globalThis.__cordisxSharedReactRuntime
        globalThis.__controlledInstallCalls = 0
        globalThis.__rejectedGraphPromise = new Promise((resolve, reject) => {
          globalThis.__resolveRejectedGraph = resolve
          globalThis.__rejectRejectedGraph = reject
        })
        globalThis.__rejectedCompositionImport = import(${JSON.stringify(javascriptModuleUrl(rejected.source))})
        return true
      })()`)
      expect(
        await cdp.evaluate(`(async () => {
          await globalThis.__rejectedCompositionImport
          return {
            compositionBoot: typeof globalThis.__cordisxCompositionBoot?.then === 'function',
            serializedBoot: globalThis.__cordisxCompositionBoot === globalThis.__cordisxBoot,
            runtimeMissing: globalThis.__cordisxRuntime === undefined,
            compositionVisibleAtGraphLoad: globalThis.__rejectedCompositionVisibleAtGraphLoad === true,
            reactReadyAtGraphLoad: globalThis.__rejectedReactAtGraphLoad === true,
          }
        })()`),
      ).toEqual({
        compositionBoot: true,
        serializedBoot: true,
        runtimeMissing: true,
        compositionVisibleAtGraphLoad: true,
        reactReadyAtGraphLoad: true,
      })
      await cdp.evaluate(`(() => {
        globalThis.__rejectRejectedGraph(new Error('controlled graph load failed'))
        return true
      })()`)
      await expect(cdp.evaluate(`(async () => await globalThis.__cordisxCompositionBoot)()`))
        .rejects.toThrow('controlled graph load failed')
      expect(
        await cdp.evaluate(`({
          retired: globalThis.__rejectedGraphRetired === true,
          published: globalThis.__rejectedGraphPublished === true,
          sharedReactCleaned: globalThis.__cordisxSharedReactRuntime === undefined,
          installCalls: globalThis.__controlledInstallCalls,
        })`),
      ).toEqual({ retired: true, published: false, sharedReactCleaned: true, installCalls: 0 })
    } finally {
      if (cdp !== undefined) await cdp.close().catch(() => undefined)
      if (browser !== undefined) await stopChrome(browser)
    }
  }, 30_000)

  nativeIt('uses native ESM and HTTP caches while retiring generation CSS and routes', async () => {
    if (chrome === undefined) throw new Error('Chrome executable disappeared after test discovery')
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-browser-'))
    temporary.add(root)
    const source = path.join(root, 'plugin')
    const profile = path.join(root, 'chrome-profile')
    const output = path.join(source, 'dist')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await Promise.all([
      writeFile(
        path.join(source, 'src', 'index.ts'),
        `
        export async function trigger() {
          const loaded = await import('./lazy.js')
          return await loaded.activate()
        }
      `,
      ),
      writeFile(
        path.join(source, 'src', 'lazy.ts'),
        `
        import './lazy.css'
        const assetUrl = new URL('./pixel.svg', import.meta.url).href
        const generationBase = new URL('../', import.meta.url).href
        const styleReadyBeforeModule = [...document.querySelectorAll('link[rel~="stylesheet"]')]
          .some(link => link.href.startsWith(generationBase) && link.sheet !== null)
        globalThis.__cordisxNativeLazyExecutions = (globalThis.__cordisxNativeLazyExecutions ?? 0) + 1
        export async function activate() {
          const image = document.createElement('img')
          image.className = 'cordisx-native-lazy'
          image.alt = ''
          const loaded = new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', reject, { once: true })
          })
          image.src = assetUrl
          document.body.append(image)
          await loaded
          return { assetUrl, executions: globalThis.__cordisxNativeLazyExecutions, styleReadyBeforeModule }
        }
      `,
      ),
      writeFile(
        path.join(source, 'src', 'lazy.css'),
        ".cordisx-native-lazy { width: 8px; height: 8px; background-image: url('./pixel.svg') }\n",
      ),
      writeFile(
        path.join(source, 'src', 'pixel.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n',
      ),
    ])
    await viteBuild(cordisXPluginViteConfig({
      root: source,
      entry: './src/index.ts',
      outDir: './dist',
      entryFileName: 'module.js',
    }))
    const artifact = JSON.parse(await readFile(path.join(output, 'artifact.json'), 'utf8')) as ArtifactManifest
    expect(artifact.contract).toBe('cordisx.plugin-generation-artifact/v1')
    expect(artifact.files.some(file => file.kind === 'module' && file.path !== artifact.entry)).toBe(true)
    expect(artifact.files.some(file => file.kind === 'stylesheet')).toBe(true)
    expect(artifact.files.some(file => file.kind === 'asset')).toBe(true)

    let artifactServer: PluginGenerationArtifactServer | undefined
    let browser: ChildProcess | undefined
    let cdp: CdpClient | undefined
    let browserStderr = ''
    try {
      artifactServer = await startPluginGenerationArtifactServer()
      const lease = await artifactServer.lease({
        packageIdentity: {
          pluginId: 'native-browser-fixture',
          version: '1.0.0',
          integrity: `sha256:${'a'.repeat(64)}`,
        },
        artifactDirectory: output,
        runtimeEntry: './module.js',
      }, 'native-browser-generation')
      const port = await unusedPort()
      browser = spawn(chrome, [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--remote-allow-origins=*',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      browser.stderr?.on('data', data => {
        browserStderr = `${browserStderr}${data.toString()}`.slice(-8_192)
      })
      const target = await waitForChromeTarget(port, browser, () => browserStderr)
      cdp = await CdpClient.connect(target)
      await cdp.send('Runtime.enable')

      await cdp.evaluate(`(async () => {
        globalThis.__cordisxNativeGraphModule = await (${lease.importSource})
        return true
      })()`)
      const initialRequests = artifactServer.requestTrace()
        .filter(request => request.method === 'GET' && request.status === 200)
        .map(request => request.artifactPath)
      expect(initialRequests).toEqual(['./module.js'])

      const first = await cdp.evaluate<{
        readonly executions: number
        readonly assetUrl: string
        readonly styleReadyBeforeModule: boolean
      }>(`(async () => await globalThis.__cordisxNativeGraphModule.trigger())()`)
      expect(first.executions).toBe(1)
      expect(first.assetUrl.startsWith(lease.baseUrl)).toBe(true)
      expect(first.styleReadyBeforeModule).toBe(true)
      const firstTrace = artifactServer.requestTrace()
      const firstPaths = new Set(
        firstTrace
          .filter(request => request.method === 'GET' && request.status === 200)
          .map(request => request.artifactPath),
      )
      expect(firstPaths).toEqual(new Set(artifact.files.map(file => file.path)))
      expect(
        await cdp.evaluate<Array<{ readonly href: string; readonly media: string }>>(`
        [...document.querySelectorAll('link[rel~="stylesheet"]')]
          .filter(link => link.href.startsWith(${JSON.stringify(lease.baseUrl)}))
          .map(link => ({ href: link.href, media: link.media }))
      `),
      ).toEqual([expect.objectContaining({ media: 'not all' })])

      await cdp.evaluate(lease.publishSource)
      expect(
        await cdp.evaluate<string[]>(`
        [...document.querySelectorAll('link[rel~="stylesheet"]')]
          .filter(link => link.href.startsWith(${JSON.stringify(lease.baseUrl)}))
          .map(link => link.media)
      `),
      ).toEqual([''])

      const second = await cdp.evaluate<{ readonly executions: number }>(`(async () =>
        await globalThis.__cordisxNativeGraphModule.trigger()
      )()`)
      expect(second.executions).toBe(1)
      expect(artifactServer.requestTrace()).toEqual(firstTrace)

      await cdp.evaluate(lease.retireSource)
      expect(
        await cdp.evaluate<number>(`
        [...document.querySelectorAll('link[rel~="stylesheet"]')]
          .filter(link => link.href.startsWith(${JSON.stringify(lease.baseUrl)})).length
      `),
      ).toBe(0)
      lease.retire()
      await expect(fetch(lease.entryUrl).then(response => response.status)).resolves.toBe(404)
    } finally {
      if (cdp !== undefined) await cdp.close().catch(() => undefined)
      if (browser !== undefined) await stopChrome(browser)
      if (artifactServer !== undefined) await artifactServer.close()
    }
  }, 30_000)
})
