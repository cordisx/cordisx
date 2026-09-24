import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'

describe('production graph watcher', () => {
  it('installs on the exact held seed and activates its original navigation without a reload', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const methods: string[] = []
    server.on('connection', socket => {
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        methods.push(item.method)
        const expression = String(item.params?.expression)
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'startup-bootstrap' }
            : { result: { value: expression.includes('document.readyState') ? true : { ok: true, result: true } } },
        }))
      })
    })
    const seed = 'data:text/html;charset=utf-8,loading'
    const socketUrl = `ws://127.0.0.1:${address.port}/native`
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser` }))
        : new Response(JSON.stringify([{
          id: 'native-production',
          title: 'CordisX loading',
          type: 'page',
          url: seed,
          webSocketDebuggerUrl: socketUrl,
        }]))
    ) as typeof fetch
    const controller = new AbortController()
    const activate = vi.fn(async () => {})
    const ready = vi.fn()
    const watching = watchAndInject({
      port: address.port,
      source: 'globalThis.__cordisxRuntime = {}',
      hasLoopbackGraph: false,
      launcherOwnedNativeTarget: true,
      startupNavigation: Promise.resolve({
        target: {
          id: 'native-production',
          title: 'CordisX startup',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: socketUrl,
        },
        activate,
      }),
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 })
      expect(activate).toHaveBeenCalledWith('startup-bootstrap')
      expect(methods).not.toContain('Page.reload')
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('activates only the held seed when another injectable page is present', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    server.on('connection', socket => {
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const expression = String(item.params?.expression)
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'bootstrap' }
            : { result: { value: expression.includes('document.readyState') ? true : { ok: true, result: true } } },
        }))
      })
    })
    const startupSocket = `ws://127.0.0.1:${address.port}/startup`
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser` }))
        : new Response(JSON.stringify([
          {
            id: 'startup',
            title: 'Loading',
            type: 'page',
            url: 'data:text/html;charset=utf-8,loading',
            webSocketDebuggerUrl: startupSocket,
          },
          {
            id: 'secondary',
            title: 'Codex',
            type: 'page',
            url: 'https://chatgpt.com/',
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/secondary`,
          },
        ]))
    ) as typeof fetch
    const controller = new AbortController()
    const activate = vi.fn(async () => {})
    const ready = vi.fn()
    const watching = watchAndInject({
      port: address.port,
      source: 'globalThis.__cordisxRuntime = {}',
      launcherOwnedNativeTarget: true,
      startupNavigation: Promise.resolve({
        target: {
          id: 'startup',
          title: 'CordisX startup',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: startupSocket,
        },
        activate,
      }),
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2), { timeout: 10_000 })
      expect(activate).toHaveBeenCalledTimes(1)
      expect(activate).toHaveBeenCalledWith('bootstrap')
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('does not reactivate a consumed startup handoff after later installation failure', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    server.on('connection', socket => {
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const expression = String(item.params?.expression)
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'bootstrap' }
            : expression.includes('document.readyState')
            ? { result: { value: true } }
            : { exceptionDetails: { text: 'bootstrap failed' } },
        }))
      })
    })
    let targetUrl = 'data:text/html;charset=utf-8,loading'
    const socketUrl = `ws://127.0.0.1:${address.port}/startup`
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser` }))
        : new Response(JSON.stringify([{
          id: 'startup',
          title: 'Codex',
          type: 'page',
          url: targetUrl,
          webSocketDebuggerUrl: socketUrl,
        }]))
    ) as typeof fetch
    const controller = new AbortController()
    const activate = vi.fn(async () => {
      targetUrl = 'app://-/index.html'
    })
    const statuses: string[] = []
    const watching = watchAndInject({
      port: address.port,
      source: 'throw new Error("bootstrap failed")',
      launcherOwnedNativeTarget: true,
      developmentRuntime: {
        requiresBrowserGraphTransport: () => false,
      } as never,
      startupNavigation: Promise.resolve({
        target: {
          id: 'startup',
          title: 'CordisX startup',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: socketUrl,
        },
        activate,
      }),
      signal: controller.signal,
      onStatus: message => statuses.push(message),
    })
    try {
      await vi.waitFor(
        () => expect(statuses.filter(message => message.includes('waiting for Codex CDP')).length).toBe(2),
        {
          timeout: 10_000,
        },
      )
      expect(activate).toHaveBeenCalledOnce()
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('waits for asynchronous readiness work before publishing ready', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    server.on('connection', socket => {
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = item.params ?? {}
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'production-bootstrap' }
            : {
              result: {
                value: String(params.expression).includes('document.readyState === "complete"')
                  ? true
                  : { ok: true, result: true },
              },
            },
        }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser` }))
        : new Response(JSON.stringify([{
          id: 'native-production',
          title: 'Codex',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/native`,
        }]))
    ) as typeof fetch
    const controller = new AbortController()
    let finishReady!: () => void
    const readyWork = new Promise<void>(resolve => {
      finishReady = resolve
    })
    const enteredReady = vi.fn()
    const status = vi.fn()
    const watching = watchAndInject({
      port: address.port,
      source: 'globalThis.__cordisxCompositionBoot = Promise.resolve(globalThis.__cordisxRuntime = {})',
      hasLoopbackGraph: true,
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
      signal: controller.signal,
      onReady: async () => {
        enteredReady()
        await readyWork
      },
      onStatus: status,
    })
    try {
      await vi.waitFor(() => expect(enteredReady).toHaveBeenCalledOnce(), { timeout: 10_000 })
      expect(status).not.toHaveBeenCalled()
      finishReady()
      await vi.waitFor(() => expect(status).toHaveBeenCalledWith(expect.stringContaining('injected target')), {
        timeout: 10_000,
      })
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('removes a disconnected production target and restores its browser-scoped permission', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const requests: { path: string; method: string; params: Record<string, unknown> }[] = []
    let targetSocket: WebSocket | undefined
    server.on('connection', (socket, request) => {
      const socketPath = request.url ?? ''
      if (socketPath === '/native') targetSocket = socket as unknown as WebSocket
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = item.params ?? {}
        requests.push({ path: socketPath, method: item.method, params })
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'production-bootstrap' }
            : {
              result: {
                value: String(params.expression).includes('document.readyState === "complete"')
                  ? true
                  : { ok: true, result: true },
              },
            },
        }))
      })
    })
    let targets = [{
      id: 'native-production',
      title: 'Codex',
      type: 'page',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/native`,
    }]
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input =>
      String(input).endsWith('/json/version')
        ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/browser` }))
        : new Response(JSON.stringify(targets))
    ) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port: address.port,
      source: 'globalThis.__cordisxCompositionBoot = Promise.resolve(globalThis.__cordisxRuntime = {})',
      hasLoopbackGraph: true,
      launcherOwnedNativeTarget: true,
      pluginArtifactOrigin: 'http://127.0.0.1:47123',
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
})
