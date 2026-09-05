import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  await Promise.all([...temporary].map(async directory => await rm(directory, { recursive: true, force: true })))
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

describe('plugin generation native browser graph', () => {
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
