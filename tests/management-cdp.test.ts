import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { install } from '../packages/cli/src/launcher/cdp-installation.js'
import { uninstall } from '../packages/cli/src/launcher/cdp-installation-support.js'
import { MANAGEMENT_BINDING, MANAGEMENT_RECEIVER } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementSnapshot } from '../packages/cli/src/management/contracts.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

describe('plugin management CDP binding', () => {
  it('routes requests and snapshots through install and removes the binding on teardown', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = []
    let connection: import('ws').WebSocket | undefined
    server.on('connection', socket => {
      connection = socket
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        const params = request.params ?? {}
        requests.push({ method: request.method, params })
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'management-bootstrap' }
            : { result: { value: { ok: true } } },
        }))
      })
    })
    const snapshot: PluginManagementSnapshot = {
      profileId: 'review',
      revision: 2,
      sources: [],
      hiddenCatalogEntries: [],
      migrations: { legacyBrowserSourcesV2: true },
      runtime: { kind: 'inactive', pendingActivation: false },
      activationRevision: 0,
      plugins: [],
    }
    let listener: ((value: PluginManagementSnapshot) => void) | undefined
    const unsubscribe = vi.fn()
    const service = {
      query: vi.fn(async () => snapshot),
      subscribe: vi.fn((next: (value: PluginManagementSnapshot) => void) => {
        listener = next
        return unsubscribe
      }),
    } as unknown as PluginManagementService
    const installed = await install(
      {
        id: 'management-target',
        title: 'Codex',
        url: 'https://example.test/',
        type: 'page',
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
      },
      'globalThis.__managementFixture = true',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { token: 'management-token', profileId: 'review', generation: 'generation-1', service },
    )
    try {
      expect(requests).toContainEqual({ method: 'Runtime.addBinding', params: { name: MANAGEMENT_BINDING } })
      connection!.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: MANAGEMENT_BINDING,
          payload: JSON.stringify({
            version: 1,
            requestId: 'request-1',
            token: 'management-token',
            profileId: 'review',
            operation: { kind: 'query' },
          }),
        },
      }))
      await vi.waitFor(() => {
        expect(service.query).toHaveBeenCalledTimes(1)
        expect(
          requests.filter(request => request.method === 'Runtime.evaluate').map(request => request.params.expression),
        ).toEqual(expect.arrayContaining([
          expect.stringContaining(MANAGEMENT_RECEIVER),
        ]))
      })
      listener!(snapshot)
      await vi.waitFor(() => {
        expect(requests.some(request =>
          request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('snapshot')
          && String(request.params.expression).includes('generation-1')
        )).toBe(true)
      })
    } finally {
      await uninstall(installed)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(requests).toContainEqual({ method: 'Runtime.removeBinding', params: { name: MANAGEMENT_BINDING } })
      server.close()
      await once(server, 'close')
    }
  })
})
