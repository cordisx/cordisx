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

describe('icon theme preference document lifecycle', () => {
  it('keeps another target profile-pending from ready ingress through register and acknowledgement', async () => {
    const servers = [new WebSocketServer({ port: 0 }), new WebSocketServer({ port: 0 })] as const
    await Promise.all(servers.map(async server => await once(server, 'listening')))
    const addresses = servers.map(server => server.address())
    if (addresses.some(address => typeof address === 'string')) {
      throw new Error('fixture websocket did not bind TCP ports')
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-cdp-profile-reservation-'))
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    const token = 'r'.repeat(64)
    const installed = [deferred(), deferred()] as const
    const readyComplete = [deferred(), deferred()] as const
    const sockets: Array<import('ws').WebSocket | undefined> = [undefined, undefined]
    const epochs = ['document_epoch_target_a', 'document_epoch_target_b'] as const
    const revisions = [0, 0]
    const selectionResponse = deferred<Record<string, unknown>>()
    const linearOldResponseHeld = deferred()
    const linearLatestResponseHeld = deferred()
    const linearConflictResponse = deferred<Record<string, unknown>>()
    const linearReadyResponse = deferred<Record<string, unknown>>()
    const linearReadyFinalized = deferred()
    let heldLinearOldResponseRequestId: number | undefined
    let heldLinearLatestResponseRequestId: number | undefined
    let heldLinearOldResponsePayload: Record<string, unknown> | undefined
    let heldLinearLatestResponsePayload: Record<string, unknown> | undefined
    let linearReadyResponseCount = 0
    let holdLinearReadyResponses = false
    for (const [index, server] of servers.entries()) {
      server.on('connection', connection => {
        sockets[index] = connection
        connection.on('message', data => {
          const request = JSON.parse(String(data)) as {
            id: number
            method: string
            params?: { expression?: string; contextId?: number }
          }
          const respond = (result: Record<string, unknown>): void =>
            connection.send(JSON.stringify({ id: request.id, result }))
          if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
            respond({ identifier: `profile-reservation-${index}` })
            return
          }
          if (request.method !== 'Runtime.evaluate') {
            respond({})
            return
          }
          const expression = request.params?.expression ?? ''
          if (expression.includes('globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot')) {
            respond({ result: { value: { ok: true } } })
            installed[index]!.resolve()
            return
          }
          if (!expression.includes('const receiver = globalThis.__cordisxIconThemePreferenceReceiveV1')) {
            respond({ result: { value: undefined } })
            return
          }
          const payload = iconThemeReceiverPayload(expression)
          if (expression.includes('return ack')) {
            if (payload?.kind === 'sync') {
              revisions[index] = Number((payload.value as { revision?: unknown })?.revision ?? revisions[index])
            }
            if (
              index === 0 && holdLinearReadyResponses && payload?.kind === 'document-ready'
              && payload.requestId === 'ready-profile-linear'
            ) {
              linearReadyResponseCount += 1
              if (linearReadyResponseCount === 1) {
                heldLinearOldResponseRequestId = request.id
                heldLinearOldResponsePayload = payload
                linearOldResponseHeld.resolve()
                return
              }
              if (linearReadyResponseCount === 2) {
                heldLinearLatestResponseRequestId = request.id
                heldLinearLatestResponsePayload = payload
                linearReadyResponse.resolve(payload)
                linearLatestResponseHeld.resolve()
                return
              }
            }
            respond({
              result: {
                value: {
                  documentEpoch: epochs[index],
                  currentRevision: revisions[index],
                  ...readyLeaseEcho(payload),
                },
              },
            })
            if (payload?.kind === 'document-ready') readyComplete[index]!.resolve()
            if (payload?.kind === 'document-ready' && payload.requestId === 'ready-profile-linear') {
              linearReadyResponse.resolve(payload)
            }
            return
          }
          respond({ result: { value: true } })
          if (payload?.requestId === 'profile-wide-selection') selectionResponse.resolve(payload)
          if (payload?.requestId === 'profile-linear-conflict') linearConflictResponse.resolve(payload)
        })
      })
    }
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const originalReserve = hub.reserve.bind(hub)
    const targetBReserved = deferred()
    const releaseTargetBRegister = deferred()
    const targetReadyAcknowledged = [deferred(), deferred()] as const
    let targetACompletedReadyCount = 0
    vi.spyOn(hub, 'reserve').mockImplementation(identity => {
      const reservation = originalReserve(identity)
      const index = identity.targetId === 'target-a' ? 0 : 1
      expect(identity.executionContextId).toBe(70 + index)
      if (identity.targetId === 'target-b') targetBReserved.resolve()
      return {
        cancel: reservation.cancel,
        register: async receiver => {
          if (identity.targetId === 'target-b') await releaseTargetBRegister.promise
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
              if (status.synchronization === 'complete') {
                targetReadyAcknowledged[index]!.resolve()
                if (index === 0) {
                  targetACompletedReadyCount += 1
                  if (targetACompletedReadyCount === 2) linearReadyFinalized.resolve()
                }
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
        JSON.stringify(addresses.map((address, index) => ({
          id: index === 0 ? 'target-a' : 'target-b',
          title: `Codex ${index}`,
          url: 'app://-/index.html',
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${(address as { port: number }).port}`,
        }))),
        { status: 200 },
      )
    ) as typeof fetch
    const abort = new AbortController()
    const watching = watchAndInject({
      port: (addresses[0] as { port: number }).port,
      source: 'void 0',
      signal: abort.signal,
      iconThemePreferencePersistence: {
        configPath,
        appId: 'codex',
        profileId: 'default',
        hostGeneration: 'host-profile-reservation',
        token,
      },
      iconThemePreferenceBroadcastHub: hub,
    })
    const sendReady = (index: number): void =>
      sockets[index]?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 70 + index,
          payload: JSON.stringify({
            version: 1,
            kind: 'document-ready',
            token,
            requestId: `ready-profile-${index}`,
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-profile-reservation' },
            documentEpoch: epochs[index],
            currentRevision: revisions[index],
          }),
        },
      }))
    try {
      await Promise.all(installed.map(item => item.promise))
      sendReady(0)
      await readyComplete[0].promise
      await targetReadyAcknowledged[0].promise
      sendReady(1)
      await targetBReserved.promise
      sockets[0]?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 70,
          payload: JSON.stringify({
            version: 1,
            token,
            requestId: 'profile-wide-selection',
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-profile-reservation' },
            expectedPreferenceRevision: 0,
            expectedProfileRevision: 0,
            selectedProfileRevision: 1,
            candidate: {
              providerId: 'builtin:reicon',
              namespace: 'reicon',
              providerVersion: '1.2.1',
              providerGeneration: 'reicon-1.2.1',
            },
          }),
        },
      }))
      expect(await selectionResponse.promise).toMatchObject({
        ok: true,
        value: { revision: 1 },
        synchronization: 'pending',
      })
      expect(hub.current()).toMatchObject({ revision: 1 })
      releaseTargetBRegister.resolve()
      await readyComplete[1].promise
      await targetReadyAcknowledged[1].promise
      await expect(hub.broadcast(hub.current()!)).resolves.toMatchObject({ pending: 0 })

      holdLinearReadyResponses = true
      sockets[0]?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 70,
          payload: JSON.stringify({
            version: 1,
            kind: 'document-ready',
            token,
            requestId: 'ready-profile-linear',
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-profile-reservation' },
            documentEpoch: epochs[0],
            currentRevision: 1,
          }),
        },
      }))
      await linearOldResponseHeld.promise
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
      sockets[0]?.send(JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: ICON_THEME_PREFERENCE_BINDING,
          executionContextId: 70,
          payload: JSON.stringify({
            version: 1,
            token,
            requestId: 'profile-linear-conflict',
            scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-profile-reservation' },
            expectedPreferenceRevision: 1,
            expectedProfileRevision: 1,
            selectedProfileRevision: 2,
            candidate: {
              providerId: 'builtin:reicon',
              namespace: 'reicon',
              providerVersion: '1.2.1',
              providerGeneration: 'reicon-1.2.1',
            },
          }),
        },
      }))
      expect(await linearConflictResponse.promise).toMatchObject({
        ok: false,
        code: 'conflict',
        currentPreference: { revision: 2 },
        synchronization: 'pending',
      })
      expect(hub.current()).toMatchObject({ revision: 2 })
      expect(revisions[0]).toBe(2)
      await linearLatestResponseHeld.promise
      sockets[0]?.send(JSON.stringify({
        id: heldLinearOldResponseRequestId,
        result: {
          result: {
            value: {
              documentEpoch: epochs[0],
              currentRevision: 1,
              ...readyLeaseEcho(heldLinearOldResponsePayload),
            },
          },
        },
      }))
      await Promise.resolve()
      expect(targetACompletedReadyCount).toBe(1)
      sockets[0]?.send(JSON.stringify({
        id: heldLinearLatestResponseRequestId,
        result: {
          result: {
            value: {
              documentEpoch: epochs[0],
              currentRevision: 2,
              ...readyLeaseEcho(heldLinearLatestResponsePayload),
            },
          },
        },
      }))
      await expect(linearReadyResponse.promise).resolves.toMatchObject({
        synchronization: 'complete',
        requiredRevision: 2,
        currentRevision: 2,
      })
      await linearReadyFinalized.promise
      await expect(hub.broadcast(hub.current()!)).resolves.toMatchObject({ pending: 0 })
    } finally {
      releaseTargetBRegister.resolve()
      abort.abort()
      await watching
      globalThis.fetch = originalFetch
      for (const server of servers) server.close()
      await Promise.all(servers.map(async server => await once(server, 'close')))
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
    const contextRevisions = new Map<number, number>([[51, 1], [52, 1], [53, 1]])
    const epochs = new Map<number, string>([
      [51, 'document_epoch_old'],
      [52, 'document_epoch_new'],
      [53, 'document_epoch_close'],
    ])
    const sendReady = (contextId: number, currentRevision: number): void =>
      connectionRef?.send(JSON.stringify({
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
        const respond = (result: Record<string, unknown>): void =>
          connection.send(JSON.stringify({ id: request.id, result }))
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
          respond({ identifier: 'icon-theme-replacement-fixture' })
          return
        }
        if (request.method !== 'Runtime.evaluate') {
          respond({})
          return
        }
        const expression = request.params?.expression ?? ''
        if (expression.includes('globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot')) {
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
          const revision = Number((payload.value as { revision?: unknown })?.revision ?? 0)
          if (contextId === 51) {
            contextRevisions.set(51, revision)
            respond({ result: { value: { documentEpoch: epochs.get(51), currentRevision: revision } } })
            return
          }
          if (contextId === 52) {
            context52SyncCount += 1
            newReplayStarted.resolve()
            contextRevisions.set(52, revision)
            respond({ result: { value: { documentEpoch: epochs.get(52), currentRevision: revision } } })
            return
          }
          if (contextId === 53) {
            targetCloseDeliveryHeld.resolve()
            return
          }
        }
        if (payload?.kind === 'document-ready-probe') {
          respond({
            result: {
              value: { documentEpoch: epochs.get(contextId!), currentRevision: contextRevisions.get(contextId!) ?? 0 },
            },
          })
          return
        }
        if (payload?.kind === 'document-ready') {
          if (contextId === 51) {
            heldOldRequestId = request.id
            oldDeliveryHeld.resolve()
            return
          }
          const currentRevision = Number(payload.currentRevision ?? 0)
          respond({
            result: {
              value: {
                documentEpoch: epochs.get(contextId!),
                currentRevision,
                ...readyLeaseEcho(payload),
              },
            },
          })
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
              providerId: 'builtin:reicon',
              namespace: 'reicon',
              providerVersion: '1.2.1',
              providerGeneration: 'reicon-1.2.1',
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
    plugins: [{
      id: 'demo',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      moduleGeneration: generation,
      enabled: revision === 0,
      dependencies: [],
    }],
  }
}
