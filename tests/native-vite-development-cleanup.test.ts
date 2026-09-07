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
  it('uses the refreshed cold-graph bootstrap for a target discovered after lifecycle finalize', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const registrations: { path: string; source: string }[] = []
    let transactionEpoch = ''
    const active = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 0,
      lastGoodRevision: 0,
      runtimeGeneration: 'cold-production',
      plugins: [{
        id: 'demo',
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}`,
        moduleGeneration: 'demo-old',
        enabled: true,
        dependencies: [],
      }],
    } as const
    const candidate = {
      ...active,
      recordKind: 'candidate',
      transactionId: 'cold-refresh',
      revision: 1,
      plugins: [{ ...active.plugins[0], enabled: false, moduleGeneration: 'demo-new' }],
    } as const
    server.on('connection', (socket, request) =>
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        if (String(item.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: item.id, result: { result: { value: true } } }))
          return
        }
        const expression = String(item.params?.expression ?? '')
        if (item.method === 'Page.addScriptToEvaluateOnNewDocument') {
          registrations.push({ path: request.url ?? '', source: String(item.params?.source ?? '') })
          socket.send(JSON.stringify({ id: item.id, result: { identifier: `script-${registrations.length}` } }))
          return
        }
        const value = expression.includes('stagePluginMutation')
          ? {
            ok: true,
            result: {
              transactionId: 'cold-refresh',
              transactionEpoch,
              expectedRegistryEpoch: 0,
              afterRegistryEpoch: 1,
            },
          }
          : expression.includes('publishPluginMutation')
          ? {
            ok: true,
            result: { transactionId: 'cold-refresh', transactionEpoch, registryEpoch: 1, active: candidate },
          }
          : expression.includes('completePluginMutation')
          ? {
            ok: true,
            result: {
              transactionId: 'cold-refresh',
              transactionEpoch,
              registryEpoch: 1,
              active: candidate,
              disposedAfter: active,
            },
          }
          : { ok: true, result: true }
        socket.send(JSON.stringify({ id: item.id, result: { result: { value } } }))
      }))
    let includeSecond = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: 'cold-first',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/first`,
        },
        ...(includeSecond
          ? [{
            id: 'cold-second',
            title: 'Codex',
            type: 'page',
            url: 'app://-/index.html?second',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/second`,
          }]
          : []),
      ]))
    ) as typeof fetch
    const runtime = new CdpPluginLifecycleRuntime()
    const controller = new AbortController()
    const ready = vi.fn()
    const rebuild = vi.fn(async (next: { revision: number }) => ({
      source: `globalThis.__cordisxRuntime = { revision: ${next.revision} }; // refreshed-live`,
      newDocumentSource: `globalThis.__cordisxRuntime = { revision: ${next.revision} }; // refreshed-future`,
    }))
    const watching = watchAndInject({
      port,
      source: 'globalThis.__cordisxRuntime = { revision: 0 }; // cold-live',
      newDocumentSource: 'globalThis.__cordisxRuntime = { revision: 0 }; // cold-future',
      hasLoopbackGraph: true,
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      productionGraphBootstrap: rebuild as never,
      pluginLifecycle: { runtime, handler: { coordinator: { recover: async () => undefined } } as never },
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      const fence = runtime.prepare('cold-refresh')
      transactionEpoch = fence.transactionEpoch
      await runtime.stage({
        transactionId: 'cold-refresh',
        ...fence,
        afterRegistryEpoch: 1,
        operation: 'disable',
        previous: active,
        candidate,
        targetId: 'demo',
        affectedPluginIds: ['demo'],
      })
      await runtime.publish('cold-refresh')
      await runtime.complete('cold-refresh')
      await runtime.finalize('cold-refresh')
      includeSecond = true
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
      const second = registrations.filter(item => item.path === '/second')
      expect(second).toHaveLength(1)
      expect(second[0]!.source).toContain('refreshed-future')
      expect(second[0]!.source).not.toContain('cold-future')
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('restores every graph-free renderer when one browser graph admission boot fails', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { path: string; method: string; params: Record<string, unknown> }[] = []
    const registrations = new Map<string, number>()
    const scripts = new Map<string, Map<string, string>>()
    const activeSources = new Map<string, string>()
    server.on('connection', (socket, request) => {
      const socketPath = request.url ?? ''
      scripts.set(socketPath, new Map())
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        if (String(item.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: item.id, result: { result: { value: true } } }))
          return
        }
        const params = item.params ?? {}
        requests.push({ path: socketPath, method: item.method, params })
        const productionBoot = item.method === 'Runtime.evaluate'
          && String(params.expression).includes('cordisx:production-boot-pending')
        if (item.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const count = (registrations.get(socketPath) ?? 0) + 1
          registrations.set(socketPath, count)
          const identifier = `${socketPath}-script-${count}`
          scripts.get(socketPath)!.set(identifier, String(params.source ?? ''))
          socket.send(JSON.stringify({ id: item.id, result: { identifier } }))
          return
        }
        if (item.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          const removed = scripts.get(socketPath)!.delete(String(params.identifier ?? ''))
          socket.send(JSON.stringify(
            removed
              ? { id: item.id, result: {} }
              : { id: item.id, error: { code: -32_000, message: 'fixture script was not registered' } },
          ))
          return
        }
        if (item.method === 'Page.reload') {
          activeSources.set(socketPath, [...scripts.get(socketPath)!.values()].join('\n'))
          socket.send(JSON.stringify({ id: item.id, result: {} }))
          return
        }
        socket.send(JSON.stringify({
          id: item.id,
          result: {
            result: {
              value: productionBoot && socketPath === '/second'
                  && activeSources.get(socketPath)?.includes('candidate-graph-transport')
                ? { ok: false, error: 'fixture second renderer admission failed' }
                : { ok: true, result: true },
            },
          },
        }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: 'native-lazy-first',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/first`,
        },
        {
          id: 'native-lazy-second',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html?second',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/second`,
        },
      ]))
    ) as typeof fetch
    const runtime = new CdpPluginLifecycleRuntime()
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'globalThis.__cordisxRuntime = { kind: "cold-graph-free" }',
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      productionGraphBootstrap: async () => ({
        source: 'globalThis.__cordisxRuntime = { kind: "candidate-graph-transport" }',
      }),
      pluginLifecycle: {
        runtime,
        handler: { coordinator: { recover: async () => undefined } } as never,
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
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
      requests.splice(0)
      let admissionError: unknown
      try {
        await runtime.prepareBrowserGraph('failing-first-graph', active)
      } catch (error) {
        admissionError = error
      }
      expect(admissionError).toBeInstanceOf(AggregateError)
      expect((admissionError as AggregateError).message).toContain('CordisX browser graph admission failed')
      expect((admissionError as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'fixture second renderer admission failed' }),
      ]))
      expect(runtime.requiresBrowserGraphTransport()).toBe(false)
      for (const socketPath of ['/first', '/second']) {
        const targetRequests = requests.filter(item => item.path === socketPath)
        expect(targetRequests.filter(item => item.method === 'Page.reload')).toHaveLength(2)
        expect(targetRequests.some(item =>
          item.method === 'Runtime.evaluate'
          && String(item.params.expression).includes('delete globalThis.__cordisxProductionBootstrapState')
        )).toBe(true)
        expect(targetRequests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled))
          .toEqual([true, false])
        expect(scripts.get(socketPath)?.size).toBe(1)
        const restored = [...scripts.get(socketPath)!.values()][0]!
        expect(restored).toContain('cold-graph-free')
        expect(restored).not.toContain('candidate-graph-transport')
      }
      expect(requests.filter(item => item.method === 'Browser.setPermission' && item.params.setting === 'prompt'))
        .toHaveLength(1)
      const fence = runtime.prepare('after-failed-admission')
      expect(fence.expectedRegistryEpoch).toBe(0)
      runtime.cancelPreparation('after-failed-admission')
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('rejects the production compatibility reload for a target the launcher does not own', async () => {
    await expect(watchAndInject({
      port: 9229,
      source: 'globalThis.__cordisxRuntime = {}',
      hasLoopbackGraph: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      signal: new AbortController().signal,
    })).rejects.toThrow('production loopback graph compatibility requires a launcher-owned native target')
  })

  it.each([
    {
      name: 'attach mode',
      launcherOwnedNativeTarget: false,
      url: 'app://-/index.html',
      message: 'browser graph admission requires a launcher-owned native Host',
    },
    {
      name: 'a non-native target',
      launcherOwnedNativeTarget: true,
      url: 'https://chatgpt.com/codex',
      message: 'production loopback graph requires a native app:// renderer target',
    },
  ])('rejects first browser graph admission for $name before any CDP mutation', async fixture => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let registration = 0
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        if (String(request.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
          return
        }
        requests.push({ method: request.method, params: request.params ?? {} })
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') registration += 1
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: `rejected-admission-${registration}` }
            : { result: { value: { ok: true, result: true } } },
        }))
      }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'rejected-admission',
        title: 'Codex',
        type: 'page',
        url: fixture.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
      }]))
    ) as typeof fetch
    const runtime = new CdpPluginLifecycleRuntime()
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'globalThis.__cordisxRuntime = { kind: "graph-free" }',
      launcherOwnedNativeTarget: fixture.launcherOwnedNativeTarget,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      productionGraphBootstrap: async () => ({ source: 'globalThis.__cordisxRuntime = { kind: "graph" }' }),
      pluginLifecycle: { runtime, handler: { coordinator: { recover: async () => undefined } } as never },
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
      runtimeGeneration: 'rejected-admission',
      plugins: [],
    } as const
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      requests.splice(0)
      await expect(runtime.prepareBrowserGraph('rejected-admission', active)).rejects.toThrow(fixture.message)
      expect(requests.some(item =>
        [
          'Browser.setPermission',
          'Page.setBypassCSP',
          'Page.addScriptToEvaluateOnNewDocument',
          'Page.removeScriptToEvaluateOnNewDocument',
          'Page.reload',
        ].includes(item.method)
      )).toBe(false)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('surfaces production cleanup failure after attempting policy restoration and a clean reload', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        if (String(request.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
          return
        }
        const params = request.params ?? {}
        requests.push({ method: request.method, params })
        const cleanupEvaluation = request.method === 'Runtime.evaluate'
          && String(params.expression).includes('delete globalThis.__cordisxProductionBootstrapState')
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'cleanup-failure-production-bootstrap' }
            : {
              result: {
                value: cleanupEvaluation
                  ? { ok: false, error: 'fixture production dispose failed' }
                  : { ok: true },
              },
            },
        }))
      }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-production-cleanup-failure',
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
      source: 'globalThis.__cordisxCompositionBoot = Promise.resolve(globalThis.__cordisxRuntime = {})',
      hasLoopbackGraph: true,
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      controller.abort()
      await expect(watching).rejects.toThrow('CordisX renderer cleanup failed')
    } finally {
      controller.abort()
      await watching.catch(() => undefined)
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.some(item =>
      item.method === 'Runtime.evaluate'
      && String(item.params.expression).includes('delete globalThis.__cordisxProductionBootstrapState')
    )).toBe(true)
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual([
      'granted',
      'prompt',
    ])
    expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(2)
  })

  it('fails a rejected production graph acknowledgement without entering the CDP retry loop', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        if (String(request.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
          return
        }
        const params = request.params ?? {}
        requests.push({ method: request.method, params })
        const failedBoot = request.method === 'Runtime.evaluate'
          && String(params.expression).includes('cordisx:production-boot-pending')
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'failed-production-bootstrap' }
            : {
              result: {
                value: failedBoot
                  ? { ok: false, error: 'fixture production graph failed' }
                  : { ok: true },
              },
            },
        }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-production-failure',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
      }]))
    ) as typeof fetch
    const controller = new AbortController()
    try {
      await expect(watchAndInject({
        port,
        source: 'globalThis.__cordisxCompositionBoot = Promise.reject(new Error("fixture"))',
        hasLoopbackGraph: true,
        launcherOwnedNativeTarget: true,
        pluginArtifactOrigin: 'http://127.0.0.1:47123',
        signal: controller.signal,
      })).rejects.toThrow('CordisX production renderer installation failed: fixture production graph failed')
    } finally {
      controller.abort()
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(connections).toBe(1)
    expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(2)
    expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(true)
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual([
      'granted',
      'prompt',
    ])
  })

  it('restores a loopback grant through the browser endpoint after the native target disconnects', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { path: string; method: string; params: Record<string, unknown> }[] = []
    let targetSocket: WebSocket | undefined
    server.on('connection', (socket, request) => {
      const socketPath = request.url ?? ''
      if (socketPath === '/native') targetSocket = socket as unknown as WebSocket
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        if (String(item.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: item.id, result: { result: { value: true } } }))
          return
        }
        requests.push({ path: socketPath, method: item.method, params: item.params })
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'vite-bootstrap' }
            : { result: { value: { ok: true } } },
        }))
        if (item.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      })
    })
    let targets = [{
      id: 'native-vite',
      title: 'ChatGPT',
      type: 'page',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/native`,
    }]
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }))
        : new Response(JSON.stringify(targets))
    ) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'small-vite-entry',
      viteDevelopment: true,
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 })
      targets = []
      targetSocket?.close()
      await vi.waitFor(() =>
        expect(requests.some(item =>
          item.path === '/browser'
          && item.method === 'Browser.setPermission' && item.params.setting === 'prompt'
        )).toBe(true), { timeout: 10_000 })
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('keeps browser-scoped loopback permission until the last native window is removed', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        if (String(request.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
          return
        }
        requests.push(request)
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: `vite-bootstrap-${request.id}` }
            : { result: { value: { ok: true } } },
        }))
        if (request.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      }))
    const targets = [
      {
        id: 'native-main',
        title: 'ChatGPT',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main`,
      },
      {
        id: 'native-secondary',
        title: 'ChatGPT',
        type: 'page',
        url: 'app://-/secondary.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/secondary`,
      },
    ]
    let currentTargets = targets
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(currentTargets))) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port,
      source: 'small-vite-entry',
      viteDevelopment: true,
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2), { timeout: 10_000 })
      expect(requests.filter(item =>
        item.method === 'Browser.setPermission'
        && item.params.setting === 'granted'
      )).toHaveLength(1)
      currentTargets = [targets[1]!]
      await vi.waitFor(() =>
        expect(requests.filter(item =>
          item.method === 'Page.setBypassCSP'
          && item.params.enabled === false
        )).toHaveLength(1), { timeout: 10_000 })
      expect(requests.some(item =>
        item.method === 'Browser.setPermission'
        && item.params.setting === 'prompt'
      )).toBe(false)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.filter(item =>
      item.method === 'Browser.setPermission'
      && item.params.setting === 'prompt'
    )).toHaveLength(1)
  }, 30_000)

  it.each(['add-script', 'reload', 'bootstrap'] as const)(
    'aborts a pending native Vite %s without reporting an installation failure and runs cleanup',
    async pendingPhase => {
      const server = new WebSocketServer({ port: 0 })
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      const requests: { method: string; params: Record<string, unknown> }[] = []
      let bootChecks = 0
      server.on('connection', socket => {
        socket.on('message', data => {
          const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
          if (String(request.params?.expression).includes('document.readyState === "complete"')) {
            socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
            return
          }
          requests.push(request)
          const bootCheck = request.method === 'Runtime.evaluate'
            && String(request.params.expression).includes('cordisx:vite-boot-pending')
          if (bootCheck) bootChecks += 1
          if (pendingPhase === 'add-script' && request.method === 'Page.addScriptToEvaluateOnNewDocument') return
          if (pendingPhase === 'reload' && request.method === 'Page.reload') return
          socket.send(JSON.stringify({
            id: request.id,
            result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
              ? { identifier: 'pending-vite-bootstrap' }
              : {
                result: {
                  value: bootCheck
                    ? { ok: false, error: 'cordisx:vite-boot-pending' }
                    : { ok: true },
                },
              },
          }))
        })
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify([{
          id: 'native-vite-pending',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
        }]))
      ) as typeof fetch
      const controller = new AbortController()
      const watching = watchAndInject({
        port,
        source: 'pending-vite-entry',
        viteDevelopment: true,
        signal: controller.signal,
      })
      try {
        if (pendingPhase === 'add-script') {
          await vi.waitFor(() =>
            expect(requests.some(item => item.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true)
          )
        } else if (pendingPhase === 'reload') {
          await vi.waitFor(() => expect(requests.some(item => item.method === 'Page.reload')).toBe(true))
        } else {
          await vi.waitFor(() => expect(bootChecks).toBeGreaterThanOrEqual(5))
        }
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
        const startedAt = Date.now()
        controller.abort()
        await expect(watching).resolves.toBeUndefined()
        expect(Date.now() - startedAt).toBeLessThan(1_000)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      } finally {
        controller.abort()
        await watching.catch(() => undefined)
        globalThis.fetch = originalFetch
        server.close()
        await once(server, 'close')
      }
      expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(
        pendingPhase !== 'add-script',
      )
      expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
        true,
        false,
      ])
      expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(
        ['granted', 'prompt'],
      )
    },
    30_000,
  )

  it('fails one broken native Vite installation without entering the CDP retry loop', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        if (String(request.params?.expression).includes('document.readyState === "complete"')) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: true } } }))
          return
        }
        requests.push(request)
        const failedBoot = request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('await globalThis.__cordisxViteBoot')
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'failed-vite-bootstrap' }
            : failedBoot
            ? { result: { value: { ok: false, error: 'fixture Vite module failed' } } }
            : { result: { value: { ok: true } } },
        }))
        if (request.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-vite-failure',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
      }]))
    ) as typeof fetch
    const controller = new AbortController()
    try {
      await expect(
        watchAndInject({ port, source: 'broken-vite-entry', viteDevelopment: true, signal: controller.signal }),
      )
        .rejects.toThrow('CordisX Vite renderer installation failed: fixture Vite module failed')
    } finally {
      controller.abort()
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(connections).toBe(1)
    expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(1)
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual([
      'granted',
      'prompt',
    ])
    expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(true)
  })
})
