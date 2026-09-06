import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  CdpPluginLifecycleRuntime,
  type CdpTarget,
  iconThemePreferenceDeliveryEvaluation,
  injectableTargets,
  RENDERER_DISPOSE_EXPRESSION,
  resolveCdpInjectionTimeoutMs,
  runtimeEvaluationException,
  serviceConfigResponseEvaluation,
  watchAndInject,
} from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PluginPermissionIdentityRegistry } from '../packages/cli/src/launcher/permission-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  ICON_THEME_PREFERENCE_BINDING,
  IconThemePreferenceBroadcastHub,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'
import { OwnerDocumentLeaseRegistry } from '../packages/cli/src/launcher/owner-document-rpc.js'
import type { PluginGenerationGraphLease } from '../packages/cli/src/launcher/plugin-generation-loader.js'

function target(id: string, title: string, url = 'https://example.test/'): CdpTarget {
  return { id, title, url, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}` }
}

function deferred<Value = void>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function iconThemeReceiverPayload(expression: string): Record<string, unknown> | undefined {
  const encoded = expression.match(/receiver\(((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\)/u)?.[1]
  if (encoded === undefined) return undefined
  try {
    return JSON.parse(JSON.parse(encoded) as string) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readyLeaseEcho(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload?.kind === 'document-ready'
    ? { readyLeaseToken: payload.readyLeaseToken, readyLeaseRevision: payload.readyLeaseRevision }
    : {}
}

describe('watchAndInject session replacement', () => {
  it('removes the old script and bindings before a same-target reconnect installs one future bootstrap', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const connections: import('ws').WebSocket[] = []
    const requests: Array<
      Array<{
        readonly method: string
        readonly params: Record<string, unknown>
      }>
    > = []
    const activeScripts = new Map<string, string>()
    let nextScript = 1
    server.on('connection', connection => {
      const connectionIndex = connections.push(connection) - 1
      requests[connectionIndex] = []
      connection.on('message', data => {
        const request = JSON.parse(String(data)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        const params = request.params ?? {}
        requests[connectionIndex]!.push({ method: request.method, params })
        let result: Record<string, unknown> = {}
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const identifier = `bootstrap-${nextScript++}`
          activeScripts.set(identifier, String(params.source))
          result = { identifier }
        } else if (request.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          activeScripts.delete(String(params.identifier))
        } else if (request.method === 'Runtime.evaluate') {
          result = { result: { value: { ok: true } } }
        }
        connection.send(JSON.stringify({ id: request.id, result }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([{
          id: 'reconnected-target',
          title: 'Codex',
          url: 'app://-/index.html',
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
        }]),
        { status: 200 },
      )
    ) as typeof fetch
    const ready = [deferred(), deferred()] as const
    let readyCount = 0
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'current-live-bootstrap',
      newDocumentSource: 'future-document-bootstrap',
      signal: abort.signal,
      agentHistoryHost: {} as never,
      agentHistoryBridgeToken: 'a'.repeat(64),
      onReady: () => {
        ready[Math.min(readyCount++, 1)]!.resolve()
      },
    })
    try {
      await ready[0].promise
      expect(activeScripts).toEqual(new Map([['bootstrap-1', 'future-document-bootstrap']]))
      const firstAddedBindings = requests[0]!
        .filter(request => request.method === 'Runtime.addBinding')
        .map(request => String(request.params.name))
        .sort()
      expect(firstAddedBindings).toHaveLength(2)

      connections[0]!.close()
      await once(connections[0]!, 'close')
      await ready[1].promise

      const replacement = requests[1]!
      const removeScriptIndex = replacement.findIndex(request =>
        request.method === 'Page.removeScriptToEvaluateOnNewDocument'
        && request.params.identifier === 'bootstrap-1'
      )
      const removedBindings = replacement
        .filter(request => request.method === 'Runtime.removeBinding')
        .map(request => String(request.params.name))
        .sort()
      const firstAddBindingIndex = replacement.findIndex(request => request.method === 'Runtime.addBinding')
      const addScriptIndex = replacement.findIndex(request =>
        request.method === 'Page.addScriptToEvaluateOnNewDocument'
      )
      expect(removeScriptIndex).toBeGreaterThanOrEqual(0)
      expect(removedBindings).toEqual(firstAddedBindings)
      expect(removeScriptIndex).toBeLessThan(firstAddBindingIndex)
      expect(firstAddBindingIndex).toBeLessThan(addScriptIndex)
      expect(activeScripts).toEqual(new Map([['bootstrap-2', 'future-document-bootstrap']]))

      // A future navigation evaluates the browser's current registered set;
      // the stale bootstrap is no longer eligible to execute.
      const futureNavigationBootstraps = [...activeScripts.values()]
      expect(futureNavigationBootstraps).toEqual(['future-document-bootstrap'])
    } finally {
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      expect(activeScripts).toEqual(new Map())
      server.close()
      await once(server, 'close')
    }
  })

  it('continues after stale script removal fails and executes both old and new future sources', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const connections: import('ws').WebSocket[] = []
    const activeScripts = new Map<string, string>()
    const futureSources = [
      'globalThis.__cordisxReconnectBootstrap?.("stale-generation")',
      'globalThis.__cordisxReconnectBootstrap?.("current-generation")',
    ] as const
    let futureSourceBuilds = 0
    let nextScript = 1
    let staleRemovalErrors = 0
    server.on('connection', connection => {
      const connectionIndex = connections.push(connection) - 1
      connection.on('message', data => {
        const request = JSON.parse(String(data)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        const params = request.params ?? {}
        let result: Record<string, unknown> = {}
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const identifier = `failed-removal-bootstrap-${nextScript++}`
          activeScripts.set(identifier, String(params.source))
          result = { identifier }
        } else if (request.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          const identifier = String(params.identifier)
          if (connectionIndex === 1 && identifier === 'failed-removal-bootstrap-1') {
            staleRemovalErrors += 1
            connection.send(JSON.stringify({
              id: request.id,
              error: { code: -32000, message: 'fixture stale script removal failed' },
            }))
            return
          }
          activeScripts.delete(identifier)
        } else if (request.method === 'Runtime.evaluate') {
          result = { result: { value: { ok: true } } }
        }
        connection.send(JSON.stringify({ id: request.id, result }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([{
          id: 'failed-removal-target',
          title: 'Codex',
          url: 'app://-/index.html',
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
        }]),
        { status: 200 },
      )
    ) as typeof fetch
    const ready = [deferred(), deferred()] as const
    let readyCount = 0
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'current-live-bootstrap',
      newDocumentSource: () => futureSources[Math.min(futureSourceBuilds++, 1)]!,
      signal: abort.signal,
      onReady: () => {
        ready[Math.min(readyCount++, 1)]!.resolve()
      },
    })
    try {
      await ready[0].promise
      connections[0]!.close()
      await once(connections[0]!, 'close')
      await ready[1].promise

      expect(staleRemovalErrors).toBe(1)
      expect(activeScripts).toEqual(
        new Map([
          ['failed-removal-bootstrap-1', futureSources[0]],
          ['failed-removal-bootstrap-2', futureSources[1]],
        ]),
      )
      const executed: string[] = []
      ;(globalThis as typeof globalThis & {
        __cordisxReconnectBootstrap?: (generation: string) => void
      }).__cordisxReconnectBootstrap = generation => {
        executed.push(generation)
      }
      for (const source of activeScripts.values()) Function(source)()
      expect(executed).toEqual(['stale-generation', 'current-generation'])
    } finally {
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      Reflect.deleteProperty(globalThis, '__cordisxReconnectBootstrap')
      expect(activeScripts).toEqual(new Map([['failed-removal-bootstrap-1', futureSources[0]]]))
      server.close()
      await once(server, 'close')
    }
  })
})
