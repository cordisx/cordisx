import WebSocket from 'ws'
import { fetchMarketplaceFeed } from './marketplace.js'
import type { ProviderFleet } from '../providers/fleet.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle.js'
import {
  handlePluginLifecycleBindingRequest,
  MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES,
  parsePluginLifecycleBindingRequest,
  PLUGIN_LIFECYCLE_BINDING,
  PLUGIN_LIFECYCLE_RECEIVER,
  type PluginLifecycleBridgeHandler,
} from './plugin-lifecycle-rpc.js'
import {
  handleProviderBindingRequest,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_REQUESTS,
  parseProviderBindingRequest,
  PROVIDER_BINDING,
  PROVIDER_RECEIVER,
} from './provider-rpc.js'
import type { CodexAgentHistoryHost } from './agent-history.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../plugin-lifecycle-contracts.js'
import type { RollbackPlan } from './packages/authority.js'
import type { PackageActivationTuple } from './packages/types.js'
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
  MAX_SERVICE_CONFIG_REQUEST_BYTES,
  SERVICE_CONFIG_BINDING,
  SERVICE_CONFIG_RECEIVER,
  parseServiceConfigBindingRequest,
  serviceConfigBridgeError,
  type ServiceConfigBridgeHandler,
} from './service-config-rpc.js'
import {
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_PERMISSION_REQUESTS,
  PERMISSION_BINDING,
  PERMISSION_RECEIVER,
  parsePermissionBindingRequest,
  persistPermissionPolicies,
  type PermissionPersistenceContext,
  type PluginPermissionIdentityRegistry,
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

async function evaluateRuntimeOperation<Value = void>(session: CdpSession, expression: string): Promise<Value> {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  })
  const value = (response.result as { value?: unknown } | undefined)?.value as { ok?: unknown; error?: unknown; result?: Value } | undefined
  if (value?.ok !== true) throw new Error(typeof value?.error === 'string' ? value.error : 'renderer lifecycle operation failed')
  return value.result as Value
}

function activationRecord(tuple: PackageActivationTuple): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: tuple.profileId,
    revision: tuple.revision,
    lastGoodRevision: tuple.lastGoodRevision,
    runtimeGeneration: tuple.runtimeGeneration,
    plugins: tuple.plugins,
  }
}

/** Broadcast one reversible generation transaction to every injected Codex renderer. */
export class CdpPluginLifecycleRuntime implements PluginLifecycleRuntime {
  private readonly sessions = new Set<CdpSession>()
  private readonly staged = new Map<string, readonly CdpSession[]>()
  private readonly fences = new Map<string, RuntimeGenerationFence>()
  private registryEpoch = 0
  private permissionIdentities: PluginPermissionIdentityRegistry | undefined
  private recoveredActivation: CordisXPluginActivationRecordV1 | undefined
  private readonly recoveredSessions = new WeakSet<CdpSession>()

  constructor(permissionIdentities?: PluginPermissionIdentityRegistry) {
    this.permissionIdentities = permissionIdentities
  }

  setPermissionIdentities(permissionIdentities: PluginPermissionIdentityRegistry): void {
    if (this.staged.size !== 0 || this.fences.size !== 0) throw new Error('cannot replace permission identities during a generation transaction')
    this.permissionIdentities = permissionIdentities
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.fences.has(transactionId)) throw new Error('plugin generation fence already exists')
    if (this.sessions.size === 0) throw new Error('no ready CordisX renderer is available')
    const fence = Object.freeze({
      transactionEpoch: `${transactionId}:${crypto.randomUUID()}`,
      expectedRegistryEpoch: this.registryEpoch,
    })
    this.fences.set(transactionId, fence)
    return fence
  }

  register(session: CdpSession): () => void {
    this.sessions.add(session)
    return () => {
      this.sessions.delete(session)
      for (const [transactionId, sessions] of this.staged) {
        const remaining = sessions.filter(item => item !== session)
        if (remaining.length === 0) this.staged.delete(transactionId)
        else if (remaining.length !== sessions.length) this.staged.set(transactionId, remaining)
      }
    }
  }

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    const fence = this.fences.get(mutation.transactionId)
    if (fence === undefined
      || mutation.transactionEpoch !== fence.transactionEpoch
      || mutation.expectedRegistryEpoch !== fence.expectedRegistryEpoch
      || mutation.afterRegistryEpoch !== fence.expectedRegistryEpoch + 1) {
      throw new Error('plugin generation mutation does not match its Host registry fence')
    }
    const { runtimeArtifactSource, ...projectedMutation } = mutation
    const rendererMutation = {
      ...projectedMutation,
      ...(mutation.package === undefined ? {} : {
        package: {
          manifest: mutation.package.manifest,
          digest: mutation.package.digest,
          identitySource: mutation.package.identitySource,
          ...(mutation.package.readme === undefined ? {} : { readme: mutation.package.readme }),
        },
      }),
    }
    const receipts: RuntimeReadinessObservation[] = []
    this.permissionIdentities?.stage(
      mutation.transactionId,
      mutation.operation,
      mutation.targetId,
      mutation.affectedPluginIds,
      mutation.package?.identitySource,
    )
    try {
      const results = await Promise.allSettled(sessions.map(async session => {
        let artifactFailure: unknown
        if (mutation.package !== undefined) {
          try {
            await session.send('Runtime.evaluate', {
              expression: 'delete globalThis.__cordisxPendingPluginModuleV1; delete globalThis.__cordisxPendingPluginModuleFactoryV1',
              allowUnsafeEvalBlockedByCSP: true,
            })
            const artifact = await session.send('Runtime.evaluate', {
              expression: runtimeArtifactSource ?? mutation.package.artifactSource,
              allowUnsafeEvalBlockedByCSP: true,
            })
            if (artifact.exceptionDetails !== undefined) artifactFailure = new Error('plugin artifact evaluation failed')
          } catch (error) {
            artifactFailure = error
          }
        }
        const serialized = JSON.stringify(rendererMutation)
        const receipt = await evaluateRuntimeOperation<Omit<RuntimeReadinessObservation, 'observation'>>(session, `(async () => { try {
          const module = globalThis.__cordisxPendingPluginModuleV1
          const moduleFactory = globalThis.__cordisxPendingPluginModuleFactoryV1
          delete globalThis.__cordisxPendingPluginModuleV1
          delete globalThis.__cordisxPendingPluginModuleFactoryV1
          const runtime = globalThis.__cordisxRuntime
          if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
          const result = await runtime.stagePluginMutation(${serialized}, module, moduleFactory)
          return { ok: true, result }
        } catch (error) {
          delete globalThis.__cordisxPendingPluginModuleV1
          delete globalThis.__cordisxPendingPluginModuleFactoryV1
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        } })()`)
        if (artifactFailure !== undefined) throw artifactFailure
        return { ...receipt, observation: mutation.candidate }
      }))
      this.staged.set(mutation.transactionId, sessions)
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      for (const result of results) if (result.status === 'fulfilled') receipts.push(result.value)
      if (failed !== undefined) throw failed.reason
      const first = receipts[0]!
      if (receipts.some(item => item.transactionEpoch !== first.transactionEpoch
        || item.expectedRegistryEpoch !== first.expectedRegistryEpoch
        || item.afterRegistryEpoch !== first.afterRegistryEpoch)) {
        throw new Error('CordisX renderer readiness receipts disagree')
      }
      return first
    } catch (error) {
      this.staged.set(mutation.transactionId, sessions)
      throw error
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(sessions.map(async session => await evaluateRuntimeOperation<RuntimePublicationObservation>(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.publishPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    const first = results[0]
    if (first === undefined || results.some(item => item.transactionEpoch !== first.transactionEpoch
      || item.registryEpoch !== first.registryEpoch)) throw new Error('CordisX renderer publications disagree')
    this.registryEpoch = first.registryEpoch
    return first
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(sessions.map(async session => await evaluateRuntimeOperation<RuntimeCleanupObservation>(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.completePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    const first = results[0]
    if (first === undefined || results.some(item => item.transactionEpoch !== first.transactionEpoch
      || item.registryEpoch !== first.registryEpoch)) throw new Error('CordisX renderer cleanup observations disagree')
    return first
  }

  async finalize(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    await Promise.all(sessions.map(async session => await evaluateRuntimeOperation(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.finalizePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    this.staged.delete(transactionId)
    this.fences.delete(transactionId)
    this.permissionIdentities?.commit(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(sessions.map(async session => await evaluateRuntimeOperation<RuntimeCleanupObservation>(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.rollbackPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    const first = results[0]
    if (first === undefined || results.some(item => item.transactionEpoch !== first.transactionEpoch
      || item.registryEpoch !== first.registryEpoch)) throw new Error('CordisX renderer rollback observations disagree')
    this.registryEpoch = first.registryEpoch
    this.staged.delete(transactionId)
    this.fences.delete(transactionId)
    this.permissionIdentities?.abort(transactionId)
    return first
  }

  async recoverRollback(plan: RollbackPlan): Promise<RuntimeCleanupObservation> {
    const sessions = [...this.sessions]
    const recovery = {
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      registryEpoch: plan.rollbackRegistryEpoch,
      active: activationRecord(plan.rollbackTarget),
      disposedAfter: activationRecord(plan.expectedPublished),
    }
    const results = await Promise.all(sessions.map(async session => await evaluateRuntimeOperation<RuntimeCleanupObservation>(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      let result
      try {
        result = await runtime.rollbackPluginMutation(${JSON.stringify(plan.transactionId)})
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'unknown plugin generation transaction') throw error
        result = await runtime.recoverPluginMutation(${JSON.stringify(recovery)})
      }
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    const first = results[0]
    if (first === undefined || first.transactionId !== plan.transactionId
      || first.transactionEpoch !== plan.transactionEpoch
      || first.registryEpoch !== plan.rollbackRegistryEpoch
      || results.some(item => item.transactionId !== first.transactionId
      || item.transactionEpoch !== first.transactionEpoch
      || item.registryEpoch !== first.registryEpoch
      || JSON.stringify(item.active) !== JSON.stringify(first.active)
      || JSON.stringify(item.disposedAfter) !== JSON.stringify(first.disposedAfter))) {
      throw new Error('CordisX renderer recovery observations disagree')
    }
    this.registryEpoch = first.registryEpoch
    this.staged.delete(plan.transactionId)
    this.fences.delete(plan.transactionId)
    this.permissionIdentities?.abort(plan.transactionId)
    return first
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const sessions = [...this.sessions]
    await Promise.all(sessions.map(async session => await this.adoptRecoveredActivationFor(session, active, registryEpoch)))
    this.registryEpoch = registryEpoch
    this.recoveredActivation = active
  }

  async synchronizeRecoveredActivation(session: CdpSession): Promise<void> {
    if (this.recoveredActivation === undefined || this.recoveredSessions.has(session)) return
    await this.adoptRecoveredActivationFor(session, this.recoveredActivation, this.registryEpoch)
  }

  private async adoptRecoveredActivationFor(
    session: CdpSession,
    active: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ): Promise<void> {
    await evaluateRuntimeOperation(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.adoptRecoveredActivation(${JSON.stringify(active)}, ${JSON.stringify(registryEpoch)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)
    this.recoveredSessions.add(session)
  }

  async commit(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    try {
      await Promise.all(sessions.map(async session => await evaluateRuntimeOperation(session, `(async () => { try {
        const runtime = globalThis.__cordisxRuntime
        if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
        await runtime.commitPluginMutation(${JSON.stringify(transactionId)})
        return { ok: true }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    } finally {
      this.staged.delete(transactionId)
      this.permissionIdentities?.commit(transactionId)
    }
  }

  async abort(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    try {
      await Promise.all(sessions.map(async session => await evaluateRuntimeOperation(session, `(async () => { try {
        const runtime = globalThis.__cordisxRuntime
        if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
        await runtime.abortPluginMutation(${JSON.stringify(transactionId)})
        return { ok: true }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
    } finally {
      this.staged.delete(transactionId)
      this.fences.delete(transactionId)
      this.permissionIdentities?.abort(transactionId)
    }
  }

  async reload(input: { readonly pluginId: string; readonly moduleGeneration: string; readonly runtimeGeneration: string }): Promise<void> {
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    await Promise.all(sessions.map(async session => await evaluateRuntimeOperation(session, `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.reloadPluginGeneration(${JSON.stringify(input.pluginId)}, ${JSON.stringify(input.moduleGeneration)}, ${JSON.stringify(input.runtimeGeneration)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)))
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
  readonly serviceConfigController?: AbortController
  readonly removeServiceConfigBindingListener?: () => void
  readonly serviceConfigBindingInstalled: boolean
  readonly permissionController?: AbortController
  readonly removePermissionBindingListener?: () => void
  readonly permissionBindingInstalled: boolean
  readonly lifecycleController?: AbortController
  readonly removeLifecycleBindingListener?: () => void
  readonly lifecycleBindingInstalled: boolean
  readonly unregisterLifecycleSession?: () => void
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

export function serviceConfigResponseEvaluation(
  payload: Record<string, unknown>,
  executionContextId?: number,
): Record<string, unknown> {
  return {
    expression: `void globalThis.${SERVICE_CONFIG_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
    ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
  }
}

async function sendServiceConfigBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
  executionContextId?: number,
): Promise<void> {
  await session.send('Runtime.evaluate', serviceConfigResponseEvaluation(payload, executionContextId))
}

async function sendPermissionBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PERMISSION_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendPluginLifecycleBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PLUGIN_LIFECYCLE_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

/** Keep lifecycle mutations single-flight while allowing a response-triggered follow-up request. */
export class CdpLifecycleRequestGate {
  #active = false

  async run<Value>(task: () => Promise<Value>, respond: (value: Value) => Promise<void>): Promise<void> {
    if (this.#active) throw new Error('another plugin lifecycle request is already active')
    this.#active = true
    let value: Value
    try {
      value = await task()
    } finally {
      this.#active = false
    }
    await respond(value)
  }
}

async function install(
  target: CdpTarget,
  source: string,
  provider?: { readonly fleet: ProviderFleet; readonly token: string },
  history?: { readonly host: CodexAgentHistoryHost; readonly token: string },
  config?: ConfigBridgeHandler,
  serviceConfig?: ServiceConfigBridgeHandler,
  permission?: PermissionPersistenceContext,
  lifecycle?: { readonly handler: PluginLifecycleBridgeHandler; readonly runtime: CdpPluginLifecycleRuntime },
): Promise<InstalledScript> {
  const url = target.webSocketDebuggerUrl
  if (url === undefined) throw new Error(`target ${target.id} has no websocket URL`)
  const session = await CdpSession.connect(url)
  const marketplaceController = new AbortController()
  const providerController = provider === undefined ? undefined : new AbortController()
  const historyController = history === undefined ? undefined : new AbortController()
  const configController = config === undefined ? undefined : new AbortController()
  const serviceConfigController = serviceConfig === undefined ? undefined : new AbortController()
  const permissionController = permission === undefined ? undefined : new AbortController()
  const lifecycleController = lifecycle === undefined ? undefined : new AbortController()
  let removeBindingListener = (): void => {}
  let removeProviderBindingListener = (): void => {}
  let removeHistoryBindingListener = (): void => {}
  let removeConfigBindingListener = (): void => {}
  let removeServiceConfigBindingListener = (): void => {}
  let removePermissionBindingListener = (): void => {}
  let removeLifecycleBindingListener = (): void => {}
  let unregisterLifecycleSession = (): void => {}
  try {
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Runtime.addBinding', { name: MARKETPLACE_BINDING })
    if (provider !== undefined) await session.send('Runtime.addBinding', { name: PROVIDER_BINDING })
    if (history !== undefined) await session.send('Runtime.addBinding', { name: AGENT_HISTORY_BINDING })
    if (config !== undefined) await session.send('Runtime.addBinding', { name: CONFIG_BINDING })
    if (serviceConfig !== undefined) await session.send('Runtime.addBinding', { name: SERVICE_CONFIG_BINDING })
    if (permission !== undefined) await session.send('Runtime.addBinding', { name: PERMISSION_BINDING })
    if (lifecycle !== undefined) await session.send('Runtime.addBinding', { name: PLUGIN_LIFECYCLE_BINDING })
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
    let activeServiceConfigRequests = 0
    if (serviceConfig !== undefined) {
      removeServiceConfigBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== SERVICE_CONFIG_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        const executionContextId = typeof params.executionContextId === 'number' ? params.executionContextId : undefined
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_SERVICE_CONFIG_REQUEST_BYTES) throw new Error('service configuration request exceeds maximum size')
            const request = parseServiceConfigBindingRequest(JSON.parse(payload) as unknown, serviceConfig.token, serviceConfig.profileId, serviceConfig.generation)
            requestId = request.requestId
            if (serviceConfigController?.signal.aborted === true) throw new Error('service configuration bridge is closed')
            if (activeServiceConfigRequests >= 1) throw new Error('another service configuration request is already active')
            activeServiceConfigRequests += 1
            try {
              const value = await serviceConfig.handle(request)
              await sendServiceConfigBindingResponse(session, { requestId, ok: true, value }, executionContextId)
            } finally {
              activeServiceConfigRequests -= 1
            }
          } catch (error) {
            await sendServiceConfigBindingResponse(
              session,
              { requestId, ok: false, ...serviceConfigBridgeError(error) },
              executionContextId,
            ).catch(() => undefined)
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
    const lifecycleRequests = new CdpLifecycleRequestGate()
    if (lifecycle !== undefined) {
      removeLifecycleBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== PLUGIN_LIFECYCLE_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES) throw new Error('plugin lifecycle request exceeds maximum size')
            const request = parsePluginLifecycleBindingRequest(JSON.parse(payload) as unknown, lifecycle.handler)
            requestId = request.requestId
            if (lifecycleController?.signal.aborted === true) throw new Error('plugin lifecycle bridge is closed')
            await lifecycleRequests.run(
              async () => await handlePluginLifecycleBindingRequest(lifecycle.handler, request),
              async value => await sendPluginLifecycleBindingResponse(session, { requestId, ok: true, value }),
            )
          } catch {
            await sendPluginLifecycleBindingResponse(session, { requestId, ok: false, error: 'Plugin lifecycle request was rejected' }).catch(() => undefined)
          }
        })()
      })
    }
    if (lifecycle !== undefined) {
      unregisterLifecycleSession = lifecycle.runtime.register(session)
    }
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    const identifier = added.identifier
    if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
    await session.send('Runtime.evaluate', {
      expression: source,
      allowUnsafeEvalBlockedByCSP: true,
    })
    if (lifecycle !== undefined) {
      await evaluateRuntimeOperation(session, `(async () => { try {
        await globalThis.__cordisxBoot
        return { ok: globalThis.__cordisxRuntime !== undefined }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`)
      await lifecycle.handler.coordinator.recover()
      await lifecycle.runtime.synchronizeRecoveredActivation(session)
    }
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
      ...(serviceConfigController === undefined ? {} : { serviceConfigController, removeServiceConfigBindingListener }),
      serviceConfigBindingInstalled: serviceConfig !== undefined,
      ...(permissionController === undefined ? {} : { permissionController, removePermissionBindingListener }),
      permissionBindingInstalled: permission !== undefined,
      ...(lifecycleController === undefined ? {} : { lifecycleController, removeLifecycleBindingListener, unregisterLifecycleSession }),
      lifecycleBindingInstalled: lifecycle !== undefined,
    }
  } catch (error) {
    marketplaceController.abort()
    providerController?.abort()
    historyController?.abort()
    configController?.abort()
    serviceConfigController?.abort()
    permissionController?.abort()
    lifecycleController?.abort()
    removeBindingListener()
    removeProviderBindingListener()
    removeHistoryBindingListener()
    removeConfigBindingListener()
    removeServiceConfigBindingListener()
    removePermissionBindingListener()
    removeLifecycleBindingListener()
    unregisterLifecycleSession()
    session.close()
    throw error
  }
}

async function uninstall(installed: InstalledScript): Promise<void> {
  installed.marketplaceController.abort()
  installed.providerController?.abort()
  installed.historyController?.abort()
  installed.configController?.abort()
  installed.serviceConfigController?.abort()
  installed.permissionController?.abort()
  installed.lifecycleController?.abort()
  installed.removeBindingListener()
  installed.removeProviderBindingListener?.()
  installed.removeHistoryBindingListener?.()
  installed.removeConfigBindingListener?.()
  installed.removeServiceConfigBindingListener?.()
  installed.removePermissionBindingListener?.()
  installed.removeLifecycleBindingListener?.()
  installed.unregisterLifecycleSession?.()
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
      ...(installed.serviceConfigBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: SERVICE_CONFIG_BINDING })]
        : []),
      ...(installed.permissionBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PERMISSION_BINDING })]
        : []),
      ...(installed.lifecycleBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PLUGIN_LIFECYCLE_BINDING })]
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
  readonly serviceConfigBridge?: ServiceConfigBridgeHandler
  readonly permissionPersistence?: PermissionPersistenceContext
  readonly pluginLifecycle?: { readonly handler: PluginLifecycleBridgeHandler; readonly runtime: CdpPluginLifecycleRuntime }
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
            options.serviceConfigBridge,
            options.permissionPersistence,
            options.pluginLifecycle,
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
