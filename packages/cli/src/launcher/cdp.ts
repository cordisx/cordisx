import WebSocket from 'ws'
import { fetchMarketplaceFeed } from './marketplace.js'
import type { ProviderFleet } from '../providers/fleet.js'
import {
  handleProviderBindingRequest,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_REQUESTS,
  parseProviderBindingRequest,
  PROVIDER_BINDING,
  PROVIDER_RECEIVER,
} from './provider-rpc.js'
import type { CodexAgentHistoryHost } from './agent-history.js'
import {
  AGENT_HISTORY_BINDING,
  AGENT_HISTORY_RECEIVER,
  handleAgentHistoryBindingRequest,
  MAX_AGENT_HISTORY_REQUEST_BYTES,
  MAX_AGENT_HISTORY_REQUESTS,
  parseAgentHistoryBindingRequest,
} from './agent-history-rpc.js'
import {
  CONFIG_BINDING,
  CONFIG_RECEIVER,
  MAX_CONFIG_REQUEST_BYTES,
  configBridgeError,
  parseConfigBindingRequest,
  type ConfigBridgeHandler,
} from './config-rpc.js'
import {
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_PERMISSION_REQUESTS,
  PERMISSION_BINDING,
  PERMISSION_RECEIVER,
  parsePermissionBindingRequest,
  persistPermissionPolicies,
  type PermissionPersistenceContext,
} from './permission-rpc.js'

const MARKETPLACE_BINDING = '__cordisxMarketplaceRequestV1'
const MARKETPLACE_RECEIVER = '__cordisxMarketplaceReceiveV1'
const MAX_MARKETPLACE_REQUESTS = 4
const CDP_REQUEST_TIMEOUT_MS = 5_000

export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpResponse {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
  readonly method?: string
  readonly params?: Record<string, unknown>
}

class CdpSession {
  private nextId = 1
  private readonly pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void
    readonly reject: (error: Error) => void
  }>()
  private readonly eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as CdpResponse
      if (message.method !== undefined) {
        for (const listener of this.eventListeners.get(message.method) ?? []) listener(message.params ?? {})
      }
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (callback === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) callback.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else callback.resolve(message.result ?? {})
    })
    socket.on('close', () => {
      for (const callback of this.pending.values()) callback.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new CdpSession(socket)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request timed out: ${method}`))
      }, CDP_REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        // ws may pass null on success even though its TypeScript callback uses undefined.
        if (error == null) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.eventListeners.delete(method)
    }
  }

  close(): void {
    this.socket.close()
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Read the current Electron target table from the loopback debugging endpoint. */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
  const value = await response.json() as unknown
  if (!Array.isArray(value)) throw new Error('CDP target list is not an array')
  return value.filter((item): item is CdpTarget => {
    return item !== null && typeof item === 'object' && typeof (item as CdpTarget).id === 'string'
  })
}

function injectable(target: CdpTarget): boolean {
  return target.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && !target.url.startsWith('devtools://')
    && !target.url.includes('initialRoute=%2Favatar-overlay')
}

function targetScore(target: CdpTarget): number {
  const label = `${target.title} ${target.url}`.toLowerCase()
  return label.includes('codex') ? 10 : label.includes('chatgpt') ? 5 : 0
}

/** Select only renderer pages visibly associated with Codex/ChatGPT. */
export function injectableTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  const pages = targets.filter(injectable).sort((left, right) => targetScore(right) - targetScore(left))
  return pages.filter(target => targetScore(target) > 0)
}

interface InstalledScript {
  readonly target: CdpTarget
  readonly identifier: string
  readonly session: CdpSession
  readonly marketplaceController: AbortController
  readonly removeBindingListener: () => void
  readonly providerController?: AbortController
  readonly removeProviderBindingListener?: () => void
  readonly providerBindingInstalled: boolean
  readonly historyController?: AbortController
  readonly removeHistoryBindingListener?: () => void
  readonly historyBindingInstalled: boolean
  readonly configController?: AbortController
  readonly removeConfigBindingListener?: () => void
  readonly configBindingInstalled: boolean
  readonly permissionController?: AbortController
  readonly removePermissionBindingListener?: () => void
  readonly permissionBindingInstalled: boolean
}

interface MarketplaceBindingRequest {
  readonly requestId: string
  readonly url: string
}

function parseMarketplaceBindingRequest(value: unknown): MarketplaceBindingRequest {
  if (value === null || typeof value !== 'object') throw new Error('invalid marketplace bridge request')
  const requestId = (value as { requestId?: unknown }).requestId
  const url = (value as { url?: unknown }).url
  if (typeof requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(requestId)) throw new Error('invalid marketplace bridge request id')
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) throw new Error('invalid marketplace bridge URL')
  return { requestId, url }
}

async function sendMarketplaceBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${MARKETPLACE_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendProviderBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PROVIDER_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendAgentHistoryBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${AGENT_HISTORY_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendConfigBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CONFIG_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendPermissionBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PERMISSION_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function install(
  target: CdpTarget,
  source: string,
  provider?: { readonly fleet: ProviderFleet; readonly token: string },
  history?: { readonly host: CodexAgentHistoryHost; readonly token: string },
  config?: ConfigBridgeHandler,
  permission?: PermissionPersistenceContext,
): Promise<InstalledScript> {
  const url = target.webSocketDebuggerUrl
  if (url === undefined) throw new Error(`target ${target.id} has no websocket URL`)
  const session = await CdpSession.connect(url)
  const marketplaceController = new AbortController()
  const providerController = provider === undefined ? undefined : new AbortController()
  const historyController = history === undefined ? undefined : new AbortController()
  const configController = config === undefined ? undefined : new AbortController()
  const permissionController = permission === undefined ? undefined : new AbortController()
  let removeBindingListener = (): void => {}
  let removeProviderBindingListener = (): void => {}
  let removeHistoryBindingListener = (): void => {}
  let removeConfigBindingListener = (): void => {}
  let removePermissionBindingListener = (): void => {}
  try {
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Runtime.addBinding', { name: MARKETPLACE_BINDING })
    if (provider !== undefined) await session.send('Runtime.addBinding', { name: PROVIDER_BINDING })
    if (history !== undefined) await session.send('Runtime.addBinding', { name: AGENT_HISTORY_BINDING })
    if (config !== undefined) await session.send('Runtime.addBinding', { name: CONFIG_BINDING })
    if (permission !== undefined) await session.send('Runtime.addBinding', { name: PERMISSION_BINDING })
    let activeMarketplaceRequests = 0
    removeBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
      if (params.name !== MARKETPLACE_BINDING || typeof params.payload !== 'string') return
      const payload = params.payload
      void (async () => {
        let requestId = 'invalid'
        try {
          const requestValue = parseMarketplaceBindingRequest(JSON.parse(payload) as unknown)
          requestId = requestValue.requestId
          if (activeMarketplaceRequests >= MAX_MARKETPLACE_REQUESTS) throw new Error('too many concurrent marketplace feed requests')
          activeMarketplaceRequests += 1
          try {
            const response = await fetchMarketplaceFeed(requestValue.url, marketplaceController.signal)
            await sendMarketplaceBindingResponse(session, {
              requestId,
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              url: response.url,
              text: response.text,
            })
          } finally {
            activeMarketplaceRequests -= 1
          }
        } catch (error) {
          await sendMarketplaceBindingResponse(session, {
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined)
        }
      })()
    })
    let activeProviderRequests = 0
    if (provider !== undefined) {
      removeProviderBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== PROVIDER_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_PROVIDER_REQUEST_BYTES) throw new Error('provider request exceeds maximum size')
            const request = parseProviderBindingRequest(JSON.parse(payload) as unknown, provider.token)
            requestId = request.requestId
            if (providerController?.signal.aborted === true) throw new Error('provider request bridge is closed')
            if (activeProviderRequests >= MAX_PROVIDER_REQUESTS) throw new Error('too many concurrent provider requests')
            activeProviderRequests += 1
            try {
              const value = await handleProviderBindingRequest(provider.fleet, request)
              await sendProviderBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeProviderRequests -= 1
            }
          } catch {
            await sendProviderBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Provider request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeHistoryRequests = 0
    if (history !== undefined) {
      removeHistoryBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== AGENT_HISTORY_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_AGENT_HISTORY_REQUEST_BYTES) throw new Error('Agent history request exceeds maximum size')
            const request = parseAgentHistoryBindingRequest(JSON.parse(payload) as unknown, history.token)
            requestId = request.requestId
            if (historyController?.signal.aborted === true) throw new Error('Agent history bridge is closed')
            if (activeHistoryRequests >= MAX_AGENT_HISTORY_REQUESTS) throw new Error('too many concurrent Agent history requests')
            activeHistoryRequests += 1
            try {
              const value = await handleAgentHistoryBindingRequest(history.host, request)
              await sendAgentHistoryBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeHistoryRequests -= 1
            }
          } catch {
            await sendAgentHistoryBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Agent history request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeConfigRequests = 0
    if (config !== undefined) {
      removeConfigBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== CONFIG_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_CONFIG_REQUEST_BYTES) throw new Error('config request exceeds maximum size')
            const request = parseConfigBindingRequest(JSON.parse(payload) as unknown, config.token, config.profileId, config.generation)
            requestId = request.requestId
            if (configController?.signal.aborted === true) throw new Error('config request bridge is closed')
            if (activeConfigRequests >= 1) throw new Error('another config request is already active')
            activeConfigRequests += 1
            let value: unknown
            try {
              value = await config.handle(request)
            } finally {
              activeConfigRequests -= 1
            }
            await sendConfigBindingResponse(session, { requestId, ok: true, value })
          } catch (error) {
            await sendConfigBindingResponse(session, {
              requestId,
              ok: false,
              ...configBridgeError(error),
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activePermissionRequests = 0
    if (permission !== undefined) {
      removePermissionBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== PERMISSION_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_PERMISSION_REQUEST_BYTES) throw new Error('permission request exceeds maximum size')
            const request = parsePermissionBindingRequest(JSON.parse(payload) as unknown, permission)
            requestId = request.requestId
            if (permissionController?.signal.aborted === true) throw new Error('permission persistence bridge is closed')
            if (activePermissionRequests >= MAX_PERMISSION_REQUESTS) throw new Error('too many concurrent permission requests')
            activePermissionRequests += 1
            try {
              const value = await persistPermissionPolicies(permission, request.records)
              await sendPermissionBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activePermissionRequests -= 1
            }
          } catch {
            await sendPermissionBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Permission policy request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    const identifier = added.identifier
    if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
    await session.send('Runtime.evaluate', {
      expression: source,
      allowUnsafeEvalBlockedByCSP: true,
    })
    return {
      target,
      identifier,
      session,
      marketplaceController,
      removeBindingListener,
      ...(providerController === undefined ? {} : { providerController, removeProviderBindingListener }),
      providerBindingInstalled: provider !== undefined,
      ...(historyController === undefined ? {} : { historyController, removeHistoryBindingListener }),
      historyBindingInstalled: history !== undefined,
      ...(configController === undefined ? {} : { configController, removeConfigBindingListener }),
      configBindingInstalled: config !== undefined,
      ...(permissionController === undefined ? {} : { permissionController, removePermissionBindingListener }),
      permissionBindingInstalled: permission !== undefined,
    }
  } catch (error) {
    marketplaceController.abort()
    providerController?.abort()
    historyController?.abort()
    configController?.abort()
    permissionController?.abort()
    removeBindingListener()
    removeProviderBindingListener()
    removeHistoryBindingListener()
    removeConfigBindingListener()
    removePermissionBindingListener()
    session.close()
    throw error
  }
}

async function uninstall(installed: InstalledScript): Promise<void> {
  installed.marketplaceController.abort()
  installed.providerController?.abort()
  installed.historyController?.abort()
  installed.configController?.abort()
  installed.permissionController?.abort()
  installed.removeBindingListener()
  installed.removeProviderBindingListener?.()
  installed.removeHistoryBindingListener?.()
  installed.removeConfigBindingListener?.()
  installed.removePermissionBindingListener?.()
  try {
    await Promise.allSettled([
      installed.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.identifier }),
      installed.session.send('Runtime.evaluate', {
        expression: 'void globalThis.__cordisxRuntime?.dispose?.()',
        allowUnsafeEvalBlockedByCSP: true,
      }),
      installed.session.send('Runtime.removeBinding', { name: MARKETPLACE_BINDING }),
      ...(installed.providerBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PROVIDER_BINDING })]
        : []),
      ...(installed.historyBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: AGENT_HISTORY_BINDING })]
        : []),
      ...(installed.configBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CONFIG_BINDING })]
        : []),
      ...(installed.permissionBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PERMISSION_BINDING })]
        : []),
    ])
  } finally {
    installed.session.close()
  }
}

export interface WatchInjectionOptions {
  readonly port: number
  readonly source: string
  readonly signal: AbortSignal
  readonly onStatus?: (message: string) => void
  readonly providerFleet?: ProviderFleet
  readonly providerBridgeToken?: string
  readonly agentHistoryHost?: CodexAgentHistoryHost
  readonly agentHistoryBridgeToken?: string
  readonly configBridge?: ConfigBridgeHandler
  readonly permissionPersistence?: PermissionPersistenceContext
}

/** Track every current Codex page and keep one removable bootstrap installed per target. */
export async function watchAndInject(options: WatchInjectionOptions): Promise<void> {
  const installed = new Map<string, InstalledScript>()
  try {
    while (!options.signal.aborted) {
      try {
        const targets = injectableTargets(await listTargets(options.port))
        const live = new Set(targets.map(target => target.id))
        for (const [id, record] of installed) {
          if (live.has(id)) continue
          await uninstall(record).catch(() => undefined)
          installed.delete(id)
        }
        for (const target of targets) {
          const current = installed.get(target.id)
          if (current?.target.webSocketDebuggerUrl === target.webSocketDebuggerUrl) continue
          if (current !== undefined) {
            await uninstall(current).catch(() => undefined)
            installed.delete(target.id)
          }
          const provider = options.providerFleet === undefined || options.providerBridgeToken === undefined
            ? undefined
            : { fleet: options.providerFleet, token: options.providerBridgeToken }
          const history = options.agentHistoryHost === undefined || options.agentHistoryBridgeToken === undefined
            ? undefined
            : { host: options.agentHistoryHost, token: options.agentHistoryBridgeToken }
          const record = await install(
            target,
            options.source,
            provider,
            history,
            options.configBridge,
            options.permissionPersistence,
          )
          installed.set(target.id, record)
          options.onStatus?.(`injected target ${target.id} (${target.title || target.url})`)
        }
      } catch (error) {
        options.onStatus?.(`waiting for Codex CDP on 127.0.0.1:${options.port}: ${String(error)}`)
      }
      await delay(750, options.signal)
    }
  } finally {
    await Promise.allSettled([...installed.values()].map(uninstall))
  }
}
