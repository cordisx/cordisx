import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  CdpLifecycleRequestGate,
  CdpPluginLifecycleRuntime,
  iconThemePreferenceDeliveryEvaluation,
  injectableTargets,
  serviceConfigResponseEvaluation,
  watchAndInject,
  type CdpTarget,
} from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PluginPermissionIdentityRegistry } from '../packages/cli/src/launcher/permission-rpc.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { ICON_THEME_PREFERENCE_BINDING } from '../packages/cli/src/launcher/icon-theme-rpc.js'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'

function target(id: string, title: string, url = 'https://example.test/'): CdpTarget {
  return { id, title, url, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}` }
}

function deferred<Value = void>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => { resolve = done })
  return { promise, resolve }
}

function iconThemeReceiverPayload(expression: string): Record<string, unknown> | undefined {
  const encoded = expression.match(/receiver\(((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\)/u)?.[1]
  if (encoded === undefined) return undefined
  try { return JSON.parse(JSON.parse(encoded) as string) as Record<string, unknown> } catch { return undefined }
}

describe('injectableTargets', () => {
  it('keeps Codex renderer pages and excludes unrelated Electron pages', () => {
    expect(injectableTargets([
      target('settings', 'Settings'),
      target('codex', 'Codex'),
      target('avatar', 'Codex', 'app://-/index.html?initialRoute=%2Favatar-overlay'),
      target('auth', 'Authentication'),
    ]).map(item => item.id)).toEqual(['codex'])
  })

  it('fails closed when branding is absent instead of injecting an unrelated page', () => {
    expect(injectableTargets([
      target('first', 'Desktop'),
      target('second', 'Settings'),
    ])).toEqual([])
  })
})

describe('service config CDP responses', () => {
  it('returns to the exact execution context that issued the binding request', () => {
    const params = serviceConfigResponseEvaluation({ requestId: 'request-1', ok: true, value: [] }, 73)
    expect(params).toMatchObject({ contextId: 73, allowUnsafeEvalBlockedByCSP: true, returnByValue: true })
    expect(params.expression).toContain('__cordisxServiceConfigReceiveV1')
    expect(serviceConfigResponseEvaluation({ requestId: 'request-2', ok: false })).not.toHaveProperty('contextId')
  })
})

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
    let permanentContextPendingResponses = 0
    const permanentFirstPending = deferred()
    const permanentHigherWinnerCached = deferred()
    let permanentHeldReadyRequestId: number | undefined
    let permanentHeldReadyAck: { documentEpoch: string; currentRevision: number } | undefined
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
        const respond = (result: Record<string, unknown>): void => connection.send(JSON.stringify({ id: request.id, result }))
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          respond({ identifier: 'icon-theme-document-fixture' })
          return
        }
        if (request.method !== 'Runtime.evaluate') {
          respond({})
          return
        }
        const expression = request.params?.expression ?? ''
        if (expression.includes('await globalThis.__cordisxBoot')) {
          bootRequestId = request.id
          sendReady(41)
          return
        }
        if (expression.includes('const receiver = globalThis.__cordisxIconThemePreferenceReceiveV1')
          && expression.includes('return ack')) {
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
          if (contextId === 43 && deliveryPayload?.kind === 'sync' && minimum >= 1) {
            permanentContextDeliveryAttempts += 1
            respond({ exceptionDetails: { text: 'permanent document receiver failure' } })
            return
          }
          if (contextId === 43 && deliveryPayload?.kind === 'document-ready'
            && deliveryPayload.synchronization === 'pending') {
            permanentContextPendingResponses += 1
            const ack = globalThis.__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(deliveryPayload))
            if (permanentContextPendingResponses === 1) {
              permanentHeldReadyRequestId = request.id
              permanentHeldReadyAck = ack
              permanentFirstPending.resolve()
              return
            }
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
          respond({ result: { value: { documentEpoch: context.epoch, currentRevision: context.revision } } })
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
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'same-target', title: 'Codex', url: 'app://-/index.html', type: 'page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
    }]), { status: 200 })) as typeof fetch
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
    })
    try {
      await firstReady.promise
      const sendSelection = (
        requestId: string,
        expectedPreferenceRevision: number,
        expectedProfileRevision: number,
      ): void => socket?.send(JSON.stringify({
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
              providerId: 'builtin:reicon', namespace: 'reicon', providerVersion: '1.2.1', providerGeneration: 'reicon-1.2.1',
            },
          }),
        },
      }))

      sendSelection('select-winner', 0, 0)
      await pendingSuccessResponse.promise
      expect((await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme?.revision).toBe(1)
      expect(bindingResponses.get('select-winner')).toMatchObject({
        ok: true, value: { revision: 1 }, synchronization: 'pending',
      })
      expect(contextOneDeliveryAttempts).toBe(2)

      // The same durable revision is an explicit retry trigger for a recovered
      // receiver; the stale write remains a conflict, but convergence completes.
      syncPhase = 'recovered'
      sendSelection('recover-winner', 0, 1)
      await recoveredConflictResponse.promise
      expect(bindingResponses.get('recover-winner')).toMatchObject({
        ok: false, code: 'conflict', currentPreference: { revision: 1 }, synchronization: 'complete',
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
        if (typeof ready.documentEpoch === 'string') contexts.set(42, { epoch: ready.documentEpoch, revision: contexts.get(42)?.revision ?? 0 })
        socket?.send(JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: { name: ICON_THEME_PREFERENCE_BINDING, executionContextId: 42, payload },
        }))
      }
      browserBridge = new BrowserIconThemePreferenceBridge(
        token, 'codex', 'default', 'host-document-test', undefined,
      )
      sendSelection('conflict-navigation', 1, 2)
      await navigationConflictResponse.promise
      await secondWinner.promise
      await browserDocumentReady.promise

      expect(bindingResponses.get('conflict-navigation')).toMatchObject({
        ok: false, code: 'conflict', currentPreference: { revision: 2 }, synchronization: 'pending',
      })
      expect(secondContextFirstRevision).toBe(2)
      expect(contexts.get(42)).toMatchObject({ revision: 2 })
      expect(contexts.get(42)?.epoch).toMatch(/^doc_/u)
      expect(secondContextPendingReady).toMatchObject({
        synchronization: 'pending', requiredRevision: 2, currentRevision: 0,
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
        token, 'codex', 'default', 'host-document-test', undefined,
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
              providerId: 'plugin:aurora:aurora', namespace: 'aurora', providerVersion: '2.1.0', providerGeneration: 'aurora-3',
            },
          }),
        },
      }))
      await permanentHigherWinnerCached.promise
      socket?.send(JSON.stringify({
        id: permanentHeldReadyRequestId,
        result: { result: { value: permanentHeldReadyAck } },
      }))
      await expect(permanentlyPending).rejects.toThrow('remains pending at revision 0; required 3')
      expect(permanentContextDeliveryAttempts).toBe(8)
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

  it('revokes a held old execution context before a new document replays the cached winner', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-cdp-replacement-'))
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
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
    const token = 'd'.repeat(64)
    const installed = deferred()
    const cacheReady = deferred()
    const oldDeliveryHeld = deferred()
    const newReplayStarted = deferred()
    const newDocumentComplete = deferred()
    const repeatedDocumentComplete = deferred()
    const targetCloseDeliveryHeld = deferred()
    let connectionRef: import('ws').WebSocket | undefined
    let heldOldRequestId: number | undefined
    let context52SyncCount = 0
    let context52CompleteCount = 0
    const epochs = new Map<number, string>([
      [51, 'document_epoch_old'],
      [52, 'document_epoch_new'],
      [53, 'document_epoch_close'],
    ])
    const sendReady = (contextId: number, currentRevision: number): void => connectionRef?.send(JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: ICON_THEME_PREFERENCE_BINDING,
        executionContextId: contextId,
        payload: JSON.stringify({
          version: 1,
          kind: 'document-ready',
          token,
          requestId: `ready-${contextId}-${currentRevision}-${context52CompleteCount}`,
          scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-replacement-test' },
          documentEpoch: epochs.get(contextId),
          currentRevision,
        }),
      },
    }))
    server.on('connection', connection => {
      connectionRef = connection
      connection.on('message', data => {
        const request = JSON.parse(String(data)) as {
          id: number
          method: string
          params?: { expression?: string; contextId?: number }
        }
        const respond = (result: Record<string, unknown>): void => connection.send(JSON.stringify({ id: request.id, result }))
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          respond({ identifier: 'icon-theme-replacement-fixture' })
          return
        }
        if (request.method !== 'Runtime.evaluate') {
          respond({})
          return
        }
        const expression = request.params?.expression ?? ''
        if (expression.includes('await globalThis.__cordisxBoot')) {
          respond({ result: { value: { ok: true } } })
          installed.resolve()
          return
        }
        if (!expression.includes('const receiver = globalThis.__cordisxIconThemePreferenceReceiveV1')) {
          respond({ result: { value: undefined } })
          return
        }
        const payload = iconThemeReceiverPayload(expression)
        const contextId = request.params?.contextId
        if (payload?.kind === 'sync') {
          if (contextId === 51) {
            heldOldRequestId = request.id
            oldDeliveryHeld.resolve()
            return
          }
          if (contextId === 52) {
            context52SyncCount += 1
            newReplayStarted.resolve()
            respond({ result: { value: { documentEpoch: epochs.get(52), currentRevision: 2 } } })
            return
          }
          if (contextId === 53) {
            targetCloseDeliveryHeld.resolve()
            return
          }
        }
        if (payload?.kind === 'document-ready') {
          const currentRevision = Number(payload.currentRevision ?? 0)
          respond({ result: { value: { documentEpoch: epochs.get(contextId!), currentRevision } } })
          if (contextId === 52 && payload.synchronization === 'complete') {
            context52CompleteCount += 1
            if (context52CompleteCount === 1) newDocumentComplete.resolve()
            else repeatedDocumentComplete.resolve()
          }
          return
        }
        if (payload?.requestId === 'cache-conflict') {
          respond({ result: { value: true } })
          cacheReady.resolve()
          return
        }
        respond({ result: { value: true } })
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'same-target', title: 'Codex', url: 'app://-/index.html', type: 'page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
    }]), { status: 200 })) as typeof fetch
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'void 0',
      signal: abort.signal,
      iconThemePreferencePersistence: {
        configPath,
        appId: 'codex',
        profileId: 'default',
        hostGeneration: 'host-replacement-test',
        token,
      },
    })
    try {
      await installed.promise
      connectionRef?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 50,
          payload: JSON.stringify({
            version: 1,
            token,
            requestId: 'cache-conflict',
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-replacement-test' },
            expectedPreferenceRevision: 1,
            expectedProfileRevision: 0,
            selectedProfileRevision: 1,
            candidate: {
              providerId: 'builtin:reicon', namespace: 'reicon', providerVersion: '1.2.1', providerGeneration: 'reicon-1.2.1',
            },
          }),
        },
      }))
      await cacheReady.promise

      sendReady(51, 1)
      await oldDeliveryHeld.promise
      sendReady(52, 1)
      await newReplayStarted.promise
      await newDocumentComplete.promise
      expect(heldOldRequestId).toBeTypeOf('number')
      expect(context52SyncCount).toBe(1)

      connectionRef?.send(JSON.stringify({
        id: heldOldRequestId,
        result: { result: { value: { documentEpoch: epochs.get(51), currentRevision: 2 } } },
      }))
      sendReady(52, 2)
      await repeatedDocumentComplete.promise
      expect(context52SyncCount).toBe(1)

      sendReady(53, 1)
      await targetCloseDeliveryHeld.promise
      abort.abort()
      await watching
    } finally {
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })
})

function activation(revision: number, generation: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 0 ? 'active' : 'candidate',
    ...(revision === 0 ? {} : { transactionId: 'tx' }),
    profileId: 'work',
    revision,
    lastGoodRevision: 0,
    runtimeGeneration: 'runtime-1',
    plugins: [{ id: 'demo', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, moduleGeneration: generation, enabled: revision === 0, dependencies: [] }],
  }
}

describe('CdpPluginLifecycleRuntime', () => {
  it('replays a newer local-development state before atomically committing a joining renderer', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const sourcePath = '/absolute/plugin/join-state.ts'
    await runtime.updateDevelopmentStatus({
      origin: 'local-dev', pluginId: 'join-state', sourcePath, state: 'ready',
    })
    let releaseReady!: () => void
    let readyStarted!: () => void
    const readyGate = new Promise<void>(resolve => { releaseReady = resolve })
    const readyObserved = new Promise<void>(resolve => { readyStarted = resolve })
    const expressions: string[] = []
    const session = {
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        expressions.push(expression)
        if (expression.includes('"state":"ready"')) {
          readyStarted()
          await readyGate
        }
        return { result: { value: { ok: true, result: true } } }
      },
    }
    const join = runtime.beginJoin(session as never)
    const synchronizing = runtime.synchronizeDevelopmentStatus(session as never)
    await readyObserved
    await runtime.updateDevelopmentStatus({
      origin: 'local-dev', pluginId: 'join-state', sourcePath, state: 'failed', error: 'new failure',
    })
    releaseReady()
    const version = await synchronizing
    const unregister = join.commit(version)
    expect(unregister).toBeTypeOf('function')
    expect(expressions.filter(expression => expression.includes('updateLocalDevelopmentStatus'))).toHaveLength(2)
    expect(expressions.at(-1)).toContain('"state":"failed"')
    expect(expressions.at(-1)).toContain('new failure')
    unregister?.()
  })

  it('joins a booting renderer only after readiness and retries when a generation fence wins the race', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const unregisterExisting = runtime.register({ send: async () => ({}) } as never)
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    let releaseBoot!: () => void
    let bootBlocked = true
    const bootGate = new Promise<void>(resolve => { releaseBoot = resolve })
    server.on('connection', socket => {
      socket.on('message', data => {
        void (async () => {
          const request = JSON.parse(String(data)) as { id: number; method: string; params?: { expression?: string } }
          if (request.method === 'Runtime.evaluate'
            && request.params?.expression?.includes('await globalThis.__cordisxBoot') === true
            && bootBlocked) await bootGate
          const result = request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: `fixture-${request.id}` }
            : request.method === 'Runtime.evaluate'
              ? { result: { value: { ok: true, result: true } } }
              : {}
          socket.send(JSON.stringify({ id: request.id, result }))
        })()
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'joining-renderer', title: 'Codex', url: 'app://-/index.html', type: 'page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
    }]), { status: 200 })) as typeof fetch
    const statuses: string[] = []
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'void 0',
      signal: abort.signal,
      developmentRuntime: runtime,
      onStatus: message => { statuses.push(message) },
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      const fence = runtime.prepare('join-race')
      expect(fence.expectedRegistryEpoch).toBe(0)
      releaseBoot()
      bootBlocked = false
      for (let attempt = 0; attempt < 50 && !statuses.some(item => item.includes('during a plugin generation transaction')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(statuses).toContainEqual(expect.stringContaining('during a plugin generation transaction'))
      runtime.cancelPreparation('join-race')
      for (let attempt = 0; attempt < 80 && !statuses.some(item => item.includes('injected target joining-renderer')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(statuses).toContainEqual(expect.stringContaining('injected target joining-renderer'))
    } finally {
      abort.abort()
      await watching
      unregisterExisting()
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('uses a join reservation to recover a durable rollback on the first cold-start renderer', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    const tuple = (record: CordisXPluginActivationRecordV1) => ({
      profileId: record.profileId,
      revision: record.revision,
      lastGoodRevision: record.lastGoodRevision,
      runtimeGeneration: record.runtimeGeneration,
      plugins: record.plugins,
    })
    const plan: RollbackPlan = {
      transactionId: 'cold-recovery',
      transactionEpoch: 'cold-recovery:formal',
      rollbackToken: 'rollback:cold-recovery' as RollbackPlan['rollbackToken'],
      candidateFingerprint: 'cold-recovery-fingerprint',
      expectedPublished: tuple(candidate),
      rollbackTarget: tuple(previous),
      expectedRegistryEpoch: 0,
      rollbackRegistryEpoch: 2,
    }
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
    server.on('connection', socket => {
      socket.on('message', data => {
        void (async () => {
          const request = JSON.parse(String(data)) as { id: number; method: string; params?: { expression?: string } }
          const expression = request.params?.expression ?? ''
          const result = request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: `cold-${request.id}` }
            : request.method !== 'Runtime.evaluate'
              ? {}
              : expression.includes('recoverPluginMutation')
                ? { result: { value: { ok: true, result: {
                    transactionId: plan.transactionId,
                    transactionEpoch: plan.transactionEpoch,
                    registryEpoch: plan.rollbackRegistryEpoch,
                    active: previous,
                    disposedAfter: candidate,
                  } } } }
                : { result: { value: { ok: true, result: true } } }
          socket.send(JSON.stringify({ id: request.id, result }))
        })()
      })
    })
    let recovered = false
    const handler = {
      coordinator: {
        recover: async () => {
          const observation = await runtime.recoverRollback(plan)
          const restored = { ...observation.active, recordKind: 'active' as const, revision: 2 }
          await runtime.adoptRecoveredActivation(restored, observation.registryEpoch)
          recovered = true
          return [plan.transactionId]
        },
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'cold-renderer', title: 'Codex', url: 'app://-/index.html', type: 'page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
    }]), { status: 200 })) as typeof fetch
    const statuses: string[] = []
    const abort = new AbortController()
    const watching = watchAndInject({
      port: address.port,
      source: 'void 0',
      signal: abort.signal,
      pluginLifecycle: { handler: handler as never, runtime },
      onStatus: message => { statuses.push(message) },
    })
    try {
      for (let attempt = 0; attempt < 80 && !statuses.some(item => item.includes('injected target cold-renderer')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(recovered).toBe(true)
      expect(statuses).toContainEqual(expect.stringContaining('injected target cold-renderer'))
      expect(runtime.prepare('after-cold-recovery')).toMatchObject({ expectedRegistryEpoch: 2 })
      runtime.cancelPreparation('after-cold-recovery')
    } finally {
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  })

  it('removes a closed development renderer and refuses a replacement until the generation fence clears', () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const first = { send: async () => ({}) } as never
    const second = { send: async () => ({}) } as never
    const unregisterFirst = runtime.register(first)
    const fence = runtime.prepare('in-flight')
    expect(fence.expectedRegistryEpoch).toBe(0)
    expect(() => runtime.register(second)).toThrow('cannot register a CordisX renderer during a plugin generation transaction')
    runtime.cancelPreparation('in-flight')
    const unregisterSecond = runtime.register(second)
    unregisterSecond()
    unregisterFirst()
    expect(() => runtime.prepare('after-target-close')).toThrow('no ready CordisX renderer is available')
  })

  it('projects first-build local diagnostics without requiring a formal lifecycle bridge', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const expressions: string[] = []
    runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        expressions.push(String(params.expression ?? ''))
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    await runtime.updateDevelopmentStatus({
      origin: 'local-dev',
      pluginId: 'broken',
      sourcePath: '/absolute/plugin/broken.ts',
      state: 'failed',
      error: 'fixture build failed',
    })
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('updateLocalDevelopmentStatus')
    expect(expressions[0]).toContain('/absolute/plugin/broken.ts')
  })

  it('stages every renderer before reporting one failure so the closure can roll back everywhere', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    const stageCalls = [0, 0]
    const session = (index: number, fail: boolean) => ({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) {
          stageCalls[index]! += 1
          return { result: { value: fail ? { ok: false, error: 'fixture readiness failure' } : {
            ok: true,
            result: { transactionId: 'tx', transactionEpoch: 'tx:formal', expectedRegistryEpoch: 0, afterRegistryEpoch: 1 },
          } } }
        }
        if (expression.includes('rollbackPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch: 'tx:formal', registryEpoch: 2, active: previous, disposedAfter: candidate,
        } } } }
        return {}
      },
    })
    runtime.register(session(0, false) as never)
    runtime.register(session(1, true) as never)
    const fence = runtime.prepare('tx')
    const mutation: PluginRuntimeMutation = {
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'disable',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
    }
    await expect(runtime.stage(mutation)).rejects.toThrow('fixture readiness failure')
    expect(stageCalls).toEqual([1, 1])
    await expect(runtime.rollback('tx')).resolves.toMatchObject({ registryEpoch: 2, active: previous, disposedAfter: candidate })
    expect(runtime.prepare('tx-after-rollback')).toMatchObject({ expectedRegistryEpoch: 2 })
  })

  it('releases an empty staged transaction when its last renderer closes before rollback', async () => {
    const permissions = new PluginPermissionIdentityRegistry([{ id: 'demo', source: 'file:///demo-old.js' }])
    const runtime = new CdpPluginLifecycleRuntime(permissions)
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        return { result: { value: undefined } }
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    const mutation: PluginRuntimeMutation = {
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      package: {
        manifest: { id: 'demo' },
        digest: `sha256:${'b'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///demo-new.js',
      } as never,
    }
    await runtime.stage(mutation)
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(true)

    unregister()
    await expect(runtime.rollback('tx')).resolves.toEqual({
      transactionId: 'tx',
      transactionEpoch,
      registryEpoch: 2,
      active: previous,
      disposedAfter: candidate,
    })
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-old.js' })).toBe(true)
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(false)

    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    expect(runtime.prepare('replacement')).toMatchObject({ expectedRegistryEpoch: 2 })
    runtime.cancelPreparation('replacement')
    unregisterReplacement()
  })

  it('retains a failed finalize for rollback before admitting a replacement renderer', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        if (expression.includes('publishPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate,
        } } } }
        if (expression.includes('completePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate, disposedAfter: previous,
        } } } }
        if (expression.includes('finalizePluginMutation')) return { result: { value: { ok: false, error: 'fixture finalize failure' } } }
        if (expression.includes('rollbackPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 2, active: previous, disposedAfter: candidate,
        } } } }
        return {}
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
      targetId: 'demo', affectedPluginIds: ['demo'],
    })
    await runtime.publish('tx')
    await runtime.complete('tx')
    await expect(runtime.finalize('tx')).rejects.toThrow('fixture finalize failure')
    expect(() => runtime.register({ send: async () => ({}) } as never)).toThrow('during a plugin generation transaction')

    await expect(runtime.rollback('tx')).resolves.toMatchObject({ registryEpoch: 2, active: previous, disposedAfter: candidate })
    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    expect(runtime.prepare('replacement-finalize')).toMatchObject({ expectedRegistryEpoch: 2 })
    runtime.cancelPreparation('replacement-finalize')
    unregisterReplacement()
    unregister()
  })

  it('fails closed on live renderer rollback and abort errors until a retry proves the terminal state', async () => {
    for (const terminal of ['rollback', 'abort'] as const) {
      const permissions = new PluginPermissionIdentityRegistry([{ id: 'demo', source: 'file:///demo-old.js' }])
      const runtime = new CdpPluginLifecycleRuntime(permissions)
      const previous = activation(0, 'demo-old')
      const candidate = activation(1, 'demo-new')
      let transactionEpoch = ''
      let terminalAttempts = 0
      const unregister = runtime.register({
        async send(_method: string, params: Record<string, unknown>) {
          const expression = String(params.expression ?? '')
          if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
            transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
          } } } }
          if (expression.includes(`${terminal}PluginMutation`)) {
            terminalAttempts += 1
            if (terminalAttempts === 1) return { result: { value: { ok: false, error: `fixture ${terminal} failure` } } }
            return { result: { value: { ok: true, result: terminal === 'rollback' ? {
              transactionId: 'tx', transactionEpoch, registryEpoch: 0, active: previous, disposedAfter: candidate,
            } : true } } }
          }
          return {}
        },
      } as never)
      const fence = runtime.prepare('tx')
      transactionEpoch = fence.transactionEpoch
      await runtime.stage({
        transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
        targetId: 'demo', affectedPluginIds: ['demo'],
        ...(terminal === 'rollback' ? { package: {
          manifest: { id: 'demo' }, digest: `sha256:${'b'.repeat(64)}`, moduleSource: '', artifactSource: 'void 0',
          serviceModules: [], identitySource: 'file:///demo-new.js',
        } as never } : {}),
      })
      if (terminal === 'rollback') expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(true)
      const terminate = async (): Promise<unknown> => terminal === 'rollback' ? await runtime.rollback('tx') : await runtime.abort('tx')
      await expect(terminate()).rejects.toThrow(`fixture ${terminal} failure`)
      expect(() => runtime.register({ send: async () => ({}) } as never)).toThrow('during a plugin generation transaction')
      expect(() => runtime.prepare(`overlap-${terminal}`)).toThrow('another plugin generation transaction is unresolved')
      if (terminal === 'rollback') expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(true)
      if (terminal === 'rollback') await expect(terminate()).resolves.toMatchObject({ active: previous, disposedAfter: candidate })
      else await expect(terminate()).resolves.toBeUndefined()
      if (terminal === 'rollback') expect(permissions.allowed({ id: 'demo', source: 'file:///demo-old.js' })).toBe(true)

      const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
      expect(runtime.prepare(`replacement-${terminal}`)).toMatchObject({ expectedRegistryEpoch: 0 })
      runtime.cancelPreparation(`replacement-${terminal}`)
      unregisterReplacement()
      unregister()
    }
  })

  it('retains a live transaction when renderer rollback observations disagree', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const session = (active: CordisXPluginActivationRecordV1) => ({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        if (expression.includes('rollbackPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 0, active,
          disposedAfter: active === previous ? candidate : previous,
        } } } }
        return {}
      },
    })
    const unregisterPrevious = runtime.register(session(previous) as never)
    const unregisterDivergent = runtime.register(session(candidate) as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
      targetId: 'demo', affectedPluginIds: ['demo'],
    })
    await expect(runtime.rollback('tx')).rejects.toThrow('rollback observations disagree')
    expect(() => runtime.register({ send: async () => ({}) } as never)).toThrow('during a plugin generation transaction')

    unregisterDivergent()
    await expect(runtime.rollback('tx')).resolves.toMatchObject({ active: previous, disposedAfter: candidate })
    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    unregisterReplacement()
    unregisterPrevious()
  })

  it('advances the rollback epoch when the published renderer closes before cleanup', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        if (expression.includes('publishPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate,
        } } } }
        return {}
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
      targetId: 'demo', affectedPluginIds: ['demo'],
    })
    await expect(runtime.publish('tx')).resolves.toMatchObject({ registryEpoch: 1, active: candidate })

    unregister()
    await expect(runtime.complete('tx')).rejects.toThrow('cleanup observations disagree')
    await expect(runtime.rollback('tx')).resolves.toMatchObject({ registryEpoch: 2, active: previous, disposedAfter: candidate })
    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    expect(runtime.prepare('replacement-after-publish')).toMatchObject({ expectedRegistryEpoch: 2 })
    runtime.cancelPreparation('replacement-after-publish')
    unregisterReplacement()
  })

  it('recovers a rollback plan in a fresh renderer and adopts the restored durable revision', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    const expressions: string[] = []
    const session = {
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        expressions.push(expression)
        if (expression.includes('recoverPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch: 'tx:formal', registryEpoch: 2,
          active: previous, disposedAfter: candidate,
        } } } }
        if (expression.includes('adoptRecoveredActivation')) return { result: { value: { ok: true } } }
        return {}
      },
    }
    runtime.register(session as never)
    const tuple = (record: CordisXPluginActivationRecordV1) => ({
      profileId: record.profileId,
      revision: record.revision,
      lastGoodRevision: record.lastGoodRevision,
      runtimeGeneration: record.runtimeGeneration,
      plugins: record.plugins,
    })
    const plan: RollbackPlan = {
      transactionId: 'tx',
      transactionEpoch: 'tx:formal',
      rollbackToken: 'rollback:test' as RollbackPlan['rollbackToken'],
      candidateFingerprint: 'candidate-fingerprint',
      expectedPublished: tuple(candidate),
      rollbackTarget: tuple(previous),
      expectedRegistryEpoch: 0,
      rollbackRegistryEpoch: 2,
    }
    await expect(runtime.recoverRollback(plan)).resolves.toMatchObject({
      transactionId: 'tx', registryEpoch: 2, active: previous, disposedAfter: candidate,
    })
    const restored = { ...previous, recordKind: 'active' as const, revision: 2, lastGoodRevision: 0 }
    await runtime.adoptRecoveredActivation(restored, 2)
    await runtime.synchronizeRecoveredActivation(session as never)
    expect(expressions.filter(expression => expression.includes('recoverPluginMutation'))).toHaveLength(1)
    expect(expressions.filter(expression => expression.includes('adoptRecoveredActivation'))).toHaveLength(1)
    expect(runtime.prepare('next')).toMatchObject({ expectedRegistryEpoch: 2 })
  })
})

describe('CdpLifecycleRequestGate', () => {
  it('releases the single-flight fence before a response-triggered follow-up', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: number[] = []
    let followUp: Promise<void> | undefined

    await gate.run(async () => 1, async value => {
      values.push(value)
      followUp = gate.run(async () => 2, async next => { values.push(next) })
    })
    await followUp

    expect(values).toEqual([1, 2])
  })

  it('rejects a genuinely concurrent lifecycle task', async () => {
    const gate = new CdpLifecycleRequestGate()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const active = gate.run(async () => { await blocked }, async () => undefined)

    await expect(gate.run(async () => undefined, async () => undefined)).rejects.toThrow(/already active/)
    release()
    await active
  })
})
