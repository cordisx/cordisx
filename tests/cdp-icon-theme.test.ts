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

describe('icon theme preference document delivery', () => {
  it('requires an exact execution context and acknowledged document revision', () => {
    const params = iconThemePreferenceDeliveryEvaluation(
      { kind: 'sync', value: { revision: 9 } },
      'doc_epoch_9',
      9,
      73,
    )
    expect(params).toMatchObject({ contextId: 73, allowUnsafeEvalBlockedByCSP: true, returnByValue: true })
    expect(params.expression).toContain("typeof receiver !== 'function'")
    expect(params.expression).toContain('ack.documentEpoch')
    expect(params.expression).toContain('ack.currentRevision < 9')
    expect(params.expression).not.toContain('?.(')
  })

  it('replays the cached winner when the same CDP target reports a new document context', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-cdp-document-'))
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    const token = 'c'.repeat(64)
    const firstReady = deferred()
    const pendingSuccessResponse = deferred()
    const recoveredConflictResponse = deferred()
    const navigationConflictResponse = deferred()
    const secondWinner = deferred()
    const browserDocumentReady = deferred()
    let browserBridge: BrowserIconThemePreferenceBridge | undefined
    let permanentBrowserBridge: BrowserIconThemePreferenceBridge | undefined
    let socket: import('ws').WebSocket | undefined
    let bootRequestId: number | undefined
    let navigationResponseRequestId: number | undefined
    let contextOneDeliveryAttempts = 0
    let secondContextDeliveryAttempts = 0
    let destroyedSelectionResponses = 0
    let secondContextFirstRevision: number | undefined
    let secondContextPendingReady: Record<string, unknown> | undefined
    let permanentContextDeliveryAttempts = 0
    const permanentAttemptsByRevision = new Map<number, number>()
    let permanentContextPendingResponses = 0
    const permanentFirstPending = deferred()
    const permanentHigherWinnerCached = deferred()
    const permanentHigherDeliveryRound = deferred()
    let permanentHeldReadyRequestId: number | undefined
    let permanentHeldReadyPayload: Record<string, unknown> | undefined
    let syncPhase: 'initial-fail' | 'recovered' | 'conflict-fail' = 'initial-fail'
    const bindingResponses = new Map<string, Record<string, unknown>>()
    const contexts = new Map<number, { epoch: string; revision: number }>([
      [41, { epoch: 'document_epoch_one', revision: 0 }],
      [42, { epoch: 'document_epoch_two', revision: 0 }],
      [43, { epoch: 'document_epoch_permanent', revision: 0 }],
    ])
    const sendReady = (contextId: number): void => {
      const context = contexts.get(contextId)!
      socket?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: contextId,
          payload: JSON.stringify({
            version: 1,
            kind: 'document-ready',
            token,
            requestId: `ready-${contextId}`,
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-document-test' },
            documentEpoch: context.epoch,
            currentRevision: context.revision,
          }),
        },
      }))
    }
    server.on('connection', connection => {
      socket = connection
      connection.on('message', data => {
        const request = JSON.parse(String(data)) as {
          id: number
          method: string
          params?: { expression?: string; contextId?: number }
        }
        const respond = (result: Record<string, unknown>): void =>
          connection.send(JSON.stringify({ id: request.id, result }))
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          respond({ identifier: 'icon-theme-document-fixture' })
          return
        }
        if (request.method !== 'Runtime.evaluate') {
          respond({})
          return
        }
        const expression = request.params?.expression ?? ''
        if (expression.includes('globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot')) {
          bootRequestId = request.id
          sendReady(41)
          return
        }
        if (
          expression.includes('const receiver = globalThis.__cordisxIconThemePreferenceReceiveV1')
          && expression.includes('return ack')
        ) {
          const deliveryPayload = iconThemeReceiverPayload(expression)
          const contextId = request.params?.contextId
          const context = contextId === undefined ? undefined : contexts.get(contextId)
          if (context === undefined) {
            respond({ exceptionDetails: { text: 'context destroyed' } })
            return
          }
          const minimum = Number(expression.match(/ack\.currentRevision < ([0-9]+)/u)?.[1] ?? 0)
          if (contextId === 41 && deliveryPayload?.kind === 'sync' && minimum >= 1 && syncPhase !== 'recovered') {
            contextOneDeliveryAttempts += 1
            if (contextOneDeliveryAttempts % 2 === 1) {
              respond({ exceptionDetails: { text: 'icon theme receiver is unavailable' } })
            } else {
              respond({ result: { value: null } })
            }
            return
          }
          if (contextId === 42 && deliveryPayload?.kind === 'sync' && minimum >= 1) {
            secondContextDeliveryAttempts += 1
            if (secondContextFirstRevision === undefined) secondContextFirstRevision = minimum
            if (secondContextDeliveryAttempts <= 2) {
              respond({ result: { type: 'object', subtype: 'error', description: 'execution context was destroyed' } })
              if (secondContextDeliveryAttempts === 1 && navigationResponseRequestId !== undefined) {
                connection.send(JSON.stringify({
                  id: navigationResponseRequestId,
                  result: { exceptionDetails: { text: 'requester context navigated during conflict response' } },
                }))
                navigationResponseRequestId = undefined
                destroyedSelectionResponses += 1
              }
              return
            }
          }
          if (
            contextId === 43 && deliveryPayload?.kind === 'document-ready-probe'
            && permanentHeldReadyRequestId === undefined
          ) {
            permanentHeldReadyRequestId = request.id
            permanentHeldReadyPayload = deliveryPayload
            permanentFirstPending.resolve()
            return
          }
          if (contextId === 43 && deliveryPayload?.kind === 'sync' && minimum >= 1) {
            permanentContextDeliveryAttempts += 1
            permanentAttemptsByRevision.set(minimum, (permanentAttemptsByRevision.get(minimum) ?? 0) + 1)
            if (minimum === 3 && permanentAttemptsByRevision.get(3) === 2) permanentHigherDeliveryRound.resolve()
            respond({ exceptionDetails: { text: 'permanent document receiver failure' } })
            return
          }
          if (
            contextId === 43 && deliveryPayload?.kind === 'document-ready'
            && deliveryPayload.synchronization === 'pending'
          ) {
            permanentContextPendingResponses += 1
            const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(deliveryPayload))
            respond({ result: { value: ack } })
            return
          }
          if (contextId === 42 && deliveryPayload !== undefined) {
            if (deliveryPayload.kind === 'document-ready' && deliveryPayload.synchronization === 'pending') {
              secondContextPendingReady = deliveryPayload
            }
            const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(deliveryPayload))
            if (ack === undefined) {
              respond({ exceptionDetails: { text: 'browser document receiver is unavailable' } })
              return
            }
            context.revision = Math.max(context.revision, ack.currentRevision)
            respond({ result: { value: ack } })
            if (deliveryPayload.kind === 'sync' && context.revision >= 2) secondWinner.resolve()
            return
          }
          context.revision = Math.max(context.revision, minimum)
          respond({
            result: {
              value: {
                documentEpoch: context.epoch,
                currentRevision: context.revision,
                ...readyLeaseEcho(deliveryPayload),
              },
            },
          })
          if (contextId === 41 && context.revision === 0 && bootRequestId !== undefined) {
            connection.send(JSON.stringify({ id: bootRequestId, result: { result: { value: { ok: true } } } }))
            bootRequestId = undefined
            firstReady.resolve()
          } else if (contextId === 42 && context.revision >= 2) {
            secondWinner.resolve()
          }
          return
        }
        if (expression.includes('const receiver = globalThis.__cordisxIconThemePreferenceReceiveV1')) {
          const payload = iconThemeReceiverPayload(expression)
          const responseRequestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined
          if (responseRequestId !== undefined) bindingResponses.set(responseRequestId, payload!)
          if (responseRequestId === 'select-winner') {
            respond({ result: { value: true } })
            pendingSuccessResponse.resolve()
            return
          }
          if (responseRequestId === 'recover-winner') {
            respond({ result: { value: true } })
            recoveredConflictResponse.resolve()
            return
          }
          if (responseRequestId === 'conflict-navigation') {
            navigationResponseRequestId = request.id
            void browserBridge?.ready().then(browserDocumentReady.resolve)
            navigationConflictResponse.resolve()
            return
          }
          if (responseRequestId === 'permanent-higher-conflict') {
            respond({ result: { value: true } })
            permanentHigherWinnerCached.resolve()
            return
          }
          respond({ result: { value: true } })
          return
        }
        respond({ result: { value: undefined } })
      })
    })
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const originalReserve = hub.reserve.bind(hub)
    const contextTwoReadyFinalized = deferred()
    vi.spyOn(hub, 'reserve').mockImplementation(identity => {
      const reservation = originalReserve(identity)
      return {
        cancel: reservation.cancel,
        register: async receiver => {
          const registration = await reservation.register(receiver)
          return {
            get currentRevision() {
              return registration.currentRevision
            },
            get synchronization() {
              return registration.synchronization
            },
            respondReady: async (probeAck, respond) => {
              const status = await registration.respondReady(probeAck, respond)
              if (identity.executionContextId === 42 && status.synchronization === 'complete') {
                contextTwoReadyFinalized.resolve()
              }
              return status
            },
            unregister: registration.unregister,
          }
        },
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([{
          id: 'same-target',
          title: 'Codex',
          url: 'app://-/index.html',
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
        }]),
        { status: 200 },
      )
    ) as typeof fetch
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'void 0',
      signal: abort.signal,
      iconThemePreferencePersistence: {
        configPath,
        appId: 'codex',
        profileId: 'default',
        hostGeneration: 'host-document-test',
        token,
      },
      iconThemePreferenceBroadcastHub: hub,
    })
    try {
      await firstReady.promise
      const sendSelection = (
        requestId: string,
        expectedPreferenceRevision: number,
        expectedProfileRevision: number,
      ): void =>
        socket?.send(JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: {
            name: ICON_THEME_PREFERENCE_BINDING,
            executionContextId: 41,
            payload: JSON.stringify({
              version: 1,
              token,
              requestId,
              scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-document-test' },
              expectedPreferenceRevision,
              expectedProfileRevision,
              selectedProfileRevision: expectedProfileRevision + 1,
              candidate: {
                providerId: 'builtin:reicon',
                namespace: 'reicon',
                providerVersion: '1.2.1',
                providerGeneration: 'reicon-1.2.1',
              },
            }),
          },
        }))

      sendSelection('select-winner', 0, 0)
      await pendingSuccessResponse.promise
      expect((await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme?.revision).toBe(1)
      expect(bindingResponses.get('select-winner')).toMatchObject({
        ok: true,
        value: { revision: 1 },
        synchronization: 'pending',
      })
      expect(contextOneDeliveryAttempts).toBe(2)

      // The same durable revision is an explicit retry trigger for a recovered
      // receiver; the stale write remains a conflict, but convergence completes.
      syncPhase = 'recovered'
      sendSelection('recover-winner', 0, 1)
      await recoveredConflictResponse.promise
      expect(bindingResponses.get('recover-winner')).toMatchObject({
        ok: false,
        code: 'conflict',
        currentPreference: { revision: 1 },
        synchronization: 'complete',
      })
      expect(contexts.get(41)?.revision).toBe(1)

      // Simulate a durable writer that advanced while this process-local hub
      // was still at revision 1. The real conflict handler must cache revision
      // 2 before attempting its response. The fake renderer navigates at that
      // response boundary and reports a fresh execution context immediately.
      await updateHomeConfigAtomic(current => ({
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              default: {
                ...current.apps.codex!.profiles.default!,
                iconTheme: {
                  revision: 2,
                  providerId: 'plugin:aurora:aurora',
                  namespace: 'aurora',
                  providerVersion: '2.1.0',
                  providerGeneration: 'aurora-3',
                },
              },
            },
          },
        },
      }), configPath)
      syncPhase = 'conflict-fail'
      contextOneDeliveryAttempts = 0
      globalThis.__cordisxIconThemePreferenceRequestV1 = payload => {
        const ready = JSON.parse(payload) as { documentEpoch?: string }
        if (typeof ready.documentEpoch === 'string') {
          contexts.set(42, { epoch: ready.documentEpoch, revision: contexts.get(42)?.revision ?? 0 })
        }
        socket?.send(JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: { name: ICON_THEME_PREFERENCE_BINDING, executionContextId: 42, payload },
        }))
      }
      browserBridge = new BrowserIconThemePreferenceBridge(
        token,
        'codex',
        'default',
        'host-document-test',
        undefined,
      )
      sendSelection('conflict-navigation', 1, 2)
      await navigationConflictResponse.promise
      await secondWinner.promise
      await browserDocumentReady.promise
      await contextTwoReadyFinalized.promise

      expect(bindingResponses.get('conflict-navigation')).toMatchObject({
        ok: false,
        code: 'conflict',
        currentPreference: { revision: 2 },
        synchronization: 'pending',
      })
      expect(secondContextFirstRevision).toBe(2)
      expect(contexts.get(42)).toMatchObject({ revision: 2 })
      expect(contexts.get(42)?.epoch).toMatch(/^doc_/u)
      expect(secondContextPendingReady).toMatchObject({
        synchronization: 'pending',
        requiredRevision: 2,
        currentRevision: 0,
      })
      expect(secondContextDeliveryAttempts).toBe(3)
      expect(destroyedSelectionResponses).toBeGreaterThanOrEqual(1)

      browserBridge.dispose()
      browserBridge = undefined
      globalThis.__cordisxIconThemePreferenceRequestV1 = payload => {
        const ready = JSON.parse(payload) as { documentEpoch?: string }
        if (typeof ready.documentEpoch === 'string') contexts.set(43, { epoch: ready.documentEpoch, revision: 0 })
        socket?.send(JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: { name: ICON_THEME_PREFERENCE_BINDING, executionContextId: 43, payload },
        }))
      }
      permanentBrowserBridge = new BrowserIconThemePreferenceBridge(
        token,
        'codex',
        'default',
        'host-document-test',
        undefined,
      )
      const permanentlyPending = permanentBrowserBridge.ready()
      await permanentFirstPending.promise
      await updateHomeConfigAtomic(current => ({
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              default: {
                ...current.apps.codex!.profiles.default!,
                iconTheme: {
                  revision: 3,
                  providerId: 'builtin:reicon',
                  namespace: 'reicon',
                  providerVersion: '1.2.1',
                  providerGeneration: 'reicon-1.2.1',
                },
              },
            },
          },
        },
      }), configPath)
      socket?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 44,
          payload: JSON.stringify({
            version: 1,
            token,
            requestId: 'permanent-higher-conflict',
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-document-test' },
            expectedPreferenceRevision: 2,
            expectedProfileRevision: 3,
            selectedProfileRevision: 4,
            candidate: {
              providerId: 'plugin:aurora:aurora',
              namespace: 'aurora',
              providerVersion: '2.1.0',
              providerGeneration: 'aurora-3',
            },
          }),
        },
      }))
      await permanentHigherWinnerCached.promise
      await permanentHigherDeliveryRound.promise
      const heldReadyAck = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(permanentHeldReadyPayload))
      socket?.send(JSON.stringify({
        id: permanentHeldReadyRequestId,
        result: { result: { value: heldReadyAck } },
      }))
      await expect(permanentlyPending).rejects.toThrow('remains pending at revision 0; required 3')
      expect(permanentAttemptsByRevision.get(2)).toBeUndefined()
      expect(permanentAttemptsByRevision.get(3)).toBe(8)
      expect(permanentContextDeliveryAttempts).toBe(
        [...permanentAttemptsByRevision.values()].reduce((total, attempts) => total + attempts, 0),
      )
      expect(permanentContextPendingResponses).toBe(3)
    } finally {
      browserBridge?.dispose()
      permanentBrowserBridge?.dispose()
      Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceRequestV1')
      Reflect.deleteProperty(globalThis, '__cordisxIconThemePreferenceReceiveV1')
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })
})
