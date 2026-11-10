import { createHash } from 'node:crypto'
import { once } from 'node:events'
import vm from 'node:vm'
import { type WebSocket, WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'
import { createNativeSubmissionCdpAuthority } from '../packages/cli/src/launcher/native-submission-cdp-channel.js'

it.each(['closed', 'unresponsive'] as const)(
  'reinstalls the provider channel after its socket becomes %s',
  async mode => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture did not bind TCP')
    const sockets: WebSocket[] = []
    const scripts = new Map<string, string>()
    const methods: string[] = []
    let nextScript = 0
    let currentSocket: WebSocket | undefined
    let unresponsiveSocket: WebSocket | undefined
    const unresponsiveMethods: string[] = []
    let frameTime = 1
    const context = vm.createContext({ crypto: globalThis.crypto, setTimeout, clearTimeout })
    context.__cordisxNativeSubmissionCommand = (payload: string) =>
      currentSocket?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: { name: '__cordisxNativeSubmissionCommand', payload },
      }))
    server.on('connection', socket => {
      sockets.push(socket)
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        const params = request.params ?? {}
        methods.push(request.method)
        if (socket === unresponsiveSocket) {
          unresponsiveMethods.push(request.method)
          return
        }
        let result: Record<string, unknown> = {}
        if (request.method === 'Target.getTargetInfo') result = { targetInfo: { targetId: 'owned' } }
        else if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const identifier = `script-${++nextScript}`
          scripts.set(identifier, String(params.source))
          result = { identifier }
        } else if (request.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          scripts.delete(String(params.identifier))
        } else if (request.method === 'Runtime.evaluate') {
          const expression = String(params.expression)
          if (
            expression.includes('__cordisxNativeSubmissionCommandChannel')
            || expression.includes('__cordisxNativeProviderCommandChannel')
            || expression.includes('__cordisxNativeSubmissionReceive')
          ) {
            currentSocket = socket
            vm.runInContext(expression, context)
          }
          result = { result: { value: { ok: true } } }
          if (expression === 'document.readyState') result = { result: { value: 'complete' } }
          if (expression === 'true' || expression.startsWith('document.readyState ===')) {
            result = { result: { value: true } }
          }
        } else if (request.method === 'Fetch.getResponseBody') {
          result = { body: Buffer.from('ANCHOR').toString('base64'), base64Encoded: true }
        } else if (request.method === 'Page.reload') {
          for (const source of scripts.values()) {
            if (source.includes('__cordisxNativeProviderCommandChannel')) {
              currentSocket = socket
              vm.runInContext(source, context)
            }
          }
          socket.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'owned' } } }))
          socket.send(JSON.stringify({
            method: 'Fetch.requestPaused',
            params: {
              requestId: `resource-${frameTime++}`,
              request: { url: 'app://-/assets/pinned.js' },
              resourceType: 'Script',
              responseStatusCode: 200,
            },
          }))
        }
        socket.send(JSON.stringify({ id: request.id, result }))
      })
    })
    const authority = createNativeSubmissionCdpAuthority({
      submissionAvailable: false,
      catalog:
        async () => [{ providerId: 'fixture', pluginId: 'fixture', models: [{ id: 'test-model', label: 'Test' }] }],
      isThreadIdle: async () => true,
    })
    const channelInstall = vi.spyOn(authority, 'install')
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'owned',
        title: 'Codex',
        url: 'app://-/index.html',
        type: 'page',
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
      }]))
    ) as typeof fetch
    const abort = new AbortController()
    let ready = 0
    const watching = watchAndInject({
      port: address.port,
      source: 'fixture-bootstrap',
      newDocumentSource: 'fixture-bootstrap',
      signal: abort.signal,
      launcherOwnedNativeTarget: true,
      nativeSubmission: {
        authority,
        transforms: [{
          url: 'app://-/assets/pinned.js',
          sha256: createHash('sha256').update('ANCHOR').digest('hex'),
          transform: () => ({
            source: 'PATCHED',
            anchorMatches: 1,
            acknowledgementExpression: 'true',
            fenceExpression: 'true',
          }),
        }],
      },
      onReady: () => {
        ready++
      },
    })
    try {
      await vi.waitFor(() => expect(ready).toBe(1), { timeout: 10_000 })
      const firstOwner = context.__cordisxNativeProviderOwner.rendererGeneration
      const firstCatalog = await context.__cordisxNativeProviderCommandChannel.catalogSnapshotRead()
      expect(firstCatalog.providers[0].providerId).toBe('fixture')
      if (mode === 'closed') {
        sockets[0]!.close()
        await once(sockets[0]!, 'close')
      } else {
        unresponsiveSocket = sockets[0]!
        expect(unresponsiveSocket.readyState).toBe(1)
        const session = channelInstall.mock.calls[0]![0]
        await expect(session.send('Runtime.evaluate', { expression: 'true' }, 2_000)).rejects.toThrow(
          'CDP request timed out: Runtime.evaluate',
        )
      }
      await vi.waitFor(() => expect(ready).toBe(2), { timeout: 15_000 })
      expect(context.__cordisxNativeProviderOwner.rendererGeneration).not.toBe(firstOwner)
      const catalog = await context.__cordisxNativeProviderCommandChannel.catalogSnapshotRead()
      expect(catalog.providers[0].models[0].id).toBe('test-model')
      expect(methods).toContain('Target.getTargetInfo')
      expect(scripts.size).toBe(2)
      expect(sockets).toHaveLength(3)
      if (mode === 'unresponsive') {
        expect(unresponsiveMethods).toEqual([
          'Runtime.evaluate',
          'Runtime.evaluate',
          'Runtime.evaluate',
        ])
      }
    } finally {
      unresponsiveSocket = undefined
      abort.abort()
      await watching
      channelInstall.mockRestore()
      globalThis.fetch = originalFetch
      for (const socket of server.clients) socket.terminate()
      server.close()
      await once(server, 'close')
    }
  },
)
