import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'

describe('production graph watcher', () => {
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
            : { result: { value: { ok: true, result: true } } },
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
