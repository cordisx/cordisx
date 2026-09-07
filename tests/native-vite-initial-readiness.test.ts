import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'

describe('native Vite initial document readiness', () => {
  it('waits for the native document to become terminal before reload', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let acknowledgeReadiness: (() => void) | undefined
    server.on('connection', socket => {
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        requests.push(request)
        const readiness = request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('cordisx:native-document-pending')
        if (readiness && acknowledgeReadiness === undefined) {
          acknowledgeReadiness = () =>
            socket.send(JSON.stringify({
              id: request.id,
              result: { result: { value: { ok: true } } },
            }))
          return
        }
        const bootCheck = request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('cordisx:vite-boot-pending')
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'initial-document-ready-vite-bootstrap' }
            : { result: { value: bootCheck ? { ok: true } : { ok: true, result: true } } },
        }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'native-vite-initial-document',
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
      source: 'initial-document-ready-vite-entry',
      viteDevelopment: true,
      signal: controller.signal,
      onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(acknowledgeReadiness).toBeTypeOf('function'))
      expect(requests.some(item => item.method === 'Page.reload')).toBe(false)
      const readinessExpression = String(
        requests.find(item =>
          item.method === 'Runtime.evaluate'
          && String(item.params.expression).includes('cordisx:native-document-pending')
        )?.params.expression,
      )
      expect(readinessExpression).toContain('app://-/index.html')
      expect(readinessExpression).toContain("document?.readyState !== 'complete'")
      expect(readinessExpression).toContain("codexWindowType !== 'electron'")
      expect(readinessExpression).toContain("bridge?.sendMessageFromView !== 'function'")
      acknowledgeReadiness!()
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      const methods = requests.map(item => item.method)
      expect(methods.indexOf('Runtime.evaluate')).toBeLessThan(methods.indexOf('Page.reload'))
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })
})
