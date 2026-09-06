import { createHash } from 'node:crypto'
import { getEventListeners, once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeViteEntityGenerationHandler,
  startNativeViteServer,
} from '../packages/cli/src/launcher/vite-development.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { CdpPluginLifecycleRuntime, watchAndInject } from '../packages/cli/src/launcher/cdp.js'
import { EntityDirectoryAuthority, entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { entityInstallationId, entityPluginGeneration } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { NativeViteDevelopmentClient } from '../packages/cli/src/renderer/vite-development-client.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const PACKAGE_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v5.schema.json'
const PACKAGE_SCHEMA_V8 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v8.schema.json'
const RUNTIME_SCHEMA_V8 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json'
const ENTITY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'

const viteCacheDirectories: string[] = []
const viteCacheRoots: string[] = []

async function startTestViteServer(config: Parameters<typeof startNativeViteServer>[0]) {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cache-root-'))
  viteCacheRoots.push(cacheRoot)
  const vite = await startNativeViteServer(config, { cacheRoot })
  viteCacheDirectories.push(vite.cacheDir)
  return vite
}

afterEach(async () => {
  await Promise.all(viteCacheDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  await Promise.all(viteCacheRoots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('native Vite development transport', () => {
  it('serves multiple plugin entries from one Vite session and scopes source updates to their owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-multi-'))
    const first = path.join(root, 'plugins', 'first.ts')
    const second = path.join(root, 'plugins', 'second.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"multi-demo","version":"1.0.0","type":"module"}')
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }),
      mkdir(path.dirname(second), { recursive: true }),
    ])
    await writeFile(
      first,
      "import { marker as secondMarker } from './second.js'; export const marker = 'first-one-' + secondMarker; export function apply() {}\n",
    )
    await writeFile(second, "export const marker = 'second-one'; export function apply() {}\n")
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [
        { id: 'first', entry: first, enabled: true, config: {} },
        { id: 'second', entry: second, enabled: true, config: {} },
      ],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    const get = async (name: string) =>
      await fetch(vite.url + name, {
        headers: { Origin: 'null' },
        signal: AbortSignal.timeout(5000),
      }).then(async response => {
        expect(response.status).toBe(200)
        return await response.text()
      })
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const entrySource = await get('@id/__x00__virtual:cordisx-native-entry')
      expect(entrySource).toContain('virtual:cordisx-native-plugin/first')
      expect(entrySource).toContain('virtual:cordisx-native-plugin/second')
      const firstPath = '@id/__x00__virtual:cordisx-native-plugin/first'
      const secondPath = '@id/__x00__virtual:cordisx-native-plugin/second'
      const firstBefore = await get(firstPath)
      const secondBefore = await get(secondPath)
      const firstEntryPath = firstBefore.match(/import\("([^"]+\/first\.ts\?cordisx-plugin-generation=[^"]+)"\)/)?.[1]
      expect(firstEntryPath).toBeDefined()
      await expect(fetch(new URL(firstEntryPath!, new URL(vite.url).origin)).then(response => response.status)).resolves
        .toBe(200)
      const firstDigest = firstBefore.match(/sha256:[a-f0-9]{64}/)?.[0]
      const secondDigest = secondBefore.match(/sha256:[a-f0-9]{64}/)?.[0]
      const client = await get('@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', {
        handshakeTimeout: 5000,
      })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))
      await writeFile(
        first,
        "import { marker as secondMarker } from './second.js'; export const marker = 'first-two-' + secondMarker; export function apply() {}\n",
      )
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'first'
        )).toBe(true), { timeout: 10_000 })
      expect(
        messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'second'
        ),
        JSON.stringify(messages),
      ).toBe(false)
      expect((await get(firstPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(firstDigest)
      expect((await get(secondPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(secondDigest)

      messages.length = 0
      await writeFile(second, "export const marker = 'second-two'; export function apply() {}\n")
      await vi.waitFor(() => {
        const replacements = messages.filter(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
        ).map(message => message.data?.pluginId)
        expect(replacements).toContain('first')
        expect(replacements).toContain('second')
      }, { timeout: 10_000 })
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('reloads only the embedded plugin that owns a changed README', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-readmes-'))
    const firstRoot = path.join(root, 'plugins', 'first')
    const secondRoot = path.join(root, 'plugins', 'second')
    const first = path.join(firstRoot, 'src', 'index.ts')
    const second = path.join(secondRoot, 'src', 'index.ts')
    const firstReadme = path.join(firstRoot, 'README.md')
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }),
      mkdir(path.dirname(second), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(root, 'package.json'), '{"name":"embedded-demo","version":"1.0.0","type":"module"}'),
      writeFile(firstReadme, '# First plugin\n'),
      writeFile(path.join(secondRoot, 'README.md'), '# Second plugin\n'),
      writeFile(first, 'export function apply() {}\n'),
      writeFile(second, 'export function apply() {}\n'),
    ])
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [
        { id: 'first', entry: first, enabled: true, config: {} },
        { id: 'second', entry: second, enabled: true, config: {} },
      ],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    const get = async (name: string) =>
      await fetch(vite.url + name, {
        headers: { Origin: 'null' },
        signal: AbortSignal.timeout(5000),
      }).then(async response => {
        expect(response.status).toBe(200)
        return await response.text()
      })
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const firstPath = '@id/__x00__virtual:cordisx-native-plugin/first'
      const secondPath = '@id/__x00__virtual:cordisx-native-plugin/second'
      const firstDigest = (await get(firstPath)).match(/sha256:[a-f0-9]{64}/)?.[0]
      const secondDigest = (await get(secondPath)).match(/sha256:[a-f0-9]{64}/)?.[0]
      const client = await get('@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', {
        handshakeTimeout: 5000,
      })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))

      await writeFile(firstReadme, '# First plugin updated\n')
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'first'
        )).toBe(true), { timeout: 10_000 })
      expect(messages.some(message =>
        message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'second'
      )).toBe(false)
      expect((await get(firstPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(firstDigest)
      expect((await get(secondPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(secondDigest)
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('waits for the Vite bootstrap acknowledgement and restores the development CSP setting on disposal', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let acknowledge!: () => void
    let bootChecks = 0
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        requests.push(request)
        const reply = () =>
          socket.send(
            JSON.stringify({
              id: request.id,
              result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
                ? { identifier: 'vite-bootstrap' }
                : { result: { value: { ok: true } } },
            }),
          )
        if (String(request.params.expression).includes('await globalThis.__cordisxViteBoot')) {
          bootChecks += 1
          if (bootChecks === 1) {
            socket.send(
              JSON.stringify({
                id: request.id,
                result: { result: { value: { ok: false, error: 'cordisx:vite-boot-pending' } } },
              }),
            )
          } else acknowledge = reply
        } else {
          reply()
          if (request.method === 'Page.reload') {
            queueMicrotask(() =>
              socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }))
            )
          }
        }
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: 'native-vite',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/native`,
        },
        {
          id: 'web-chatgpt',
          title: 'ChatGPT',
          type: 'page',
          url: 'https://chatgpt.com/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/web`,
        },
      ]))
    ) as typeof fetch
    const ready = vi.fn()
    const controller = new AbortController()
    let installId: string | undefined
    const watching = watchAndInject({
      port,
      source: 'small-vite-entry',
      viteDevelopment: true,
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
      expect(ready).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 5_100))
      expect(ready).not.toHaveBeenCalled()
      acknowledge()
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
        true,
      ])
      expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(
        ['granted'],
      )
      expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(1)
      const installedSource = String(
        requests.find(item => item.method === 'Page.addScriptToEvaluateOnNewDocument')?.params.source,
      )
      installId = installedSource.match(/__cordisxViteInstallId = "([^"]+)"/)?.[1]
      expect(installId).toBeDefined()
      const acknowledgementSource = String(
        requests.find(item =>
          item.method === 'Runtime.evaluate'
          && String(item.params.expression).includes('cordisx:vite-boot-pending')
        )?.params.expression,
      )
      expect(acknowledgementSource).toContain(`__cordisxViteInstallId !== "${installId}"`)
      expect(bootChecks).toBe(2)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual([
      'granted',
      'prompt',
    ])
    expect(requests.some(item => String(item.params.expression).includes('__cordisxViteClient?.dispose'))).toBe(true)
    expect(requests.some(item => String(item.params.expression).includes('__cordisxViteHmrDispose?.()'))).toBe(true)
    const cleanupExpression = String(
      requests.find(item =>
        item.method === 'Runtime.evaluate'
        && String(item.params.expression).includes('__cordisxViteHmrDispose?.()')
      )?.params.expression,
    )
    const cleanupCalls: string[] = []
    const cleanupGlobal: Record<string, unknown> = {
      __cordisxViteClient: {
        dispose: async () => {
          cleanupCalls.push('client')
          throw new Error('plugin cleanup failed')
        },
      },
      __cordisxSharedReactRuntime: {
        dispose: () => {
          cleanupCalls.push('react')
        },
      },
      __cordisxViteHmrDispose: async () => {
        cleanupCalls.push('hmr')
      },
      __cordisxViteBoot: Promise.resolve(),
      __cordisxViteInstallId: installId,
    }
    await expect(Function('globalThis', `return ${cleanupExpression}`)(cleanupGlobal)).rejects.toThrow(
      'plugin cleanup failed',
    )
    expect(cleanupCalls).toEqual(['client', 'react', 'hmr'])
    expect(cleanupGlobal).toEqual({})
    expect(connections).toBe(1)
  }, 30_000)

  it('reloads only the native production renderer and awaits its exact graph bootstrap acknowledgement', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { path: string; method: string; params: Record<string, unknown> }[] = []
    let acknowledge: (() => void) | undefined
    let bootChecks = 0
    server.on('connection', (socket, request) => {
      const socketPath = request.url ?? ''
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = item.params ?? {}
        requests.push({ path: socketPath, method: item.method, params })
        const reply = (value: Record<string, unknown> = { ok: true }): void => {
          socket.send(JSON.stringify({
            id: item.id,
            result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
              ? { identifier: 'production-bootstrap' }
              : { result: { value } },
          }))
        }
        const bootCheck = item.method === 'Runtime.evaluate'
          && String(params.expression).includes('cordisx:production-boot-pending')
        if (!bootCheck) {
          reply()
          return
        }
        bootChecks += 1
        if (bootChecks === 1) reply({ ok: false, error: 'cordisx:production-boot-pending' })
        else acknowledge = () => reply()
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: 'native-production',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/native`,
        },
        {
          id: 'web-production',
          title: 'ChatGPT',
          type: 'page',
          url: 'https://chatgpt.com/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/web`,
        },
      ]))
    ) as typeof fetch
    const source = `globalThis.__cordisxCompositionBoot = Promise.resolve(
      globalThis.__cordisxRuntime = { kind: 'production-graph' }
    )`
    const ready = vi.fn()
    const controller = new AbortController()
    const watching = watchAndInject({
      port,
      source,
      hasLoopbackGraph: true,
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
      expect(ready).not.toHaveBeenCalled()
      expect(requests.some(item => item.path === '/web')).toBe(false)
      const methods = requests.map(item => item.method)
      const grantIndex = requests.findIndex(item =>
        item.method === 'Browser.setPermission' && item.params.setting === 'granted'
      )
      const bypassIndex = requests.findIndex(item =>
        item.method === 'Page.setBypassCSP' && item.params.enabled === true
      )
      const registrationIndex = methods.indexOf('Page.addScriptToEvaluateOnNewDocument')
      const reloadIndex = methods.indexOf('Page.reload')
      const acknowledgementIndex = requests.findIndex(item =>
        item.method === 'Runtime.evaluate'
        && String(item.params.expression).includes('cordisx:production-boot-pending')
      )
      expect(grantIndex).toBeGreaterThanOrEqual(0)
      expect(grantIndex).toBeLessThan(bypassIndex)
      expect(bypassIndex).toBeLessThan(registrationIndex)
      expect(registrationIndex).toBeLessThan(reloadIndex)
      expect(reloadIndex).toBeLessThan(acknowledgementIndex)
      expect(requests.find(item => item.method === 'Page.reload')?.params).toEqual({})

      const installedSource = String(requests[registrationIndex]?.params.source)
      const installId = installedSource.match(/__cordisxProductionInstallId = "([^"]+)"/)?.[1]
      expect(installId).toBeDefined()
      expect(installedSource).toContain(`installId: "${installId}"`)
      expect(installedSource).toContain(source)
      const acknowledgementSource = String(requests[acknowledgementIndex]?.params.expression)
      expect(acknowledgementSource.match(new RegExp(`__cordisxProductionInstallId !== "${installId}"`, 'g')))
        .toHaveLength(2)
      expect(acknowledgementSource).toContain('__cordisxProductionBootstrapState')
      expect(acknowledgementSource).toContain('CordisX production runtime is undefined after boot')
      expect(requests.some(item => item.method === 'Runtime.evaluate' && item.params.expression === source)).toBe(
        false,
      )

      acknowledge!()
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(true)
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual([
      'granted',
      'prompt',
    ])
    const removalIndex = requests.findIndex(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')
    const disposeIndex = requests.findIndex(item =>
      item.method === 'Runtime.evaluate'
      && String(item.params.expression).includes('delete globalThis.__cordisxProductionBootstrapState')
    )
    const cspRestoreIndex = requests.findIndex(item =>
      item.method === 'Page.setBypassCSP' && item.params.enabled === false
    )
    const permissionRestoreIndex = requests.findIndex(item =>
      item.method === 'Browser.setPermission' && item.params.setting === 'prompt'
    )
    const cleanReloadIndex = requests.findLastIndex(item => item.method === 'Page.reload')
    expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(2)
    expect(disposeIndex).toBeLessThan(cspRestoreIndex)
    expect(removalIndex).toBeLessThan(cleanReloadIndex)
    expect(removalIndex).toBeLessThan(cspRestoreIndex)
    expect(cspRestoreIndex).toBeLessThan(permissionRestoreIndex)
    expect(permissionRestoreIndex).toBeLessThan(cleanReloadIndex)
  }, 30_000)

  it('does not reload or relax CSP when an artifact origin has no cold production graph', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = request.params ?? {}
        requests.push({ method: request.method, params })
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'production-without-graph' }
            : { result: { value: { ok: true } } },
        }))
      }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-production-without-graph',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
      }]))
    ) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'globalThis.__cordisxRuntime = {}',
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      expect(requests.some(item => item.method === 'Page.reload')).toBe(false)
      expect(requests.some(item => item.method === 'Page.setBypassCSP')).toBe(false)
      expect(requests.some(item => item.method === 'Browser.setPermission')).toBe(false)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('promotes a graph-free native renderer before handing admission to the generation fence', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let registration = 0
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = request.params ?? {}
        requests.push({ method: request.method, params })
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') registration += 1
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: `admission-script-${registration}` }
            : { result: { value: { ok: true, result: true } } },
        }))
      }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-lazy-production-graph',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
      }]))
    ) as typeof fetch
    const runtime = new CdpPluginLifecycleRuntime()
    const rebuild = vi.fn(async () => ({
      source: 'globalThis.__cordisxRuntime = { kind: "latest-graph-source" }',
    }))
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'globalThis.__cordisxRuntime = { kind: "cold-graph-free" }',
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      productionGraphBootstrap: rebuild,
      pluginLifecycle: {
        runtime,
        handler: {
          coordinator: { recover: async () => undefined },
        } as never,
      },
      signal: controller.signal,
      onReady: ready,
    })
    const active = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 0,
      lastGoodRevision: 0,
      runtimeGeneration: 'lazy-production',
      plugins: [],
    } as const
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      requests.splice(0)
      const fence = await runtime.prepareBrowserGraph('first-production-graph', active)
      expect(fence.expectedRegistryEpoch).toBe(0)
      expect(rebuild).toHaveBeenCalledWith(active, 0)
      const methods = requests.map(request => request.method)
      const grant = requests.findIndex(request =>
        request.method === 'Browser.setPermission' && request.params.setting === 'granted'
      )
      const bypass = requests.findIndex(request =>
        request.method === 'Page.setBypassCSP' && request.params.enabled === true
      )
      const registrationIndex = methods.indexOf('Page.addScriptToEvaluateOnNewDocument')
      const removal = methods.indexOf('Page.removeScriptToEvaluateOnNewDocument')
      const reload = methods.indexOf('Page.reload')
      const acknowledgement = requests.findIndex(request =>
        request.method === 'Runtime.evaluate'
        && String(request.params.expression).includes('cordisx:production-boot-pending')
      )
      expect(grant).toBeGreaterThanOrEqual(0)
      expect(grant).toBeLessThan(bypass)
      expect(bypass).toBeLessThan(registrationIndex)
      expect(registrationIndex).toBeLessThan(removal)
      expect(removal).toBeLessThan(reload)
      expect(reload).toBeLessThan(acknowledgement)
      expect(String(requests[registrationIndex]?.params.source)).toContain('latest-graph-source')
      expect(runtime.requiresBrowserGraphTransport()).toBe(true)
      runtime.cancelPreparation('first-production-graph')
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })
})
