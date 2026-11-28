import { normalizePluginActivation } from '../launcher/plugin-activation.js'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import {
  type PluginManagementRpcEndpoint,
  type PluginManagementRpcOperation,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import {
  processIdentityStatus,
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
} from './supervisor-state.js'
import { requestSupervisorPing } from './supervisor-control.js'
import type { ManagerRendererCommand } from './manager-renderer-peer.js'
import type { OwnerAdapterRpcOperation } from './owner-adapter-rpc.js'
import { parseMarketplaceArtifactBindingRequest } from '../launcher/marketplace-artifact.js'
import { ownerDocumentBridgeError } from '../launcher/owner-document-rpc.js'
import { ownerDocumentWriteResultUnknown } from '../durable-document-contracts.js'
import type { ModelServicesReadResult } from '../model-service-contracts.js'

type Snapshot = Readonly<{
  active: ReturnType<typeof normalizePluginActivation>
  registryEpoch: number
}>
type OpenResult = Readonly<{
  sessionId: string
  grant: string
  documentSecret: string
  policyPublicKey: string
  rendererId: string
  snapshot: Snapshot
}>
type Receipt = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>
type Handler = (command: ManagerRendererCommand) => Promise<Receipt>
type ManagementOperation = Extract<PluginManagementRpcOperation, {
  readonly kind:
    | 'query'
    | 'refresh-catalog'
    | 'query-catalog'
    | 'plugin-info'
    | 'plan'
    | 'execute'
    | 'migrate-legacy-sources'
}>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adapter-owner-unavailable')
  return value as Record<string, unknown>
}

function valueOf(response: unknown): unknown {
  const item = record(response)
  if (item.status !== 'ok') throw new Error('adapter-owner-unavailable')
  return item.value
}

function opened(value: unknown, endpoint: PluginManagementRpcEndpoint): OpenResult {
  const item = record(value)
  const scope = record(item.snapshot)
  const active = normalizePluginActivation(scope.active)
  if (
    typeof item.sessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sessionId)
    || typeof item.grant !== 'string' || !/^[a-f0-9]{64}$/u.test(item.grant)
    || typeof item.documentSecret !== 'string' || !/^[a-f0-9]{64}$/u.test(item.documentSecret)
    || typeof item.policyPublicKey !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(item.policyPublicKey)
    || typeof item.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.rendererId)
    || active.recordKind !== 'active' || active.profileId !== endpoint.profileId
    || active.runtimeGeneration !== endpoint.generation
    || !Number.isSafeInteger(scope.registryEpoch) || (scope.registryEpoch as number) < 0
  ) throw new Error('adapter-owner-unavailable')
  return {
    sessionId: item.sessionId,
    grant: item.grant,
    documentSecret: item.documentSecret,
    policyPublicKey: item.policyPublicKey,
    rendererId: item.rendererId,
    snapshot: { active, registryEpoch: scope.registryEpoch as number },
  }
}

function commandOf(value: unknown): ManagerRendererCommand | undefined {
  const command = record(value).command
  if (command === null) return undefined
  const item = record(command)
  if (
    typeof item.id !== 'string' || !/^[a-f0-9]{64}$/u.test(item.id)
    || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1
    || typeof item.method !== 'string' || !Object.hasOwn(item, 'payload')
  ) throw new Error('adapter-owner-unavailable')
  return item as unknown as ManagerRendererCommand
}

/** One CordisX native adapter attached to an independently owned service. */
export class OwnerAdapterClient {
  readonly snapshot: Snapshot
  readonly rendererId: string
  readonly documentSecret: string
  readonly policyPublicKey: string
  readonly ownerIdentity: Readonly<{ pid: number; processStartedAt: string; generation: string }>
  private readonly controller = new AbortController()
  private readonly poller: Promise<void>
  private handler: Handler | undefined
  private attaching = false
  private admitted = false
  private closed = false
  private lost = false
  private closing: Promise<void> | undefined

  get current(): boolean {
    return !this.closed && this.handler !== undefined
  }

  private constructor(
    private readonly request: (operation: PluginManagementRpcOperation, signal?: AbortSignal) => Promise<unknown>,
    private readonly session: OpenResult,
    endpoint: PluginManagementRpcEndpoint,
    private readonly onLost: () => void | Promise<void>,
  ) {
    this.snapshot = structuredClone(session.snapshot)
    this.rendererId = session.rendererId
    this.documentSecret = session.documentSecret
    this.policyPublicKey = session.policyPublicKey
    this.ownerIdentity = {
      pid: endpoint.pid,
      processStartedAt: endpoint.processStartedAt,
      generation: endpoint.generation,
    }
    this.poller = this.poll()
  }

  static async connect(input: {
    readonly homeDir: string
    readonly appId: string
    readonly profileId: string
    readonly onLost: () => void | Promise<void>
  }): Promise<OwnerAdapterClient> {
    const supervisor = supervisorPaths(input.homeDir, input.appId, input.profileId)
    const paths = pluginManagementRpcPaths(input.homeDir, input.appId, input.profileId)
    const state = await readSupervisorState(supervisor)
    const metadata = await lstat(paths.state).catch(() => undefined)
    const endpoint = await readPluginManagementRpcEndpoint(paths)
    if (
      !state || state.mode !== 'service' || state.phase !== 'ready' || !endpoint
      || !metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && metadata.uid !== process.getuid()
      || state.appId !== input.appId || state.profileId !== input.profileId
      || endpoint.appId !== input.appId || endpoint.profileId !== input.profileId
      || path.resolve(endpoint.configPath) !== path.resolve(input.homeDir, 'config.json')
      || endpoint.pid !== state.pid || endpoint.processStartedAt !== state.processStartedAt
      || await processIdentityStatus(state.pid, state.processStartedAt) !== 'alive'
      || !await requestSupervisorPing(supervisor.socket, state.instanceToken)
    ) throw new Error('adapter-owner-unavailable')
    const current = await readSupervisorState(supervisor)
    if (
      !current || current.phase !== 'ready' || current.mode !== 'service' || current.pid !== state.pid
      || current.processStartedAt !== state.processStartedAt || current.instanceToken !== state.instanceToken
    ) throw new Error('adapter-owner-unavailable')
    const processStartedAt = await processStartIdentity(process.pid)
    if (!processStartedAt) throw new Error('adapter-client-identity-unavailable')
    const request = (operation: PluginManagementRpcOperation, signal?: AbortSignal) =>
      requestPluginManagementRpc(paths, endpoint, operation, signal ? { signal } : {})
    const response = valueOf(
      await request({ kind: 'owner-adapter', action: 'open', pid: process.pid, processStartedAt }),
    )
    const session = opened(response, endpoint)
    const final = await readSupervisorState(supervisor)
    if (
      !final || final.phase !== 'ready' || final.mode !== 'service' || final.pid !== state.pid
      || final.processStartedAt !== state.processStartedAt || final.instanceToken !== state.instanceToken
    ) {
      await request({ kind: 'owner-adapter', action: 'close', sessionId: session.sessionId, grant: session.grant })
        .catch(() => undefined)
      throw new Error('adapter-owner-unavailable')
    }
    return new OwnerAdapterClient(request, session, endpoint, input.onLost)
  }

  private operation<T extends OwnerAdapterRpcOperation['action']>(action: T) {
    return { kind: 'owner-adapter' as const, action, sessionId: this.session.sessionId, grant: this.session.grant }
  }

  private async poll(): Promise<void> {
    try {
      while (!this.closed) {
        const response = valueOf(
          await this.request({ ...this.operation('poll'), timeoutMs: 20_000 }, this.controller.signal),
        )
        const command = commandOf(response)
        if (!command) continue
        if (!this.handler) throw new Error('adapter-command-before-admission')
        const receipt = await this.handler(command).catch(() => ({ ok: false as const }))
        valueOf(
          await this.request({
            ...this.operation('acknowledge'),
            receipt: { id: command.id, sequence: command.sequence, ...receipt },
          }, this.controller.signal),
        )
        if (!receipt.ok) throw new Error('adapter-command-failed')
      }
    } catch {
      if (!this.closed) {
        this.lost = true
        this.closed = true
        this.controller.abort()
        void Promise.resolve().then(this.onLost).catch(() => undefined)
      }
    }
  }

  async admit(handler: Handler): Promise<boolean> {
    if (this.closed || this.attaching || this.handler) return false
    this.attaching = true
    this.handler = handler
    try {
      valueOf(await this.request(this.operation('admit'), this.controller.signal))
      this.admitted = !this.closed
      return this.admitted
    } catch {
      await this.close()
      return false
    } finally {
      this.attaching = false
    }
  }

  /** Normal management requests stay with the same service endpoint and session lifetime. */
  async management(operation: ManagementOperation): Promise<unknown> {
    if (this.closed || !this.admitted) throw new Error('adapter-owner-unavailable')
    const result = valueOf(
      await this.request({ ...this.operation('management'), payload: operation }, this.controller.signal),
    )
    if (this.closed || !this.admitted) throw new Error('adapter-owner-result-unknown')
    return result
  }

  async lifecycle(payload: unknown): Promise<unknown> {
    if (this.closed || !this.admitted) throw new Error('adapter-owner-unavailable')
    const result = valueOf(await this.request({ ...this.operation('lifecycle'), payload }, this.controller.signal))
    if (this.closed || !this.admitted) throw new Error('adapter-owner-result-unknown')
    return result
  }

  async document(payload: unknown): Promise<unknown> {
    const read = payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).operation === 'load'
    if (this.closed || !this.admitted && !read) throw new Error('adapter-owner-unavailable')
    const result = valueOf(await this.request({ ...this.operation('document'), payload }, this.controller.signal))
    if (this.closed || !this.admitted && !read) throw new Error('adapter-owner-result-unknown')
    return result
  }

  /** Preserve the possibility of a commit when the renderer loses the owner's receipt. */
  async documentBinding(payload: unknown): Promise<unknown> {
    try {
      return await this.document(payload)
    } catch {
      return payload && typeof payload === 'object' && !Array.isArray(payload)
          && (payload as Record<string, unknown>).operation === 'replace'
        ? ownerDocumentWriteResultUnknown()
        : ownerDocumentBridgeError()
    }
  }

  async modelServicesRead(): Promise<ModelServicesReadResult> {
    const unavailable = { status: 'rejected' as const, code: 'unavailable' as const }
    if (this.closed || !this.admitted) return unavailable
    try {
      const value = valueOf(await this.request(this.operation('model-services-read'), this.controller.signal))
      const item = record(value)
      if (this.closed || !this.admitted) return unavailable
      return item.status === 'ok' && typeof item.revision === 'string' && Array.isArray(item.services)
        ? value as ModelServicesReadResult
        : unavailable
    } catch {
      return unavailable
    }
  }

  async artifact(payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed || !this.admitted || signal.aborted) throw new Error('adapter-owner-unavailable')
    const request = parseMarketplaceArtifactBindingRequest(payload)
    if (request.kind === 'cancel') throw new Error('adapter-artifact-request-invalid')
    const cancel = () => {
      void this.request({
        ...this.operation('artifact'),
        payload: { kind: 'cancel', requestId: `cancel-${randomUUID()}`, targetRequestId: request.requestId },
      }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) {
        cancel()
        throw new Error('adapter-artifact-cancelled')
      }
      const result = valueOf(
        await this.request(
          { ...this.operation('artifact'), payload: request },
          AbortSignal.any([this.controller.signal, signal]),
        ),
      )
      if (this.closed || !this.admitted || signal.aborted) throw new Error('adapter-owner-result-unknown')
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.admitted = false
    this.controller.abort()
    this.closing = (async () => {
      if (!this.lost) {
        await this.request(this.operation('close')).catch(() => undefined)
      }
      await this.poller.catch(() => undefined)
    })()
    return this.closing
  }
}
