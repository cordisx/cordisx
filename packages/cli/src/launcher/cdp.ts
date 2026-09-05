import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
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
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import type { PluginGenerationGraphLease } from './plugin-generation-loader.js'
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
  configBridgeError,
  type ConfigBridgeHandler,
  MAX_CONFIG_REQUEST_BYTES,
  parseConfigBindingRequest,
} from './config-rpc.js'
import {
  MAX_PUBLISHER_GRANT_REQUEST_BYTES,
  parsePublisherGrantBindingRequest,
  PUBLISHER_GRANT_BINDING,
  PUBLISHER_GRANT_RECEIVER,
  type PublisherGrantBridgeHandler,
} from './publisher-grant-rpc.js'
import {
  MAX_SERVICE_CONFIG_REQUEST_BYTES,
  parseServiceConfigBindingRequest,
  SERVICE_CONFIG_BINDING,
  SERVICE_CONFIG_RECEIVER,
  serviceConfigBridgeError,
  type ServiceConfigBridgeHandler,
} from './service-config-rpc.js'
import {
  CHANNEL_CREDENTIAL_BINDING,
  CHANNEL_CREDENTIAL_RECEIVER,
  type ChannelCredentialBridgeHandler,
  MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES,
} from './channel-credential-rpc.js'
import {
  CHANNEL_ACTIONS_BINDING,
  CHANNEL_ACTIONS_RECEIVER,
  type ChannelActionsBridgeHandler,
} from './channel-actions-rpc.js'
import {
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_PERMISSION_REQUESTS,
  parsePermissionBindingRequest,
  PERMISSION_BINDING,
  PERMISSION_RECEIVER,
  type PermissionPersistenceContext,
  persistPermissionPolicies,
  type PluginPermissionIdentityRegistry,
} from './permission-rpc.js'
import {
  ICON_THEME_PREFERENCE_BINDING,
  ICON_THEME_PREFERENCE_RECEIVER,
  iconThemePreferenceBridgeError,
  IconThemePreferenceBroadcastHub,
  type IconThemePreferencePersistenceContext,
  type IconThemePreferenceReadyResponseAck,
  MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES,
  parseIconThemePreferenceBindingRequest,
  parseIconThemePreferenceDocumentReadyRequest,
  persistIconThemePreference,
} from './icon-theme-rpc.js'
import { CdpCertifiedPermissionChannel } from './certified-permission-cdp.js'
import type { LauncherMarketplaceCertifiedAuthority } from './marketplace-certified-authority.js'
import {
  entityInstallationId,
  MAX_OWNER_DOCUMENT_REQUEST_BYTES,
  MAX_OWNER_DOCUMENT_REQUESTS,
  OWNER_DOCUMENT_BINDING,
  OWNER_DOCUMENT_RECEIVER,
  ownerDocumentBridgeError,
  type OwnerDocumentBridgeHandler,
  type OwnerDocumentLeaseRegistry,
  type OwnerDocumentPrincipalBinding,
  parseOwnerDocumentBindingRequest,
} from './owner-document-rpc.js'
import { isEntityBindingRequest } from './entity-rpc.js'
import type { EntityDirectoryAuthority } from './entity-directory.js'

const MARKETPLACE_BINDING = '__cordisxMarketplaceRequestV1'
const MARKETPLACE_RECEIVER = '__cordisxMarketplaceReceiveV1'
const MAX_MARKETPLACE_REQUESTS = 4
const CDP_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_CDP_INJECTION_TIMEOUT_MS = 60_000
const MIN_CDP_INJECTION_TIMEOUT_MS = 5_000
const MAX_CDP_INJECTION_TIMEOUT_MS = 600_000
const MAX_RENDERER_DIAGNOSTIC_BYTES = 8_192

export function resolveCdpInjectionTimeoutMs(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_CDP_INJECTION_TIMEOUT_MS
  if (!/^\d+$/u.test(value)) {
    throw new Error('CORDISX_CDP_INJECTION_TIMEOUT_MS must be an integer number of milliseconds')
  }
  const timeoutMs = Number(value)
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_CDP_INJECTION_TIMEOUT_MS
    || timeoutMs > MAX_CDP_INJECTION_TIMEOUT_MS
  ) {
    throw new Error(
      `CORDISX_CDP_INJECTION_TIMEOUT_MS must be between ${MIN_CDP_INJECTION_TIMEOUT_MS} and ${MAX_CDP_INJECTION_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}

const CDP_INJECTION_TIMEOUT_MS = resolveCdpInjectionTimeoutMs(process.env.CORDISX_CDP_INJECTION_TIMEOUT_MS)
const VITE_DISPOSE_EXPRESSION = `(async () => {
  try {
    try { await globalThis.__cordisxViteClient?.dispose(); }
    finally { globalThis.__cordisxSharedReactRuntime?.dispose(); }
  } finally {
    try { await globalThis.__cordisxViteHmrDispose?.(); }
    finally {
      delete globalThis.__cordisxViteClient;
      delete globalThis.__cordisxSharedReactRuntime;
      delete globalThis.__cordisxViteBoot;
      delete globalThis.__cordisxViteInstallId;
      delete globalThis.__cordisxViteHmrDispose;
    }
  }
})()`
export const RENDERER_DISPOSE_EXPRESSION = `(async () => {
  const errors = []
  try {
    await globalThis.__cordisxRuntime?.dispose?.()
  } catch (error) {
    errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  try {
    globalThis.__cordisxPluginGenerationResourcesV1?.dispose?.()
  } catch (error) {
    errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  delete globalThis.__cordisxProductionBootstrapState
  delete globalThis.__cordisxProductionInstallId
  return errors.length === 0
    ? { ok: true }
    : { ok: false, error: errors.join('\\n') }
})()`

class CdpInstallationAbortedError extends Error {}

function cdpInstallationAborted(): CdpInstallationAbortedError {
  return new CdpInstallationAbortedError('CordisX CDP installation aborted')
}

async function abortable<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (signal === undefined) return await promise
  if (signal.aborted) throw cdpInstallationAborted()
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(cdpInstallationAborted())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

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
  private closed = false
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
      this.closed = true
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

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is closed'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request timed out: ${method}`))
      }, timeoutMs)
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
    this.closed = true
    this.socket.close()
  }

  isClosed(): boolean {
    return this.closed || this.socket.readyState !== WebSocket.OPEN
  }
}

async function evaluateRuntimeOperation<Value = void>(
  session: CdpSession,
  expression: string,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<Value> {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }, timeoutMs)
  const exception = runtimeEvaluationException(response)
  if (exception !== undefined) throw new Error(`renderer lifecycle evaluation failed: ${exception}`)
  const value = (response.result as { value?: unknown } | undefined)?.value as {
    ok?: unknown
    error?: unknown
    result?: Value
  } | undefined
  if (value?.ok !== true) {
    throw new Error(
      typeof value?.error === 'string'
        ? value.error.slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
        : 'renderer lifecycle operation returned ok=false without an error',
    )
  }
  return value.result as Value
}

/** Preserve a bounded renderer exception for launcher diagnostics. */
export function runtimeEvaluationException(response: Record<string, unknown>): string | undefined {
  const details = response.exceptionDetails
  if (details === undefined) return undefined
  if (details === null || typeof details !== 'object') {
    return String(details).slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
  }
  const record = details as {
    readonly text?: unknown
    readonly lineNumber?: unknown
    readonly columnNumber?: unknown
    readonly exception?: { readonly description?: unknown }
  }
  const description = typeof record.exception?.description === 'string'
    ? record.exception.description
    : typeof record.text === 'string'
    ? record.text
    : 'unknown Runtime.evaluate exception'
  const line = typeof record.lineNumber === 'number' ? record.lineNumber + 1 : undefined
  const column = typeof record.columnNumber === 'number' ? record.columnNumber + 1 : undefined
  const location = line === undefined ? '' : ` (line ${line}${column === undefined ? '' : `, column ${column}`})`
  return `${description}${location}`.slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
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
  private readonly joining = new Set<CdpSession>()
  private readonly staged = new Map<string, readonly CdpSession[]>()
  private readonly stagedMutations = new Map<string, PluginRuntimeMutation>()
  private readonly fences = new Map<string, RuntimeGenerationFence>()
  private registryEpoch = 0
  private permissionIdentities: PluginPermissionIdentityRegistry | undefined
  private ownerDocumentAuthority: {
    readonly leases: OwnerDocumentLeaseRegistry
    readonly issue: (
      identity: { readonly source: string; readonly pluginId: string },
      moduleGeneration: string,
    ) => OwnerDocumentPrincipalBinding
  } | undefined
  private entityAuthority: { readonly profileId: string; readonly authority: EntityDirectoryAuthority } | undefined
  private recoveredActivation: CordisXPluginActivationRecordV1 | undefined
  private readonly recoveredSessions = new WeakSet<CdpSession>()
  private readonly developmentStates = new Map<string, CordisXLocalDevelopmentSnapshot>()
  private readonly activeArtifactLeases = new Map<string, PluginGenerationGraphLease>()
  private developmentVersion = 0

  constructor(permissionIdentities?: PluginPermissionIdentityRegistry) {
    this.permissionIdentities = permissionIdentities
  }

  setPermissionIdentities(permissionIdentities: PluginPermissionIdentityRegistry): void {
    if (
      this.joining.size !== 0 || this.staged.size !== 0 || this.stagedMutations.size !== 0 || this.fences.size !== 0
    ) {
      throw new Error('cannot replace permission identities during a generation transaction')
    }
    this.permissionIdentities = permissionIdentities
  }

  setOwnerDocumentAuthority(authority: NonNullable<CdpPluginLifecycleRuntime['ownerDocumentAuthority']>): void {
    if (
      this.joining.size !== 0 || this.staged.size !== 0 || this.stagedMutations.size !== 0 || this.fences.size !== 0
    ) {
      throw new Error('cannot replace owner document authority during a generation transaction')
    }
    this.ownerDocumentAuthority = authority
  }

  setEntityAuthority(profileId: string, authority: EntityDirectoryAuthority): void {
    if (
      this.joining.size !== 0 || this.staged.size !== 0 || this.stagedMutations.size !== 0 || this.fences.size !== 0
    ) {
      throw new Error('cannot replace entity authority during a generation transaction')
    }
    this.entityAuthority = { profileId, authority }
  }

  /** Register a graph already selected by the durable activation used for cold boot. */
  registerActivePluginGenerationLease(lease: PluginGenerationGraphLease): void {
    if (this.joining.size !== 0 || this.fences.size !== 0 || this.staged.size !== 0) {
      throw new Error('cannot register an active browser graph during a generation transaction')
    }
    const current = this.activeArtifactLeases.get(lease.pluginId)
    if (current !== undefined && current.leaseId !== lease.leaseId) {
      throw new Error(`plugin ${lease.pluginId} already has an active browser graph lease`)
    }
    this.activeArtifactLeases.set(lease.pluginId, lease)
  }

  currentRegistryEpoch(): number {
    return this.registryEpoch
  }

  cancelPreparation(transactionId: string): void {
    if (this.staged.has(transactionId) || this.stagedMutations.has(transactionId)) {
      throw new Error('cannot cancel a staged plugin generation')
    }
    this.releaseTransaction(transactionId, 'abort')
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.fences.has(transactionId)) throw new Error('plugin generation fence already exists')
    if (
      this.joining.size !== 0 || this.fences.size !== 0 || this.staged.size !== 0 || this.stagedMutations.size !== 0
    ) {
      throw new Error('another plugin generation transaction is unresolved')
    }
    if (this.sessions.size === 0) throw new Error('no ready CordisX renderer is available')
    const fence = Object.freeze({
      transactionEpoch: `${transactionId}:${crypto.randomUUID()}`,
      expectedRegistryEpoch: this.registryEpoch,
    })
    this.fences.set(transactionId, fence)
    return fence
  }

  register(session: CdpSession): () => void {
    if (
      this.joining.size !== 0 || this.fences.size !== 0 || this.staged.size !== 0 || this.stagedMutations.size !== 0
    ) {
      throw new Error('cannot register a CordisX renderer during a plugin generation transaction')
    }
    this.sessions.add(session)
    return () => {
      this.sessions.delete(session)
      for (const [transactionId, sessions] of this.staged) {
        const remaining = sessions.filter(item => item !== session)
        if (remaining.length !== sessions.length) this.staged.set(transactionId, remaining)
      }
    }
  }

  /** Reserve one boot-ready renderer for cold recovery before normal admission. */
  beginJoin(session: CdpSession): {
    readonly commit: (developmentVersion: number) => (() => void) | undefined
    readonly abort: () => void
  } {
    if (
      this.joining.size !== 0 || this.fences.size !== 0
      || this.staged.size !== 0 || this.stagedMutations.size !== 0
    ) {
      throw new Error('cannot join a CordisX renderer during a plugin generation transaction')
    }
    this.joining.add(session)
    let settled = false
    return {
      commit: developmentVersion => {
        if (settled || !this.joining.has(session)) throw new Error('CordisX renderer join reservation is stale')
        // Synchronous compare-and-move is the join barrier. A status update
        // cannot interleave between this version check and sessions.add().
        if (developmentVersion !== this.developmentVersion) return undefined
        this.joining.delete(session)
        settled = true
        this.sessions.add(session)
        return () => {
          this.sessions.delete(session)
          for (const [transactionId, sessions] of this.staged) {
            const remaining = sessions.filter(item => item !== session)
            if (remaining.length !== sessions.length) this.staged.set(transactionId, remaining)
          }
        }
      },
      abort: () => {
        if (settled) return
        settled = true
        this.joining.delete(session)
      },
    }
  }

  private releaseTransaction(transactionId: string, permission: 'commit' | 'abort'): void {
    this.staged.delete(transactionId)
    this.stagedMutations.delete(transactionId)
    this.fences.delete(transactionId)
    this.permissionIdentities?.[permission](transactionId)
    this.ownerDocumentAuthority?.leases[permission](transactionId)
  }

  private async evaluateArtifactLease(
    sessions: readonly CdpSession[],
    source: string,
  ): Promise<void> {
    await Promise.all(sessions.map(async session => {
      const result = await session.send('Runtime.evaluate', {
        expression: source,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      })
      const value = (result.result as { value?: unknown } | undefined)?.value
      if (result.exceptionDetails !== undefined || value !== true) {
        throw new Error('plugin generation resource operation failed')
      }
    }))
  }

  private async retireArtifactLease(
    sessions: readonly CdpSession[],
    lease: PluginGenerationGraphLease,
  ): Promise<void> {
    await this.evaluateArtifactLease(sessions, lease.retireSource)
    lease.retire()
  }

  private async projectDevelopmentState(
    session: CdpSession,
    state: CordisXLocalDevelopmentSnapshot,
  ): Promise<void> {
    await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      await globalThis.__cordisxBoot
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      return { ok: true, result: runtime.updateLocalDevelopmentStatus(${JSON.stringify(state)}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
  }

  async updateDevelopmentStatus(state: CordisXLocalDevelopmentSnapshot): Promise<void> {
    this.developmentStates.set(state.sourcePath, structuredClone(state))
    this.developmentVersion += 1
    await Promise.all([...this.sessions].map(async session => await this.projectDevelopmentState(session, state)))
  }

  async synchronizeDevelopmentStatus(session: CdpSession): Promise<number> {
    while (true) {
      const version = this.developmentVersion
      const states = [...this.developmentStates.values()].map(state => structuredClone(state))
      for (const state of states) await this.projectDevelopmentState(session, state)
      if (version === this.developmentVersion) return version
    }
  }

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    const fence = this.fences.get(mutation.transactionId)
    if (
      fence === undefined
      || mutation.transactionEpoch !== fence.transactionEpoch
      || mutation.expectedRegistryEpoch !== fence.expectedRegistryEpoch
      || mutation.afterRegistryEpoch !== fence.expectedRegistryEpoch + 1
    ) {
      throw new Error('plugin generation mutation does not match its Host registry fence')
    }
    this.stagedMutations.set(mutation.transactionId, mutation)
    // Publish the participant snapshot before any awaited renderer work so a
    // concurrent target close can prune it, including the final participant.
    this.staged.set(mutation.transactionId, sessions)
    const { runtimeArtifactSource, runtimeArtifactLease, ...projectedMutation } = mutation
    const runtimePackage = mutation.package
    if (
      runtimePackage !== undefined
      && mutation.candidate.plugins.find(item => item.id === mutation.targetId)?.enabled === true
      && this.entityAuthority !== undefined
    ) {
      const binding = {
        profileId: this.entityAuthority.profileId,
        installationId: entityInstallationId(this.entityAuthority.profileId, mutation.targetId),
        pluginId: mutation.targetId,
        pluginGeneration: 1,
      }
      this.entityAuthority.authority.register(
        binding,
        runtimePackage.entityTemplates.map(template => template.declaration),
      )
      const materialized = await this.entityAuthority.authority.materialize(
        binding,
        runtimePackage.manifest.version,
        runtimePackage.digest,
        runtimePackage.entityTemplates,
      )
      const rejected = materialized.find(result => result.status === 'rejected')
      if (rejected !== undefined) throw new Error(`entity template ${rejected.agentId} was rejected: ${rejected.code}`)
    }
    const runtimeManifest = runtimePackage?.manifest?.runtimeManifest ?? mutation.developmentPackage?.manifest
    const isolatedArtifactSource = runtimeManifest !== undefined
        && (runtimeManifest.schemaVersion === 7
          || ((runtimeManifest.schemaVersion === 5 || runtimeManifest.schemaVersion === 6)
            && runtimeManifest.capabilities.some(capability => (
              capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
            ))))
      ? runtimePackage?.artifactSource ?? runtimeArtifactSource
      : undefined
    const candidateLeases = mutation.candidate.plugins.flatMap(item => {
      if (!item.enabled) return []
      const source = item.id === mutation.targetId && mutation.package?.identitySource !== undefined
        ? mutation.package.identitySource
        : this.ownerDocumentAuthority?.leases.source(item.id)
      return source === undefined ? [] : [{ source, pluginId: item.id, moduleGeneration: item.moduleGeneration }]
    })
    const rendererMutation = {
      ...projectedMutation,
      ...(isolatedArtifactSource === undefined ? {} : { isolatedArtifactSource }),
      ...(mutation.package === undefined ? {} : {
        package: {
          manifest: mutation.package.manifest,
          digest: mutation.package.digest,
          identitySource: mutation.package.identitySource,
          ...(mutation.package.readme === undefined ? {} : { readme: mutation.package.readme }),
        },
      }),
      ...(this.ownerDocumentAuthority === undefined ? {} : {
        ownerDocumentBindings: candidateLeases
          .filter(lease => mutation.affectedPluginIds.includes(lease.pluginId))
          .map(lease => this.ownerDocumentAuthority!.issue(lease, lease.moduleGeneration)),
      }),
    }
    const receipts: RuntimeReadinessObservation[] = []
    try {
      this.permissionIdentities?.stage(
        mutation.transactionId,
        mutation.operation,
        mutation.targetId,
        mutation.affectedPluginIds,
        mutation.package?.identitySource,
      )
      this.ownerDocumentAuthority?.leases.stage(mutation.transactionId, candidateLeases)
      const results = await Promise.allSettled(sessions.map(async session => {
        let artifactFailure: unknown
        if (mutation.package !== undefined || runtimeArtifactSource !== undefined) {
          try {
            await session.send('Runtime.evaluate', {
              expression:
                'delete globalThis.__cordisxPendingPluginModuleV1; delete globalThis.__cordisxPendingPluginModuleFactoryV1',
              allowUnsafeEvalBlockedByCSP: true,
            })
            if (isolatedArtifactSource === undefined) {
              const artifact = await session.send('Runtime.evaluate', {
                expression: runtimeArtifactLease === undefined
                  ? runtimeArtifactSource ?? mutation.package!.artifactSource
                  : `(async () => { globalThis.__cordisxPendingPluginModuleV1 = await (${runtimeArtifactSource}); return true })()`,
                ...(runtimeArtifactLease === undefined ? {} : { awaitPromise: true }),
                allowUnsafeEvalBlockedByCSP: true,
              })
              if (artifact.exceptionDetails !== undefined) {
                artifactFailure = new Error('plugin artifact evaluation failed')
              }
            }
          } catch (error) {
            artifactFailure = error
          }
        }
        const serialized = JSON.stringify(rendererMutation)
        const receipt = await evaluateRuntimeOperation<Omit<RuntimeReadinessObservation, 'observation'>>(
          session,
          `(async () => { try {
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
        } })()`,
        )
        if (artifactFailure !== undefined) throw artifactFailure
        return { ...receipt, observation: mutation.candidate }
      }))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      for (const result of results) if (result.status === 'fulfilled') receipts.push(result.value)
      if (failed !== undefined) throw failed.reason
      const first = receipts[0]!
      if (
        receipts.some(item =>
          item.transactionEpoch !== first.transactionEpoch
          || item.expectedRegistryEpoch !== first.expectedRegistryEpoch
          || item.afterRegistryEpoch !== first.afterRegistryEpoch
        )
      ) {
        throw new Error('CordisX renderer readiness receipts disagree')
      }
      return first
    } catch (error) {
      throw error
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimePublicationObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.publishPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || results.some(item =>
        item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
      )
    ) throw new Error('CordisX renderer publications disagree')
    const mutation = this.stagedMutations.get(transactionId)
    if (mutation?.runtimeArtifactLease !== undefined) {
      await this.evaluateArtifactLease(sessions, mutation.runtimeArtifactLease.publishSource)
    }
    this.registryEpoch = first.registryEpoch
    return first
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.completePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || results.some(item =>
        item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
      )
    ) throw new Error('CordisX renderer cleanup observations disagree')
    return first
  }

  async finalize(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    const mutation = this.stagedMutations.get(transactionId)
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.finalizePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    if (mutation !== undefined) {
      const candidateLease = mutation.runtimeArtifactLease
      for (const pluginId of mutation.affectedPluginIds) {
        const candidate = mutation.candidate.plugins.find(plugin => plugin.id === pluginId)
        const previousLease = this.activeArtifactLeases.get(pluginId)
        if (pluginId === mutation.targetId && candidate?.enabled === true && candidateLease !== undefined) {
          if (previousLease !== undefined && previousLease.leaseId !== candidateLease.leaseId) {
            await this.retireArtifactLease(sessions, previousLease)
          }
          this.activeArtifactLeases.set(pluginId, candidateLease)
        } else if (candidate?.enabled !== true || (pluginId === mutation.targetId && mutation.package !== undefined)) {
          if (previousLease !== undefined) await this.retireArtifactLease(sessions, previousLease)
          this.activeArtifactLeases.delete(pluginId)
        }
      }
    }
    this.releaseTransaction(transactionId, 'commit')
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    if (sessions.length === 0) {
      const mutation = this.stagedMutations.get(transactionId)
      const fence = this.fences.get(transactionId)
      if (mutation === undefined || fence === undefined) throw new Error('unknown plugin generation transaction')
      // No renderer can still observe the candidate. Advance the Host to the
      // monotonic rollback epoch required by the shared lifecycle authority.
      const rollbackRegistryEpoch = mutation.afterRegistryEpoch! + 1
      const restored = {
        transactionId,
        transactionEpoch: fence.transactionEpoch,
        registryEpoch: rollbackRegistryEpoch,
        active: mutation.previous,
        disposedAfter: mutation.candidate,
      }
      if (mutation.runtimeArtifactLease !== undefined) mutation.runtimeArtifactLease.retire()
      this.registryEpoch = rollbackRegistryEpoch
      this.releaseTransaction(transactionId, 'abort')
      return restored
    }
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.rollbackPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || first.transactionId !== transactionId
      || results.some(item =>
        item.transactionId !== first.transactionId
        || item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
        || JSON.stringify(item.active) !== JSON.stringify(first.active)
        || JSON.stringify(item.disposedAfter) !== JSON.stringify(first.disposedAfter)
      )
    ) {
      throw new Error('CordisX renderer rollback observations disagree')
    }
    const mutation = this.stagedMutations.get(transactionId)
    if (mutation?.runtimeArtifactLease !== undefined) {
      await this.retireArtifactLease(sessions, mutation.runtimeArtifactLease)
    }
    this.registryEpoch = first.registryEpoch
    this.releaseTransaction(transactionId, 'abort')
    return first
  }

  async recoverRollback(plan: RollbackPlan): Promise<RuntimeCleanupObservation> {
    const sessions = [...this.sessions, ...this.joining]
    const recovery = {
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      registryEpoch: plan.rollbackRegistryEpoch,
      active: activationRecord(plan.rollbackTarget),
      disposedAfter: activationRecord(plan.expectedPublished),
    }
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
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
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || first.transactionId !== plan.transactionId
      || first.transactionEpoch !== plan.transactionEpoch
      || first.registryEpoch !== plan.rollbackRegistryEpoch
      || results.some(item =>
        item.transactionId !== first.transactionId
        || item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
        || JSON.stringify(item.active) !== JSON.stringify(first.active)
        || JSON.stringify(item.disposedAfter) !== JSON.stringify(first.disposedAfter)
      )
    ) {
      throw new Error('CordisX renderer recovery observations disagree')
    }
    this.registryEpoch = first.registryEpoch
    this.releaseTransaction(plan.transactionId, 'abort')
    return first
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const sessions = [...this.sessions, ...this.joining]
    await Promise.all(
      sessions.map(async session => await this.adoptRecoveredActivationFor(session, active, registryEpoch)),
    )
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
    await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.adoptRecoveredActivation(${JSON.stringify(active)}, ${JSON.stringify(registryEpoch)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
    this.recoveredSessions.add(session)
  }

  async commit(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.commitPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    this.releaseTransaction(transactionId, 'commit')
  }

  async abort(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    const mutation = this.stagedMutations.get(transactionId)
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.abortPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    if (mutation?.runtimeArtifactLease !== undefined) {
      await this.retireArtifactLease(sessions, mutation.runtimeArtifactLease)
    }
    this.releaseTransaction(transactionId, 'abort')
  }

  async reload(
    input: { readonly pluginId: string; readonly moduleGeneration: string; readonly runtimeGeneration: string },
  ): Promise<void> {
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.reloadPluginGeneration(${JSON.stringify(input.pluginId)}, ${
          JSON.stringify(input.moduleGeneration)
        }, ${JSON.stringify(input.runtimeGeneration)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted === true) finish()
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

function nativeAppTarget(target: CdpTarget): boolean {
  return target.url === 'app://-' || target.url.startsWith('app://-/')
}

interface InstalledScript {
  readonly viteDevelopment?: boolean
  readonly loopbackModules?: boolean
  readonly viteLoopbackPermission?: {
    readonly name: string
    readonly origin: string
  }
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
  readonly ownerDocumentController?: AbortController
  readonly removeOwnerDocumentBindingListener?: () => void
  readonly ownerDocumentBindingInstalled: boolean
  readonly serviceConfigController?: AbortController
  readonly removeServiceConfigBindingListener?: () => void
  readonly serviceConfigBindingInstalled: boolean
  readonly credentialController?: AbortController
  readonly removeCredentialBindingListener?: () => void
  readonly credentialBindingInstalled: boolean
  readonly actionsController?: AbortController
  readonly removeActionsBindingListener?: () => void
  readonly actionsBindingInstalled: boolean
  readonly permissionController?: AbortController
  readonly removePermissionBindingListener?: () => void
  readonly permissionBindingInstalled: boolean
  readonly iconThemePreferenceController?: AbortController
  readonly removeIconThemePreferenceBindingListener?: () => void
  readonly iconThemePreferenceBindingInstalled: boolean
  readonly unregisterIconThemePreferenceBroadcast?: () => void
  readonly lifecycleController?: AbortController
  readonly removeLifecycleBindingListener?: () => void
  readonly lifecycleBindingInstalled: boolean
  readonly unregisterLifecycleSession: () => void
  readonly publisherGrantController?: AbortController
  readonly removePublisherGrantBindingListener?: () => void
  readonly publisherGrantBindingInstalled: boolean
  readonly certifiedPermissionChannel?: CdpCertifiedPermissionChannel
}

const VITE_LOOPBACK_PERMISSIONS = ['loopback-network', 'local-network-access'] as const

function targetOrigin(target: CdpTarget): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/iu.exec(target.url)
  if (match === null) throw new Error(`target ${target.id} has no permission origin`)
  return match[0]
}

async function enableViteLoopbackPermission(
  session: CdpSession,
  target: CdpTarget,
): Promise<{ readonly name: string; readonly origin: string } | undefined> {
  const origin = targetOrigin(target)
  const failures: string[] = []
  for (const name of VITE_LOOPBACK_PERMISSIONS) {
    try {
      await session.send('Browser.setPermission', {
        permission: { name },
        setting: 'granted',
        origin,
        embeddedOrigin: origin,
      })
      return { name, origin }
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const version: Record<string, unknown> = await session.send('Browser.getVersion').catch(() => ({}))
  const product = typeof version.product === 'string' ? version.product : ''
  const major = Number(/\/(\d+)/u.exec(product)?.[1])
  if (Number.isFinite(major) && major < 142) return undefined
  throw new Error(`CordisX could not grant renderer loopback access (${failures.join('; ')})`)
}

async function restoreViteLoopbackPermission(
  session: CdpSession,
  permission: { readonly name: string; readonly origin: string } | undefined,
): Promise<void> {
  if (permission === undefined) return
  await session.send('Browser.setPermission', {
    permission: { name: permission.name },
    setting: 'prompt',
    origin: permission.origin,
    embeddedOrigin: permission.origin,
  })
}

async function connectBrowserCdpSession(port: number): Promise<CdpSession> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP browser version returned HTTP ${response.status}`)
  const value = await response.json() as { readonly webSocketDebuggerUrl?: unknown }
  if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('CDP browser endpoint is unavailable')
  return await CdpSession.connect(value.webSocketDebuggerUrl)
}

class ViteLoopbackPermissionCoordinator {
  readonly #origins = new Map<string, {
    readonly permission: { readonly name: string; readonly origin: string }
    references: number
  }>()

  constructor(private readonly port: number) {}

  async acquire(
    session: CdpSession,
    target: CdpTarget,
  ): Promise<{ readonly name: string; readonly origin: string } | undefined> {
    const origin = targetOrigin(target)
    const current = this.#origins.get(origin)
    if (current !== undefined) {
      current.references += 1
      return current.permission
    }
    const permission = await enableViteLoopbackPermission(session, target)
    if (permission !== undefined) this.#origins.set(origin, { permission, references: 1 })
    return permission
  }

  async release(
    session: CdpSession,
    permission: { readonly name: string; readonly origin: string } | undefined,
  ): Promise<void> {
    if (permission === undefined) return
    const current = this.#origins.get(permission.origin)
    if (current === undefined) return
    if (current.references === 0) return
    current.references -= 1
    if (current.references > 0) return
    try {
      await restoreViteLoopbackPermission(session, current.permission)
    } catch (targetError) {
      let browser: CdpSession | undefined
      try {
        browser = await connectBrowserCdpSession(this.port)
        await restoreViteLoopbackPermission(browser, current.permission)
      } catch (browserError) {
        // Retain the zero-reference grant so a later live target can restore it.
        throw new AggregateError(
          [targetError, browserError],
          `CordisX could not restore Vite loopback permission for ${permission.origin}`,
        )
      } finally {
        browser?.close()
      }
    }
    this.#origins.delete(permission.origin)
  }
}

async function waitForViteBootstrap(
  session: CdpSession,
  installId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw cdpInstallationAborted()
    try {
      await abortable(
        evaluateRuntimeOperation(
          session,
          `(async () => { try {
        if (globalThis.__cordisxViteInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'cordisx:vite-boot-pending' }
        if (!globalThis.__cordisxViteBoot) return { ok: false, error: 'cordisx:vite-boot-pending' }
        await globalThis.__cordisxViteBoot
        return { ok: globalThis.__cordisxRuntime !== undefined }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      )
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const transient = lastError.message === 'cordisx:vite-boot-pending'
        || /Execution context was destroyed|Cannot find context|Inspected target navigated|CDP request timed out: Runtime\.evaluate/i
          .test(lastError.message)
      if (!transient || session.isClosed()) throw lastError
      await delay(100, signal)
    }
  }
  throw new Error(`CordisX Vite bootstrap timed out${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

async function waitForProductionBootstrap(
  session: CdpSession,
  installId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw cdpInstallationAborted()
    try {
      await abortable(
        evaluateRuntimeOperation(
          session,
          `(async () => { try {
        if (globalThis.__cordisxProductionInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'cordisx:production-boot-pending' }
        const state = globalThis.__cordisxProductionBootstrapState
        if (state?.installId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'CordisX production bootstrap state does not match its install marker' }
        if (state.status === 'failed') return { ok: false, error: state.error }
        if (state.status !== 'evaluated') return { ok: false, error: 'cordisx:production-boot-pending' }
        const boot = globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot
        if (!boot) return { ok: false, error: 'CordisX production bootstrap defined no boot promise' }
        await boot
        if (globalThis.__cordisxProductionInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'CordisX production bootstrap was superseded during boot' }
        if (globalThis.__cordisxRuntime === undefined) {
          return { ok: false, error: 'CordisX production runtime is undefined after boot' }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      } })()`,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      )
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const transient = lastError.message === 'cordisx:production-boot-pending'
        || /Execution context was destroyed|Cannot find context|Inspected target navigated|CDP request timed out: Runtime\.evaluate/i
          .test(lastError.message)
      if (!transient || session.isClosed()) throw lastError
      await delay(100, signal)
    }
  }
  throw new Error(`CordisX production bootstrap timed out${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

function installedBindingNames(installed: InstalledScript): readonly string[] {
  return [
    MARKETPLACE_BINDING,
    ...(installed.providerBindingInstalled ? [PROVIDER_BINDING] : []),
    ...(installed.historyBindingInstalled ? [AGENT_HISTORY_BINDING] : []),
    ...(installed.configBindingInstalled ? [CONFIG_BINDING] : []),
    ...(installed.ownerDocumentBindingInstalled ? [OWNER_DOCUMENT_BINDING] : []),
    ...(installed.serviceConfigBindingInstalled ? [SERVICE_CONFIG_BINDING] : []),
    ...(installed.credentialBindingInstalled ? [CHANNEL_CREDENTIAL_BINDING] : []),
    ...(installed.actionsBindingInstalled ? [CHANNEL_ACTIONS_BINDING] : []),
    ...(installed.permissionBindingInstalled ? [PERMISSION_BINDING] : []),
    ...(installed.iconThemePreferenceBindingInstalled ? [ICON_THEME_PREFERENCE_BINDING] : []),
    ...(installed.lifecycleBindingInstalled ? [PLUGIN_LIFECYCLE_BINDING] : []),
    ...(installed.publisherGrantBindingInstalled ? [PUBLISHER_GRANT_BINDING] : []),
  ]
}

interface MarketplaceBindingRequest {
  readonly requestId: string
  readonly url: string
}

function parseMarketplaceBindingRequest(value: unknown): MarketplaceBindingRequest {
  if (value === null || typeof value !== 'object') throw new Error('invalid marketplace bridge request')
  const requestId = (value as { requestId?: unknown }).requestId
  const url = (value as { url?: unknown }).url
  if (typeof requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(requestId)) {
    throw new Error('invalid marketplace bridge request id')
  }
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    throw new Error('invalid marketplace bridge URL')
  }
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

async function sendOwnerDocumentBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${OWNER_DOCUMENT_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendIconThemePreferenceBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
  executionContextId?: number,
): Promise<void> {
  const response = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const receiver = globalThis.${ICON_THEME_PREFERENCE_RECEIVER}
      if (typeof receiver !== 'function') throw new Error('icon theme preference receiver is unavailable')
      receiver(${JSON.stringify(JSON.stringify(payload))})
      return true
    })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
  })
  const remote = response.result
  if (remote === null || typeof remote !== 'object' || (remote as { value?: unknown }).value !== true) {
    throw new Error('icon theme preference response delivery failed')
  }
}

export function iconThemePreferenceDeliveryEvaluation(
  payload: Record<string, unknown>,
  documentEpoch: string,
  minimumRevision: number,
  executionContextId: number,
): Record<string, unknown> {
  return {
    expression: `(() => {
      const receiver = globalThis.${ICON_THEME_PREFERENCE_RECEIVER}
      if (typeof receiver !== 'function') throw new Error('icon theme preference receiver is unavailable')
      const ack = receiver(${JSON.stringify(JSON.stringify(payload))})
      if (ack === null || typeof ack !== 'object'
        || ack.documentEpoch !== ${JSON.stringify(documentEpoch)}
        || !Number.isSafeInteger(ack.currentRevision)
        || ack.currentRevision < ${minimumRevision}) {
        throw new Error('icon theme preference delivery acknowledgement is invalid')
      }
      return ack
    })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    contextId: executionContextId,
  }
}

async function deliverIconThemePreferenceToDocument(
  session: CdpSession,
  payload: Record<string, unknown>,
  documentEpoch: string,
  minimumRevision: number,
  executionContextId: number,
  signal?: AbortSignal,
): Promise<{
  readonly documentEpoch: string
  readonly currentRevision: number
  readonly readyLeaseToken?: string
  readonly readyLeaseRevision?: number
}> {
  const evaluation = session.send(
    'Runtime.evaluate',
    iconThemePreferenceDeliveryEvaluation(
      payload,
      documentEpoch,
      minimumRevision,
      executionContextId,
    ),
  )
  let response
  if (signal === undefined) {
    response = await evaluation
  } else {
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject
    })
    const onAbort = (): void => rejectCancelled(new Error('icon theme preference document delivery was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      response = await Promise.race([evaluation, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const remote = response.result
  const value = remote !== null && typeof remote === 'object'
    ? (remote as { value?: unknown }).value
    : undefined
  if (value === null || typeof value !== 'object') throw new Error('icon theme preference delivery failed')
  const ack = value as {
    documentEpoch?: unknown
    currentRevision?: unknown
    readyLeaseToken?: unknown
    readyLeaseRevision?: unknown
  }
  if (
    ack.documentEpoch !== documentEpoch || !Number.isSafeInteger(ack.currentRevision)
    || (ack.currentRevision as number) < minimumRevision
  ) {
    throw new Error('icon theme preference delivery acknowledgement is invalid')
  }
  return {
    documentEpoch,
    currentRevision: ack.currentRevision as number,
    ...(typeof ack.readyLeaseToken === 'string' ? { readyLeaseToken: ack.readyLeaseToken } : {}),
    ...(Number.isSafeInteger(ack.readyLeaseRevision) ? { readyLeaseRevision: ack.readyLeaseRevision as number } : {}),
  }
}
async function sendPublisherGrantBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PUBLISHER_GRANT_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export function serviceConfigResponseEvaluation(
  payload: Record<string, unknown>,
  executionContextId?: number,
): Record<string, unknown> {
  return {
    expression:
      `(() => { const receiver = globalThis.${SERVICE_CONFIG_RECEIVER}; if (typeof receiver !== 'function') return false; receiver(${
        JSON.stringify(JSON.stringify(payload))
      }); return true })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
  }
}

function serviceConfigResponseDelivered(result: Record<string, unknown>): boolean {
  const remote = result.result
  return remote !== null && typeof remote === 'object' && (remote as Record<string, unknown>).value === true
}

async function sendServiceConfigBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
  executionContextId?: number,
): Promise<void> {
  const exact = await session.send('Runtime.evaluate', serviceConfigResponseEvaluation(payload, executionContextId))
  if (serviceConfigResponseDelivered(exact) || executionContextId === undefined) return
  await session.send('Runtime.evaluate', serviceConfigResponseEvaluation(payload))
}

async function sendChannelCredentialBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CHANNEL_CREDENTIAL_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendChannelActionsBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CHANNEL_ACTIONS_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendPermissionBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PERMISSION_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

async function sendPluginLifecycleBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
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
  ownerDocuments?: OwnerDocumentBridgeHandler,
  serviceConfig?: ServiceConfigBridgeHandler,
  credential?: ChannelCredentialBridgeHandler,
  actions?: ChannelActionsBridgeHandler,
  permission?: PermissionPersistenceContext,
  iconThemePreference?: IconThemePreferencePersistenceContext,
  iconThemePreferenceBroadcast?: IconThemePreferenceBroadcastHub,
  lifecycle?: { readonly handler: PluginLifecycleBridgeHandler; readonly runtime: CdpPluginLifecycleRuntime },
  developmentRuntime?: CdpPluginLifecycleRuntime,
  publisherGrant?: PublisherGrantBridgeHandler,
  certifiedPermission?: Readonly<{
    authority: LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>,
  newDocumentSource?: string,
  stale?: InstalledScript,
  viteDevelopment = false,
  loopbackModules = false,
  viteLoopbackPermissions?: ViteLoopbackPermissionCoordinator,
  signal?: AbortSignal,
): Promise<InstalledScript> {
  if (iconThemePreferenceBroadcast !== undefined) {
    if (iconThemePreference === undefined) {
      throw new Error('icon theme preference broadcast requires persistence context')
    }
    iconThemePreferenceBroadcast.assertScope(iconThemePreference)
  }
  const url = target.webSocketDebuggerUrl
  if (url === undefined) throw new Error(`target ${target.id} has no websocket URL`)
  const session = await CdpSession.connect(url)
  const marketplaceController = new AbortController()
  const providerController = provider === undefined ? undefined : new AbortController()
  const historyController = history === undefined ? undefined : new AbortController()
  const configController = config === undefined ? undefined : new AbortController()
  const ownerDocumentController = ownerDocuments === undefined ? undefined : new AbortController()
  const serviceConfigController = serviceConfig === undefined ? undefined : new AbortController()
  const credentialController = credential === undefined ? undefined : new AbortController()
  const actionsController = actions === undefined ? undefined : new AbortController()
  const permissionController = permission === undefined ? undefined : new AbortController()
  const iconThemePreferenceController = iconThemePreference === undefined ? undefined : new AbortController()
  const lifecycleController = lifecycle === undefined ? undefined : new AbortController()
  const publisherGrantController = publisherGrant === undefined ? undefined : new AbortController()
  let removeBindingListener = (): void => {}
  let removeProviderBindingListener = (): void => {}
  let removeHistoryBindingListener = (): void => {}
  let removeConfigBindingListener = (): void => {}
  let removeOwnerDocumentBindingListener = (): void => {}
  let removeServiceConfigBindingListener = (): void => {}
  let removeCredentialBindingListener = (): void => {}
  let removeActionsBindingListener = (): void => {}
  let removePermissionBindingListener = (): void => {}
  let removeIconThemePreferenceBindingListener = (): void => {}
  let unregisterCurrentIconThemeDocument: (() => void) | undefined
  let activeIconThemeDocumentController: AbortController | undefined
  let iconThemeDocumentFence = 0
  let iconThemeDocumentQueue = Promise.resolve()
  const iconThemeSessionId = randomUUID()
  const iconThemePreferenceClosed = (): boolean => iconThemePreferenceController?.signal.aborted === true
  const unregisterIconThemePreferenceBroadcast = iconThemePreferenceBroadcast === undefined
    ? undefined
    : (): void => {
      iconThemeDocumentFence += 1
      activeIconThemeDocumentController?.abort()
      activeIconThemeDocumentController = undefined
      unregisterCurrentIconThemeDocument?.()
      unregisterCurrentIconThemeDocument = undefined
    }
  let removeLifecycleBindingListener = (): void => {}
  let unregisterLifecycleSession = (): void => {}
  let generationJoin: ReturnType<CdpPluginLifecycleRuntime['beginJoin']> | undefined
  let removePublisherGrantBindingListener = (): void => {}
  let certifiedPermissionChannel: CdpCertifiedPermissionChannel | undefined
  let identifier: string | undefined
  let viteLoopbackPermission: { readonly name: string; readonly origin: string } | undefined
  let loopbackReloadStarted = false
  try {
    if (certifiedPermission !== undefined) {
      certifiedPermissionChannel = new CdpCertifiedPermissionChannel(session, {
        ...certifiedPermission,
        targetId: target.id,
      })
    }
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    if (loopbackModules) {
      viteLoopbackPermission = viteLoopbackPermissions === undefined
        ? await enableViteLoopbackPermission(session, target)
        : await viteLoopbackPermissions.acquire(session, target)
      await session.send('Page.setBypassCSP', { enabled: true })
    }
    if (stale !== undefined) {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: stale.identifier,
      }).catch(() => undefined)
      await Promise.allSettled(
        installedBindingNames(stale).map(async name => {
          await session.send('Runtime.removeBinding', { name })
        }),
      )
    }
    await session.send('Runtime.addBinding', { name: MARKETPLACE_BINDING })
    if (provider !== undefined) await session.send('Runtime.addBinding', { name: PROVIDER_BINDING })
    if (history !== undefined) await session.send('Runtime.addBinding', { name: AGENT_HISTORY_BINDING })
    if (config !== undefined) await session.send('Runtime.addBinding', { name: CONFIG_BINDING })
    if (ownerDocuments !== undefined) await session.send('Runtime.addBinding', { name: OWNER_DOCUMENT_BINDING })
    if (serviceConfig !== undefined) await session.send('Runtime.addBinding', { name: SERVICE_CONFIG_BINDING })
    if (credential !== undefined) await session.send('Runtime.addBinding', { name: CHANNEL_CREDENTIAL_BINDING })
    if (actions !== undefined) await session.send('Runtime.addBinding', { name: CHANNEL_ACTIONS_BINDING })
    if (permission !== undefined) await session.send('Runtime.addBinding', { name: PERMISSION_BINDING })
    if (iconThemePreference !== undefined) {
      await session.send('Runtime.addBinding', { name: ICON_THEME_PREFERENCE_BINDING })
    }
    if (lifecycle !== undefined) await session.send('Runtime.addBinding', { name: PLUGIN_LIFECYCLE_BINDING })
    if (publisherGrant !== undefined) await session.send('Runtime.addBinding', { name: PUBLISHER_GRANT_BINDING })
    let activeMarketplaceRequests = 0
    removeBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
      if (params.name !== MARKETPLACE_BINDING || typeof params.payload !== 'string') return
      const payload = params.payload
      void (async () => {
        let requestId = 'invalid'
        try {
          const requestValue = parseMarketplaceBindingRequest(JSON.parse(payload) as unknown)
          requestId = requestValue.requestId
          if (activeMarketplaceRequests >= MAX_MARKETPLACE_REQUESTS) {
            throw new Error('too many concurrent marketplace feed requests')
          }
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
            if (Buffer.byteLength(payload) > MAX_PROVIDER_REQUEST_BYTES) {
              throw new Error('provider request exceeds maximum size')
            }
            const request = parseProviderBindingRequest(JSON.parse(payload) as unknown, provider.token)
            requestId = request.requestId
            if (providerController?.signal.aborted === true) throw new Error('provider request bridge is closed')
            if (activeProviderRequests >= MAX_PROVIDER_REQUESTS) {
              throw new Error('too many concurrent provider requests')
            }
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
            if (Buffer.byteLength(payload) > MAX_AGENT_HISTORY_REQUEST_BYTES) {
              throw new Error('Agent history request exceeds maximum size')
            }
            const request = parseAgentHistoryBindingRequest(JSON.parse(payload) as unknown, history.token)
            requestId = request.requestId
            if (historyController?.signal.aborted === true) throw new Error('Agent history bridge is closed')
            if (activeHistoryRequests >= MAX_AGENT_HISTORY_REQUESTS) {
              throw new Error('too many concurrent Agent history requests')
            }
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
            if (Buffer.byteLength(payload) > MAX_CONFIG_REQUEST_BYTES) {
              throw new Error('config request exceeds maximum size')
            }
            const request = parseConfigBindingRequest(
              JSON.parse(payload) as unknown,
              config.token,
              config.profileId,
              config.generation,
            )
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
    let activeOwnerDocumentRequests = 0
    if (ownerDocuments !== undefined) {
      removeOwnerDocumentBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== OWNER_DOCUMENT_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          let entityRequest = false
          try {
            if (Buffer.byteLength(payload) > MAX_OWNER_DOCUMENT_REQUEST_BYTES) {
              throw new Error('owner document request exceeds maximum size')
            }
            const parsed = JSON.parse(payload) as unknown
            const generic = parsed as { readonly requestId?: unknown }
            requestId = typeof generic.requestId === 'string' ? generic.requestId : 'invalid'
            entityRequest = isEntityBindingRequest(parsed)
            if (ownerDocumentController?.signal.aborted === true) throw new Error('owner document bridge is closed')
            if (activeOwnerDocumentRequests >= MAX_OWNER_DOCUMENT_REQUESTS) {
              throw new Error('too many owner document requests')
            }
            activeOwnerDocumentRequests += 1
            try {
              const value = entityRequest && ownerDocuments.entities !== undefined
                ? await ownerDocuments.entities.handle(parsed)
                : await (async () => {
                  const request = parseOwnerDocumentBindingRequest(parsed)
                  return request.operation === 'load'
                    ? await ownerDocuments.load(request)
                    : await ownerDocuments.replace(request)
                })()
              await sendOwnerDocumentBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeOwnerDocumentRequests -= 1
            }
          } catch (error) {
            if (entityRequest) {
              await sendOwnerDocumentBindingResponse(session, {
                requestId,
                ok: false,
                error: error instanceof Error ? error.message : 'entity request rejected',
              }).catch(() => undefined)
              return
            }
            await sendOwnerDocumentBindingResponse(session, {
              requestId,
              ok: true,
              value: ownerDocumentBridgeError(),
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
            if (Buffer.byteLength(payload) > MAX_SERVICE_CONFIG_REQUEST_BYTES) {
              throw new Error('service configuration request exceeds maximum size')
            }
            const request = parseServiceConfigBindingRequest(
              JSON.parse(payload) as unknown,
              serviceConfig.token,
              serviceConfig.profileId,
              serviceConfig.generation,
            )
            requestId = request.requestId
            if (serviceConfigController?.signal.aborted === true) {
              throw new Error('service configuration bridge is closed')
            }
            if (activeServiceConfigRequests >= 1) {
              throw new Error('another service configuration request is already active')
            }
            activeServiceConfigRequests += 1
            let value: unknown
            try {
              value = await serviceConfig.handle(request)
            } finally {
              activeServiceConfigRequests -= 1
            }
            // The renderer may immediately use a descriptor to submit its CAS
            // mutation. Release the single-flight seat before publishing the
            // response, otherwise that legitimate follow-up races its own
            // completed read and is incorrectly rejected as concurrent.
            await sendServiceConfigBindingResponse(session, { requestId, ok: true, value }, executionContextId)
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
    if (credential !== undefined) {
      removeCredentialBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== CHANNEL_CREDENTIAL_BINDING || typeof params.payload !== 'string') return
        void (async () => {
          const payload = params.payload as string
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES) {
              throw new Error('channel credential request exceeds maximum size')
            }
            const raw = JSON.parse(payload) as { requestId?: unknown }
            requestId = typeof raw.requestId === 'string' ? raw.requestId : requestId
            if (credentialController?.signal.aborted === true) throw new Error('channel credential bridge is closed')
            const value = await credential.handle(raw)
            await sendChannelCredentialBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await sendChannelCredentialBindingResponse(session, {
              requestId,
              ok: false,
              code: 'channel-credential-unavailable',
            }).catch(() => undefined)
          }
        })()
      })
    }
    if (actions !== undefined) {
      removeActionsBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== CHANNEL_ACTIONS_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            const raw = JSON.parse(payload) as { requestId?: unknown }
            requestId = typeof raw.requestId === 'string' ? raw.requestId : requestId
            if (actionsController?.signal.aborted === true) throw new Error('channel action bridge is closed')
            const value = await actions.handle(raw)
            await sendChannelActionsBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await sendChannelActionsBindingResponse(session, {
              requestId,
              ok: false,
              code: 'channel-action-unavailable',
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
            if (Buffer.byteLength(payload) > MAX_PERMISSION_REQUEST_BYTES) {
              throw new Error('permission request exceeds maximum size')
            }
            const request = parsePermissionBindingRequest(JSON.parse(payload) as unknown, permission)
            requestId = request.requestId
            if (permissionController?.signal.aborted === true) {
              throw new Error('permission persistence bridge is closed')
            }
            if (activePermissionRequests >= MAX_PERMISSION_REQUESTS) {
              throw new Error('too many concurrent permission requests')
            }
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
    let activeIconThemePreferenceRequests = 0
    if (iconThemePreference !== undefined) {
      removeIconThemePreferenceBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== ICON_THEME_PREFERENCE_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          let documentEpoch: string | undefined
          const executionContextId = typeof params.executionContextId === 'number'
            ? params.executionContextId
            : undefined
          try {
            if (Buffer.byteLength(payload) > MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES) {
              throw new Error('icon theme preference request exceeds maximum size')
            }
            const raw = JSON.parse(payload) as unknown
            if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'document-ready') {
              const ready = parseIconThemePreferenceDocumentReadyRequest(raw, iconThemePreference)
              requestId = ready.requestId
              documentEpoch = ready.documentEpoch
              if (executionContextId === undefined) {
                throw new Error('icon theme preference document execution context is unavailable')
              }
              if (iconThemePreferenceBroadcast === undefined) {
                throw new Error('icon theme preference broadcast is unavailable')
              }
              const previousController = activeIconThemeDocumentController
              const previousUnregister = unregisterCurrentIconThemeDocument
              const documentController = new AbortController()
              const reservation = iconThemePreferenceBroadcast.reserve({
                targetId: target.id,
                sessionId: iconThemeSessionId,
                documentEpoch: ready.documentEpoch,
                executionContextId,
                currentRevision: ready.currentRevision,
                signal: documentController.signal,
              })
              activeIconThemeDocumentController = documentController
              unregisterCurrentIconThemeDocument = reservation.cancel
              const fence = ++iconThemeDocumentFence
              previousController?.abort()
              previousUnregister?.()
              iconThemeDocumentQueue = iconThemeDocumentQueue.catch(() => undefined).then(async () => {
                if (
                  iconThemePreferenceClosed() || documentController.signal.aborted || fence !== iconThemeDocumentFence
                ) {
                  throw new Error('icon theme preference document ready request is stale')
                }
                const registration = await reservation.register({
                  receive: async preference =>
                    await deliverIconThemePreferenceToDocument(
                      session,
                      { kind: 'sync', value: preference },
                      ready.documentEpoch,
                      preference.revision,
                      executionContextId,
                      documentController.signal,
                    ),
                })
                if (
                  iconThemePreferenceClosed() || documentController.signal.aborted || fence !== iconThemeDocumentFence
                ) {
                  registration.unregister()
                  throw new Error('icon theme preference document ready request is stale')
                }
                const probeAck = await deliverIconThemePreferenceToDocument(
                  session,
                  { kind: 'document-ready-probe' },
                  ready.documentEpoch,
                  registration.currentRevision,
                  executionContextId,
                  documentController.signal,
                )
                await registration.respondReady(
                  probeAck,
                  async (status, lease): Promise<IconThemePreferenceReadyResponseAck> => {
                    const ack = await deliverIconThemePreferenceToDocument(
                      session,
                      {
                        kind: 'document-ready',
                        requestId: ready.requestId,
                        ok: true,
                        documentEpoch: ready.documentEpoch,
                        readyLeaseToken: lease.token,
                        readyLeaseRevision: lease.revision,
                        ...status,
                      },
                      ready.documentEpoch,
                      status.currentRevision,
                      executionContextId,
                      lease.signal,
                    )
                    if (ack.readyLeaseToken !== lease.token || ack.readyLeaseRevision !== lease.revision) {
                      throw new Error('icon theme preference ready response lease acknowledgement is invalid')
                    }
                    return {
                      documentEpoch: ack.documentEpoch,
                      currentRevision: ack.currentRevision,
                      readyLeaseToken: ack.readyLeaseToken,
                      readyLeaseRevision: ack.readyLeaseRevision,
                    }
                  },
                )
              })
              await iconThemeDocumentQueue
              return
            }
            const request = parseIconThemePreferenceBindingRequest(raw, iconThemePreference)
            requestId = request.requestId
            if (iconThemePreferenceController?.signal.aborted === true) {
              throw new Error('icon theme preference bridge is closed')
            }
            if (activeIconThemePreferenceRequests >= 1) {
              throw new Error('another icon theme preference request is active')
            }
            activeIconThemePreferenceRequests += 1
            let value
            try {
              value = await persistIconThemePreference(iconThemePreference, request)
            } finally {
              activeIconThemePreferenceRequests -= 1
            }
            const synchronization = iconThemePreferenceBroadcast === undefined
              ? 'pending'
              : (await iconThemePreferenceBroadcast.broadcast(value)).pending === 0
              ? 'complete'
              : 'pending'
            await sendIconThemePreferenceBindingResponse(session, {
              requestId,
              ok: true,
              value,
              synchronization,
            }, executionContextId)
          } catch (error) {
            const bridgeError = iconThemePreferenceBridgeError(error)
            let synchronization: 'complete' | 'pending' | undefined
            if (bridgeError.currentPreference !== undefined) {
              synchronization = iconThemePreferenceBroadcast === undefined
                ? 'pending'
                : (await iconThemePreferenceBroadcast.broadcast(bridgeError.currentPreference)).pending === 0
                ? 'complete'
                : 'pending'
            }
            if (documentEpoch !== undefined && executionContextId !== undefined) {
              await deliverIconThemePreferenceToDocument(
                session,
                {
                  kind: 'document-ready',
                  requestId,
                  ok: false,
                  documentEpoch,
                  currentRevision: 0,
                  ...bridgeError,
                },
                documentEpoch,
                0,
                executionContextId,
              ).catch(() => undefined)
            } else {
              await sendIconThemePreferenceBindingResponse(session, {
                requestId,
                ok: false,
                ...bridgeError,
                ...(synchronization === undefined ? {} : { synchronization }),
              }, executionContextId).catch(() => undefined)
            }
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
            if (Buffer.byteLength(payload) > MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES) {
              throw new Error('plugin lifecycle request exceeds maximum size')
            }
            const request = parsePluginLifecycleBindingRequest(JSON.parse(payload) as unknown, lifecycle.handler)
            requestId = request.requestId
            if (lifecycleController?.signal.aborted === true) throw new Error('plugin lifecycle bridge is closed')
            await lifecycleRequests.run(
              async () => await handlePluginLifecycleBindingRequest(lifecycle.handler, request),
              async value => await sendPluginLifecycleBindingResponse(session, { requestId, ok: true, value }),
            )
          } catch {
            await sendPluginLifecycleBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Plugin lifecycle request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    if (publisherGrant !== undefined) {
      removePublisherGrantBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== PUBLISHER_GRANT_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > MAX_PUBLISHER_GRANT_REQUEST_BYTES) {
              throw new Error('PublisherGrant request exceeds maximum size')
            }
            const request = parsePublisherGrantBindingRequest(JSON.parse(payload) as unknown)
            requestId = request.requestId
            if (publisherGrantController?.signal.aborted === true) throw new Error('PublisherGrant bridge is closed')
            const value = await publisherGrant.handle(request)
            await sendPublisherGrantBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await sendPublisherGrantBindingResponse(session, {
              requestId,
              ok: false,
              error: 'PublisherGrant request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    const generationRuntime = lifecycle?.runtime ?? developmentRuntime
    const reloadInstallId = viteDevelopment || loopbackModules ? randomUUID() : undefined
    const documentSource = newDocumentSource ?? source
    const productionDocumentSource = reloadInstallId === undefined || viteDevelopment
      ? undefined
      : `globalThis.__cordisxProductionInstallId = ${JSON.stringify(reloadInstallId)};
globalThis.__cordisxProductionBootstrapState = {
  installId: ${JSON.stringify(reloadInstallId)},
  status: 'evaluating',
};
try {
${documentSource}
  globalThis.__cordisxProductionBootstrapState = {
    installId: ${JSON.stringify(reloadInstallId)},
    status: 'evaluated',
  };
} catch (error) {
  globalThis.__cordisxProductionBootstrapState = {
    installId: ${JSON.stringify(reloadInstallId)},
    status: 'failed',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  throw error;
}`
    const added = await abortable(
      session.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: reloadInstallId === undefined
            ? documentSource
            : viteDevelopment
            ? `globalThis.__cordisxViteInstallId = ${JSON.stringify(reloadInstallId)};\n${documentSource}`
            : productionDocumentSource!,
        },
        CDP_INJECTION_TIMEOUT_MS,
      ),
      signal,
    )
    identifier = added.identifier as string | undefined
    if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
    if (viteDevelopment || loopbackModules) {
      const deadline = Date.now() + CDP_INJECTION_TIMEOUT_MS
      loopbackReloadStarted = true
      await abortable(
        session.send('Page.reload', viteDevelopment ? { ignoreCache: true } : {}, CDP_INJECTION_TIMEOUT_MS),
        signal,
      )
      if (viteDevelopment) await waitForViteBootstrap(session, reloadInstallId!, deadline, signal)
      else await waitForProductionBootstrap(session, reloadInstallId!, deadline, signal)
    } else {
      const evaluated = await session.send(
        'Runtime.evaluate',
        {
          expression: source,
          allowUnsafeEvalBlockedByCSP: true,
        },
        CDP_INJECTION_TIMEOUT_MS,
      )
      const exception = runtimeEvaluationException(evaluated)
      if (exception !== undefined) {
        throw new Error(`CordisX renderer injection evaluation failed: ${exception}`)
      }
    }
    if (generationRuntime !== undefined || iconThemePreferenceBroadcast !== undefined) {
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
        const boot = globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot
        if (boot === undefined) {
          throw new Error('CordisX renderer composition and runtime boot promises are undefined after injection')
        }
        await boot
        if (globalThis.__cordisxRuntime === undefined) {
          throw new Error('CordisX renderer runtime is undefined after boot')
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      } })()`,
        CDP_INJECTION_TIMEOUT_MS,
      )
    }
    if (generationRuntime !== undefined) {
      // Reserve this boot-ready renderer before durable recovery. The
      // reservation participates in recovery RPCs while prepare/register stay
      // fenced until all recovered/private projections are synchronized.
      generationJoin = generationRuntime.beginJoin(session)
      if (lifecycle !== undefined) {
        await lifecycle.handler.coordinator.recover()
        await generationRuntime.synchronizeRecoveredActivation(session)
      }
      // It becomes a normal generation participant only after its bootstrap
      // and recovered/private projections are ready. Committing the reserved
      // join is atomic with respect to prepare/register.
      while (true) {
        const developmentVersion = await generationRuntime.synchronizeDevelopmentStatus(session)
        const unregister = generationJoin.commit(developmentVersion)
        if (unregister === undefined) continue
        unregisterLifecycleSession = unregister
        break
      }
      generationJoin = undefined
    }
    return {
      target,
      ...(viteDevelopment ? { viteDevelopment: true } : {}),
      ...(loopbackModules ? { loopbackModules: true } : {}),
      ...(viteLoopbackPermission === undefined ? {} : { viteLoopbackPermission }),
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
      ...(ownerDocumentController === undefined ? {} : { ownerDocumentController, removeOwnerDocumentBindingListener }),
      ownerDocumentBindingInstalled: ownerDocuments !== undefined,
      ...(serviceConfigController === undefined ? {} : { serviceConfigController, removeServiceConfigBindingListener }),
      serviceConfigBindingInstalled: serviceConfig !== undefined,
      ...(credentialController === undefined ? {} : { credentialController, removeCredentialBindingListener }),
      credentialBindingInstalled: credential !== undefined,
      ...(actionsController === undefined ? {} : { actionsController, removeActionsBindingListener }),
      actionsBindingInstalled: actions !== undefined,
      ...(permissionController === undefined ? {} : { permissionController, removePermissionBindingListener }),
      permissionBindingInstalled: permission !== undefined,
      ...(iconThemePreferenceController === undefined
        ? {}
        : { iconThemePreferenceController, removeIconThemePreferenceBindingListener }),
      iconThemePreferenceBindingInstalled: iconThemePreference !== undefined,
      ...(unregisterIconThemePreferenceBroadcast === undefined ? {} : { unregisterIconThemePreferenceBroadcast }),
      ...(lifecycleController === undefined ? {} : { lifecycleController, removeLifecycleBindingListener }),
      lifecycleBindingInstalled: lifecycle !== undefined,
      unregisterLifecycleSession,
      ...(publisherGrantController === undefined
        ? {}
        : { publisherGrantController, removePublisherGrantBindingListener }),
      publisherGrantBindingInstalled: publisherGrant !== undefined,
      ...(certifiedPermissionChannel === undefined ? {} : { certifiedPermissionChannel }),
    }
  } catch (error) {
    const strictProductionCleanup = loopbackModules && !viteDevelopment
    const cleanupFailures: unknown[] = []
    const attemptCleanup = async (operation: Promise<unknown>): Promise<boolean> => {
      try {
        await operation
        return true
      } catch (cleanupError) {
        if (strictProductionCleanup) cleanupFailures.push(cleanupError)
        return false
      }
    }
    marketplaceController.abort()
    providerController?.abort()
    historyController?.abort()
    configController?.abort()
    ownerDocumentController?.abort()
    serviceConfigController?.abort()
    credentialController?.abort()
    actionsController?.abort()
    permissionController?.abort()
    iconThemePreferenceController?.abort()
    lifecycleController?.abort()
    publisherGrantController?.abort()
    removeBindingListener()
    removeProviderBindingListener()
    removeHistoryBindingListener()
    removeConfigBindingListener()
    removeOwnerDocumentBindingListener()
    removeServiceConfigBindingListener()
    removeCredentialBindingListener()
    removeActionsBindingListener()
    removePermissionBindingListener()
    removeIconThemePreferenceBindingListener()
    unregisterIconThemePreferenceBroadcast?.()
    removeLifecycleBindingListener()
    generationJoin?.abort()
    unregisterLifecycleSession()
    removePublisherGrantBindingListener()
    await certifiedPermissionChannel?.dispose()
    const scriptRemoved = identifier === undefined
      || await attemptCleanup(session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }))
    if (viteDevelopment) {
      await attemptCleanup(session.send('Runtime.evaluate', {
        expression: VITE_DISPOSE_EXPRESSION,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      }))
    } else if (loopbackModules) {
      await attemptCleanup(
        evaluateRuntimeOperation(session, RENDERER_DISPOSE_EXPRESSION, CDP_INJECTION_TIMEOUT_MS),
      )
    }
    const cspRestored = !loopbackModules
      || await attemptCleanup(session.send('Page.setBypassCSP', { enabled: false }))
    if (viteLoopbackPermissions === undefined) {
      await attemptCleanup(restoreViteLoopbackPermission(session, viteLoopbackPermission))
    } else await attemptCleanup(viteLoopbackPermissions.release(session, viteLoopbackPermission))
    if (loopbackModules && !viteDevelopment && loopbackReloadStarted && scriptRemoved && cspRestored) {
      await attemptCleanup(session.send('Page.reload', {}, CDP_INJECTION_TIMEOUT_MS))
    }
    session.close()
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `CordisX production renderer installation failed and cleanup was incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    throw error
  }
}

async function uninstall(
  installed: InstalledScript,
  viteLoopbackPermissions?: ViteLoopbackPermissionCoordinator,
): Promise<void> {
  installed.marketplaceController.abort()
  installed.providerController?.abort()
  installed.historyController?.abort()
  installed.configController?.abort()
  installed.ownerDocumentController?.abort()
  installed.serviceConfigController?.abort()
  installed.credentialController?.abort()
  installed.actionsController?.abort()
  installed.permissionController?.abort()
  installed.iconThemePreferenceController?.abort()
  installed.lifecycleController?.abort()
  installed.publisherGrantController?.abort()
  installed.removeBindingListener()
  installed.removeProviderBindingListener?.()
  installed.removeHistoryBindingListener?.()
  installed.removeConfigBindingListener?.()
  installed.removeOwnerDocumentBindingListener?.()
  installed.removeServiceConfigBindingListener?.()
  installed.removeCredentialBindingListener?.()
  installed.removeActionsBindingListener?.()
  installed.removePermissionBindingListener?.()
  installed.removeIconThemePreferenceBindingListener?.()
  installed.unregisterIconThemePreferenceBroadcast?.()
  installed.removeLifecycleBindingListener?.()
  installed.unregisterLifecycleSession()
  installed.removePublisherGrantBindingListener?.()
  await installed.certifiedPermissionChannel?.dispose()
  try {
    const strictProductionCleanup = installed.loopbackModules === true && installed.viteDevelopment !== true
    const cleanupFailures: unknown[] = []
    const attemptCleanup = async (operation: Promise<unknown>): Promise<boolean> => {
      try {
        await operation
        return true
      } catch (error) {
        if (strictProductionCleanup) cleanupFailures.push(error)
        return false
      }
    }
    if (installed.viteDevelopment) {
      await attemptCleanup(installed.session.send('Runtime.evaluate', {
        expression: VITE_DISPOSE_EXPRESSION,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      }))
    }
    const rendererCleanup = await Promise.allSettled([
      installed.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.identifier }),
      evaluateRuntimeOperation(installed.session, RENDERER_DISPOSE_EXPRESSION, CDP_INJECTION_TIMEOUT_MS),
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
      ...(installed.ownerDocumentBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: OWNER_DOCUMENT_BINDING })]
        : []),
      ...(installed.serviceConfigBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: SERVICE_CONFIG_BINDING })]
        : []),
      ...(installed.credentialBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CHANNEL_CREDENTIAL_BINDING })]
        : []),
      ...(installed.actionsBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CHANNEL_ACTIONS_BINDING })]
        : []),
      ...(installed.permissionBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PERMISSION_BINDING })]
        : []),
      ...(installed.iconThemePreferenceBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: ICON_THEME_PREFERENCE_BINDING })]
        : []),
      ...(installed.lifecycleBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PLUGIN_LIFECYCLE_BINDING })]
        : []),
      ...(installed.publisherGrantBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PUBLISHER_GRANT_BINDING })]
        : []),
    ])
    if (strictProductionCleanup) {
      cleanupFailures.push(
        ...rendererCleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []),
      )
    }
    const scriptRemoved = rendererCleanup[0]?.status === 'fulfilled'
    if (installed.loopbackModules) {
      const cspRestored = await attemptCleanup(installed.session.send('Page.setBypassCSP', { enabled: false }))
      if (viteLoopbackPermissions === undefined) {
        await attemptCleanup(restoreViteLoopbackPermission(installed.session, installed.viteLoopbackPermission))
      } else {
        await attemptCleanup(viteLoopbackPermissions.release(installed.session, installed.viteLoopbackPermission))
      }
      if (!installed.viteDevelopment && scriptRemoved && cspRestored) {
        await attemptCleanup(installed.session.send('Page.reload', {}, CDP_INJECTION_TIMEOUT_MS))
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'CordisX production renderer cleanup was incomplete')
    }
  } finally {
    installed.session.close()
  }
}

export interface WatchInjectionOptions {
  /** Opt-in Vite development only: allow loopback modules, await boot, restore on exit. */
  readonly viteDevelopment?: boolean
  /** Host-owned launch-scoped immutable plugin module origin. */
  readonly pluginArtifactOrigin?: string
  /** Production composition contains at least one immutable loopback module graph. */
  readonly hasLoopbackGraph?: boolean
  /** Production compatibility reload is restricted to a Host process launched by this watcher. */
  readonly launcherOwnedNativeTarget?: boolean
  readonly port: number
  /** Latest immutable bootstrap. Existing renderers are never reinjected when it changes. */
  readonly source: string | (() => string)
  /** Bootstrap for future fresh documents; current live documents use `source`. */
  readonly newDocumentSource?: string | (() => string)
  readonly signal: AbortSignal
  readonly onStatus?: (message: string) => void
  /** Called after the first renderer accepts the CordisX bootstrap. */
  readonly onReady?: () => void
  readonly providerFleet?: ProviderFleet
  readonly providerBridgeToken?: string
  readonly agentHistoryHost?: CodexAgentHistoryHost
  readonly agentHistoryBridgeToken?: string
  readonly configBridge?: ConfigBridgeHandler
  readonly ownerDocuments?: OwnerDocumentBridgeHandler
  readonly serviceConfigBridge?: ServiceConfigBridgeHandler
  readonly channelCredentialBridge?: ChannelCredentialBridgeHandler
  readonly channelActionsBridge?: ChannelActionsBridgeHandler
  readonly permissionPersistence?: PermissionPersistenceContext
  readonly iconThemePreferencePersistence?: IconThemePreferencePersistenceContext
  /** Host-private injection seam for profile-wide launcher integration tests. */
  readonly iconThemePreferenceBroadcastHub?: IconThemePreferenceBroadcastHub
  readonly pluginLifecycle?: {
    readonly handler: PluginLifecycleBridgeHandler
    readonly runtime: CdpPluginLifecycleRuntime
  }
  /** Host-private generation plane used by `cordisx dev`; it installs no public lifecycle binding. */
  readonly developmentRuntime?: CdpPluginLifecycleRuntime
  readonly publisherGrant?: PublisherGrantBridgeHandler
  readonly certifiedPermission?: Readonly<{
    authority: LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>
}

/** Track every current Codex page and keep one removable bootstrap installed per target. */
export async function watchAndInject(options: WatchInjectionOptions): Promise<void> {
  if (options.hasLoopbackGraph === true && options.pluginArtifactOrigin === undefined) {
    throw new Error('production loopback graph requires its exact artifact origin')
  }
  if (options.hasLoopbackGraph === true && options.launcherOwnedNativeTarget !== true) {
    throw new Error('production loopback graph compatibility requires a launcher-owned native target')
  }
  if (options.pluginArtifactOrigin !== undefined) {
    const artifactOrigin = new URL(options.pluginArtifactOrigin)
    if (
      artifactOrigin.protocol !== 'http:' || artifactOrigin.hostname !== '127.0.0.1'
      || artifactOrigin.pathname !== '/' || artifactOrigin.search !== '' || artifactOrigin.hash !== ''
    ) {
      throw new Error('plugin artifact origin must be an exact IPv4 loopback HTTP origin')
    }
  }
  const installed = new Map<string, InstalledScript>()
  const viteLoopbackPermissions = new ViteLoopbackPermissionCoordinator(options.port)
  const iconThemePreferenceBroadcast = options.iconThemePreferencePersistence === undefined
    ? undefined
    : options.iconThemePreferenceBroadcastHub ?? new IconThemePreferenceBroadcastHub(
      options.iconThemePreferencePersistence.appId,
      options.iconThemePreferencePersistence.profileId,
    )
  if (iconThemePreferenceBroadcast !== undefined && options.iconThemePreferencePersistence !== undefined) {
    iconThemePreferenceBroadcast.assertScope(options.iconThemePreferencePersistence)
  }
  try {
    while (!options.signal.aborted) {
      let attemptedReloadTarget: 'Vite' | 'production' | undefined
      try {
        const candidates = injectableTargets(await listTargets(options.port))
        const targets = options.viteDevelopment === true || options.hasLoopbackGraph === true
          ? candidates.filter(nativeAppTarget)
          : candidates
        if (options.hasLoopbackGraph === true && candidates.length > 0 && targets.length === 0) {
          attemptedReloadTarget = 'production'
          throw new Error('production loopback graph requires a native app:// renderer target')
        }
        const live = new Set(targets.map(target => target.id))
        for (const [id, record] of installed) {
          if (live.has(id)) continue
          await uninstall(record, viteLoopbackPermissions).catch(() => undefined)
          installed.delete(id)
        }
        for (const target of targets) {
          const current = installed.get(target.id)
          if (
            current !== undefined
            && current.target.webSocketDebuggerUrl === target.webSocketDebuggerUrl
            && !current.session.isClosed()
          ) continue
          let stale: InstalledScript | undefined
          if (current !== undefined) {
            await uninstall(current, viteLoopbackPermissions).catch(() => undefined)
            installed.delete(target.id)
            stale = current
          }
          const provider = options.providerFleet === undefined || options.providerBridgeToken === undefined
            ? undefined
            : { fleet: options.providerFleet, token: options.providerBridgeToken }
          const history = options.agentHistoryHost === undefined || options.agentHistoryBridgeToken === undefined
            ? undefined
            : { host: options.agentHistoryHost, token: options.agentHistoryBridgeToken }
          attemptedReloadTarget = options.viteDevelopment === true
            ? 'Vite'
            : options.hasLoopbackGraph === true
            ? 'production'
            : undefined
          const record = await install(
            target,
            typeof options.source === 'string' ? options.source : options.source(),
            provider,
            history,
            options.configBridge,
            options.ownerDocuments,
            options.serviceConfigBridge,
            options.channelCredentialBridge,
            options.channelActionsBridge,
            options.permissionPersistence,
            options.iconThemePreferencePersistence,
            iconThemePreferenceBroadcast,
            options.pluginLifecycle,
            options.developmentRuntime,
            options.publisherGrant,
            options.certifiedPermission,
            options.newDocumentSource === undefined
              ? undefined
              : typeof options.newDocumentSource === 'string'
              ? options.newDocumentSource
              : options.newDocumentSource(),
            stale,
            options.viteDevelopment,
            options.viteDevelopment === true || options.hasLoopbackGraph === true,
            viteLoopbackPermissions,
            options.signal,
          )
          installed.set(target.id, record)
          options.onReady?.()
          options.onStatus?.(`injected target ${target.id} (${target.title || target.url})`)
        }
      } catch (error) {
        if (options.signal.aborted) {
          if (error instanceof CdpInstallationAbortedError) break
          throw error
        }
        if (attemptedReloadTarget !== undefined) {
          throw new Error(
            `CordisX ${attemptedReloadTarget} renderer installation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        options.onStatus?.(`waiting for Codex CDP on 127.0.0.1:${options.port}: ${String(error)}`)
      }
      await delay(750, options.signal)
    }
  } finally {
    const cleanup = await Promise.allSettled(
      [...installed.values()].map(record => uninstall(record, viteLoopbackPermissions)),
    )
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'CordisX renderer cleanup failed')
  }
}
