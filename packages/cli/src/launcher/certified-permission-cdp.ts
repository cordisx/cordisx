import type {
  LauncherMarketplaceCertifiedAuthority,
  LauncherMarketplaceCertifiedSnapshot,
} from './marketplace-certified-authority.js'
import {
  CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
  certifiedPermissionEndpointTakeKey,
} from '../renderer/certified-permission-channel.js'

const TOKEN = /^[a-f0-9]{64}$/u
const EPOCH = /^[A-Za-z0-9_-]{16,128}$/u
const HEARTBEAT_MS = 5_000
const HANDSHAKE_TIMEOUT_MS = 5_000
const HANDSHAKE_POLL_MS = 25

export interface CertifiedPermissionCdpSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void
}

interface CertifiedPermissionDocumentEndpoint {
  readonly objectId: string
  readonly executionContextId: number
  readonly executionContextEpoch: ExecutionContextEpoch
  readonly documentEpoch: string
  readonly fence: number
  sequence: number
}

interface ExecutionContextEpoch {
  /** Host-local object identity; a recycled numeric CDP context id cannot recreate it. */
  readonly token: object
  readonly uniqueId?: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function remoteResult(response: Record<string, unknown>, operation: string): Record<string, unknown> {
  if (response.exceptionDetails !== undefined) throw new Error(`Certified permission CDP ${operation} threw`)
  const result = object(response.result)
  if (result === undefined) throw new Error(`Certified permission CDP ${operation} returned no result`)
  return result
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * One Launcher-owned, per-target document channel. The random take key is
 * installed only by the future-document bundle before plugin activation; a
 * live document containing pre-existing plugin JavaScript is never eligible.
 */
export class CdpCertifiedPermissionChannel {
  private readonly removers: (() => void)[] = []
  private readonly unsubscribeAuthority: () => void
  private readonly heartbeat: ReturnType<typeof setInterval>
  private operation = Promise.resolve()
  private current: CertifiedPermissionDocumentEndpoint | undefined
  private readonly liveContexts = new Map<number, ExecutionContextEpoch>()
  private fence = 0
  private disposed = false
  private readonly objectGroup: string

  constructor(
    private readonly session: CertifiedPermissionCdpSession,
    private readonly options: Readonly<{
      authority: LauncherMarketplaceCertifiedAuthority
      token: string
      profileId: string
      runtimeGeneration: string
      targetId: string
    }>,
  ) {
    if (!TOKEN.test(options.token) || options.profileId.length < 1 || options.profileId.length > 64
      || options.runtimeGeneration.length < 1 || options.runtimeGeneration.length > 200
      || options.targetId.length < 1 || options.targetId.length > 512) {
      throw new Error('Certified permission CDP channel scope is invalid')
    }
    this.objectGroup = `cordisx-certified-permission-${options.targetId}`
    this.removers.push(
      session.onEvent('Runtime.executionContextCreated', params => this.contextCreated(params)),
      session.onEvent('Runtime.executionContextDestroyed', params => this.contextDestroyed(params)),
      session.onEvent('Runtime.executionContextsCleared', () => this.contextsCleared()),
    )
    this.unsubscribeAuthority = options.authority.subscribe(() => {
      this.enqueue(async () => await this.deliverCurrent())
    })
    this.heartbeat = setInterval(() => {
      this.enqueue(async () => await this.deliverCurrent())
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.disposed) return
    this.operation = this.operation.catch(() => undefined).then(operation).catch(() => undefined)
  }

  private contextCreated(params: Record<string, unknown>): void {
    const context = object(params.context)
    const auxData = object(context?.auxData)
    if (context === undefined || !Number.isSafeInteger(context.id) || (context.id as number) < 1
      || auxData?.isDefault !== true) return
    const executionContextId = context.id as number
    const executionContextEpoch: ExecutionContextEpoch = Object.freeze({
      token: Object.freeze({}),
      ...(typeof context.uniqueId === 'string' && context.uniqueId.length >= 1 && context.uniqueId.length <= 512
        ? { uniqueId: context.uniqueId }
        : {}),
    })
    this.liveContexts.set(executionContextId, executionContextEpoch)
    this.enqueue(async () => await this.adoptDocument(executionContextId, executionContextEpoch))
  }

  private contextDestroyed(params: Record<string, unknown>): void {
    if (!Number.isSafeInteger(params.executionContextId)) return
    const executionContextId = params.executionContextId as number
    const executionContextEpoch = this.liveContexts.get(executionContextId)
    const destroyedUniqueId = params.executionContextUniqueId
    if (executionContextEpoch?.uniqueId !== undefined && typeof destroyedUniqueId === 'string'
      && destroyedUniqueId !== executionContextEpoch.uniqueId) return
    this.liveContexts.delete(executionContextId)
    if (this.current === undefined || executionContextId !== this.current.executionContextId
      || (executionContextEpoch !== undefined
        && this.current.executionContextEpoch.token !== executionContextEpoch.token)) return
    const stale = this.current
    this.current = undefined
    this.fence += 1
    this.enqueue(async () => { await this.release(stale) })
  }

  private contextsCleared(): void {
    this.liveContexts.clear()
    const stale = this.current
    this.current = undefined
    this.fence += 1
    if (stale !== undefined) this.enqueue(async () => { await this.release(stale) })
  }

  private liveContext(executionContextId: number, executionContextEpoch: ExecutionContextEpoch): boolean {
    return !this.disposed
      && this.liveContexts.get(executionContextId)?.token === executionContextEpoch.token
  }

  private async adoptDocument(
    executionContextId: number,
    executionContextEpoch: ExecutionContextEpoch,
  ): Promise<void> {
    if (!this.liveContext(executionContextId, executionContextEpoch)) return
    const top = await this.session.send('Runtime.evaluate', {
      expression: 'globalThis === globalThis.top',
      contextId: executionContextId,
      returnByValue: true,
    })
    if (!this.liveContext(executionContextId, executionContextEpoch)) return
    if (remoteResult(top, 'top-frame check').value !== true) return
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    let objectId: string | undefined
    while (this.liveContext(executionContextId, executionContextEpoch) && Date.now() < deadline) {
      const taken = await this.session.send('Runtime.evaluate', {
        expression: `globalThis[${JSON.stringify(certifiedPermissionEndpointTakeKey(this.options.token))}]?.()`,
        contextId: executionContextId,
        returnByValue: false,
        objectGroup: this.objectGroup,
      })
      let result: Record<string, unknown>
      try {
        result = remoteResult(taken, 'endpoint take')
      } catch (error) {
        const exceptional = object(taken.result)?.objectId
        if (typeof exceptional === 'string' && exceptional.length >= 1) await this.releaseObject(exceptional)
        throw error
      }
      if (!this.liveContext(executionContextId, executionContextEpoch)) {
        if (typeof result.objectId === 'string' && result.objectId.length >= 1) {
          await this.releaseObject(result.objectId)
        }
        return
      }
      if (typeof result.objectId === 'string' && result.objectId.length >= 1 && result.objectId.length <= 1024) {
        objectId = result.objectId
        break
      }
      if (typeof result.objectId === 'string' && result.objectId.length >= 1) await this.releaseObject(result.objectId)
      await delay(HANDSHAKE_POLL_MS)
    }
    if (objectId === undefined) return
    try {
      if (!this.liveContext(executionContextId, executionContextEpoch)) return
      const descriptionResponse = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.describe() }',
        returnByValue: true,
      })
      if (!this.liveContext(executionContextId, executionContextEpoch)) return
      const description = object(remoteResult(descriptionResponse, 'endpoint description').value)
      if (description === undefined || Object.keys(description).length !== 4
        || description.contract !== CERTIFIED_PERMISSION_CHANNEL_CONTRACT
        || description.profileId !== this.options.profileId
        || description.runtimeGeneration !== this.options.runtimeGeneration
        || typeof description.documentEpoch !== 'string' || !EPOCH.test(description.documentEpoch)) return
      const next: CertifiedPermissionDocumentEndpoint = {
        objectId,
        executionContextId,
        executionContextEpoch,
        documentEpoch: description.documentEpoch,
        fence: this.fence + 1,
        sequence: 0,
      }
      objectId = undefined
      let adopted = false
      try {
        await this.deliver(next, this.options.authority.snapshot(), false)
        if (!this.liveContext(executionContextId, executionContextEpoch)) return
        const previous = this.current
        this.fence = next.fence
        this.current = next
        adopted = true
        if (previous !== undefined) await this.closeAndRelease(previous)
      } finally {
        if (!adopted) await this.closeAndRelease(next)
      }
    } finally {
      if (objectId !== undefined) await this.releaseObject(objectId)
    }
  }

  private async deliverCurrent(): Promise<void> {
    const endpoint = this.current
    if (endpoint === undefined || this.disposed) return
    // Fresh read after every revision notification/heartbeat; no payload is
    // retained by this transport.
    await this.deliver(endpoint, this.options.authority.snapshot(), true)
  }

  private async deliver(
    endpoint: CertifiedPermissionDocumentEndpoint,
    snapshot: LauncherMarketplaceCertifiedSnapshot,
    requireCurrent: boolean,
  ): Promise<void> {
    if (this.disposed || (requireCurrent && (this.current !== endpoint || endpoint.fence !== this.fence))) return
    const sequence = endpoint.sequence + 1
    const payload = JSON.stringify({
      contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
      profileId: this.options.profileId,
      runtimeGeneration: this.options.runtimeGeneration,
      documentEpoch: endpoint.documentEpoch,
      deliverySequence: sequence,
      authorityRevision: snapshot.revision,
      snapshot,
    })
    const response = await this.session.send('Runtime.callFunctionOn', {
      objectId: endpoint.objectId,
      functionDeclaration: 'function(payload) { return this.deliver(payload) }',
      arguments: [{ value: payload }],
      awaitPromise: true,
      returnByValue: true,
    })
    const ack = object(remoteResult(response, 'snapshot delivery').value)
    if (this.disposed || (requireCurrent && (this.current !== endpoint || endpoint.fence !== this.fence))) return
    if (ack === undefined || ack.documentEpoch !== endpoint.documentEpoch
      || ack.deliverySequence !== sequence || ack.authorityRevision !== snapshot.revision) {
      throw new Error('Certified permission CDP delivery acknowledgement is invalid')
    }
    endpoint.sequence = sequence
  }

  private async closeAndRelease(endpoint: CertifiedPermissionDocumentEndpoint): Promise<void> {
    await this.session.send('Runtime.callFunctionOn', {
      objectId: endpoint.objectId,
      functionDeclaration: 'function() { return this.close() }',
      awaitPromise: true,
      returnByValue: true,
    }).then(response => { remoteResult(response, 'endpoint close') }).catch(() => undefined)
    await this.release(endpoint)
  }

  private async releaseObject(objectId: string): Promise<void> {
    await this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }

  private async release(endpoint: CertifiedPermissionDocumentEndpoint): Promise<void> {
    await this.releaseObject(endpoint.objectId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeAuthority()
    clearInterval(this.heartbeat)
    for (const remove of this.removers.splice(0)) remove()
    this.liveContexts.clear()
    const current = this.current
    this.current = undefined
    this.fence += 1
    await this.operation.catch(() => undefined)
    if (current !== undefined) await this.closeAndRelease(current)
    await this.session.send('Runtime.releaseObjectGroup', { objectGroup: this.objectGroup }).catch(() => undefined)
  }
}
