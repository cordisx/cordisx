import type {
  ChannelManagerLogExportResultV2,
  ChannelManagerLogPageV2,
  ChannelManagerRequestV2,
  ChannelManagerResultV2,
  ChannelManagerSnapshotV3,
  ChannelManagerTargetRequestV1,
  ChannelManagerTargetResultV1,
} from '@cordisx/protocol/channel-manager/v2'
import type { ChannelAdapterKind } from '@cordisx/protocol/channel-runtime/v1'
import type { ChannelManagerSnapshotV4 } from '@cordisx/protocol/channel-manager/v3'
import type { ChannelManagerBindingPageV1 } from '@cordisx/protocol/channel-manager/v4'
import type {
  ChannelCredentialAuthorizer,
  ChannelCredentialConfigurationWrite,
  ChannelCredentialWorkflow,
} from './channel-credential-workflow.js'
import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'
import type {
  ChannelManagerBindingProjection,
  ChannelManagerConnectionProjection,
  ChannelManagerLogProjection,
  ChannelManagerProjectionV1,
} from './channel-manager.js'

const ADAPTER_KINDS = new Set<ChannelAdapterKind>([
  'simulator',
  'feishu',
  'lark',
  'wecom-intelligent-bot',
  'wecom-enterprise-app',
  'wecom-message-push',
  'wechat-service',
])

interface PublicChannelManagerInput {
  readonly profileId: string
  readonly hostGeneration: string
  readonly projection: () => ChannelManagerProjectionV1
  readonly credentials?: ChannelCredentialWorkflow
  readonly configurationAvailable?: (connection: ChannelManagerConnectionProjection) => boolean
  readonly update?: (
    ref: ChannelManagerConnectionProjection['ref'],
    patch: { displayName?: string; selectors?: readonly string[] },
  ) => Promise<{ status: 'applied' | 'conflict' | 'rejected' | 'unavailable'; code: string }>
  readonly actionsAvailable: () => boolean
  readonly connectionControlAvailable?: () => boolean
  readonly connectionReconnectAvailable?: () => boolean
  readonly logsAvailable?: () => boolean
  readonly runAction: (
    action: 'enable' | 'disable' | 'reconnect' | 'archive' | 'restore' | 'unbind',
    input: Record<string, unknown>,
  ) => Promise<ChannelManagerActionResult>
}

type ConnectionTarget = { readonly ref: ChannelManagerConnectionProjection['ref'] }
type BindingTarget = { readonly binding: ChannelManagerBindingProjection; readonly bindingRevision: number }
type BindingIncarnation = { readonly token: string; readonly bindingRevision: number; readonly fingerprint: string }
interface LogCursor {
  readonly connectionToken: string
  readonly snapshotRevision: number
  readonly filterDigest: string
  readonly offset: number
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'] as const)
const LOG_EVENTS = new Set(
  [
    'connection.started',
    'connection.ready',
    'connection.retrying',
    'connection.stopped',
    'connection.rejected',
    'binding.created',
    'binding.archived',
    'binding.restored',
    'binding.unbound',
    'export.created',
  ] as const,
)

function opaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `chm1_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function connectionKey(ref: ChannelManagerConnectionProjection['ref']): string {
  return JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
}

function immutable<Value>(value: Value): Value {
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child)
    Object.freeze(item)
  }
  const cloned = structuredClone(value)
  freeze(cloned)
  return cloned
}

function adapterKind(value: string): ChannelAdapterKind | undefined {
  return ADAPTER_KINDS.has(value as ChannelAdapterKind) ? value as ChannelAdapterKind : undefined
}

function safeCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 128)
  return normalized || 'UNKNOWN'
}

function safeEntryId(value: string, index: number): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 110)
  return normalized === '' ? `log-${index}` : normalized
}

function logEvent(value: string): ChannelManagerLogPageV2['entries'][number]['event'] {
  if (/retry/iu.test(value)) return 'connection.retrying'
  if (/stop|disable/iu.test(value)) return 'connection.stopped'
  if (/reject|fail|error/iu.test(value)) return 'connection.rejected'
  if (/archive/iu.test(value)) return 'binding.archived'
  if (/restore/iu.test(value)) return 'binding.restored'
  if (/unbind/iu.test(value)) return 'binding.unbound'
  if (/bind/iu.test(value)) return 'binding.created'
  if (/start|enable|connect/iu.test(value)) return 'connection.started'
  return 'connection.ready'
}

function logLevel(value: string): ChannelManagerLogPageV2['entries'][number]['level'] {
  if (/reject|fail|error|dead|unavailable/iu.test(value)) return 'error'
  if (/retry|warn/iu.test(value)) return 'warn'
  return 'info'
}

export class PublicChannelManagerController {
  private readonly connectionTokens = new Map<string, string>()
  private readonly connectionTargets = new Map<string, ConnectionTarget>()
  private readonly bindingIncarnations = new Map<string, BindingIncarnation>()
  private readonly bindingTargets = new Map<string, BindingTarget>()
  private readonly sessionTokens = new Map<string, string>()
  private readonly routeTokens = new Map<string, string>()
  private readonly logCursors = new Map<string, LogCursor>()
  private readonly bindingCursors = new Map<string, { connectionToken: string; revision: number; offset: number }>()
  private revision = 0
  private projectionFingerprint: string | undefined

  constructor(private readonly input: PublicChannelManagerInput) {}

  snapshotWithIdentity(): ChannelManagerSnapshotV4 {
    const snapshot = this.snapshot()
    const connections = this.input.projection()
    const accounts = snapshot.accounts.map(account => {
      const target = this.connectionTargets.get(account.connectionToken)
      const identity = target === undefined
        ? undefined
        : connections.accounts.find(candidate => connectionKey(candidate.ref) === connectionKey(target.ref))
      return {
        ...account,
        ...(identity?.accountName === undefined ? {} : { accountName: identity.accountName }),
        ...(identity?.accountAvatar === undefined ? {} : { accountAvatar: identity.accountAvatar }),
      }
    })
    return immutable({ ...snapshot, contract: 'cordisx.channel-runtime-snapshot/v4', schemaVersion: 4, accounts })
  }

  snapshot(): ChannelManagerSnapshotV3 {
    const full = this.fullSnapshot()
    return immutable({ ...full, bindings: full.bindings.slice(0, 10_000) })
  }

  bindingPage(request: { connectionToken: string; afterCursor?: string; limit?: number }): ChannelManagerBindingPageV1 {
    const full = this.fullSnapshot()
    if (Object.keys(request).some(key => !['connectionToken', 'afterCursor', 'limit'].includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    const target = this.connectionTargets.get(request.connectionToken)
    if (!target || !target.ref.tenantId || !this.connectionExists(target.ref)) throw new Error('TARGET_UNAVAILABLE')
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_REQUEST')
    const cursor = request.afterCursor === undefined ? undefined : this.bindingCursors.get(request.afterCursor)
    if (
      request.afterCursor !== undefined && (!cursor || cursor.connectionToken !== request.connectionToken
        || cursor.revision !== full.revision)
    ) throw new Error('STALE_CURSOR')
    const all = full.bindings.filter(binding => binding.connectionToken === request.connectionToken)
    const offset = cursor?.offset ?? 0
    const bindings = all.slice(offset, offset + limit)
    let nextCursor: string | undefined
    if (offset + bindings.length < all.length) {
      nextCursor = opaqueToken()
      this.bindingCursors.set(nextCursor, {
        connectionToken: request.connectionToken,
        revision: full.revision,
        offset: offset + bindings.length,
      })
      if (this.bindingCursors.size > 256) this.bindingCursors.delete(this.bindingCursors.keys().next().value!)
    }
    return immutable({
      contract: 'cordisx.channel-manager-binding-page/v1',
      schemaVersion: 1,
      profileId: this.input.profileId,
      hostGeneration: this.input.hostGeneration,
      snapshotRevision: full.revision,
      connectionToken: request.connectionToken,
      total: all.length,
      bindings,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    })
  }

  private fullSnapshot(): ChannelManagerSnapshotV3 {
    const projection = this.input.projection()
    this.revision = Math.max(this.revision, projection.service.revision)
    const connections = new Map<string, ChannelManagerConnectionProjection>()
    for (const connection of [...projection.connections, ...projection.accounts]) {
      connections.set(connectionKey(connection.ref), connection)
    }
    const accounts = [...connections].flatMap(([key, connection]) => {
      const kind = adapterKind(connection.adapterKind)
      if (kind === undefined) return []
      const runtime = projection.accounts.find(candidate => connectionKey(candidate.ref) === key)
      const token = this.connectionTokens.get(key) ?? opaqueToken()
      this.connectionTokens.set(key, token)
      this.connectionTargets.set(token, { ref: connection.ref })
      const actionOperations = connection.pendingTenant ? [] : this.input.actionsAvailable()
        ? (runtime?.connectionState === 'disabled'
          ? ['connection.enable'] as const
          : ['connection.disable', 'connection.reconnect'] as const)
        : this.input.connectionControlAvailable?.()
        ? (connection.enabled
          ? [
            'connection.disable' as const,
            ...(this.input.connectionReconnectAvailable?.() ? ['connection.reconnect' as const] : []),
          ]
          : ['connection.enable'] as const)
        : []
      const credentialOperations = this.input.credentials !== undefined && !connection.pendingTenant
          && ['feishu', 'lark'].includes(kind)
        ? ['target.credential.capture.rotate', 'connection.rotate-credential'] as const
        : []
      const availableOperations = [
        ...actionOperations,
        ...credentialOperations,
        ...(this.input.configurationAvailable?.(connection) ? ['connection.update'] as const : []),
        ...(projection.logs === undefined || connection.pendingTenant || this.input.logsAvailable?.() === false
          ? []
          : ['logs.query'] as const),
      ]
      return [{
        connectionToken: token,
        adapterKind: kind,
        ...(connection.displayName === undefined ? {} : { displayName: connection.displayName }),
        implementationStatus: runtime?.implementationStatus ?? 'planned',
        connectionState: runtime?.connectionState ?? (connection.enabled ? 'unavailable' : 'disabled'),
        configurationState: connection.pendingTenant || connection.secretState === 'missing'
          ? 'incomplete' as const
          : 'ready' as const,
        ...(connection.pendingTenant ? { lastErrorCode: 'TENANT_IDENTIFICATION_PENDING' } : {}),
        generation: Math.max(1, runtime?.generation ?? 1),
        lastGoodRevision: projection.service.lastGoodRevision,
        inbound: runtime?.inbound ?? { pending: 0, retrying: 0, deadLetter: 0 },
        outbound: runtime?.outbound ?? { pending: 0, retrying: 0, deadLetter: 0 },
        availableOperations,
      }]
    })
    const bindings = projection.bindings.map(binding => {
      const fingerprint = JSON.stringify(binding)
      const previous = this.bindingIncarnations.get(binding.bindingId)
      const incarnation = previous?.fingerprint === fingerprint
        ? previous
        : {
          token: opaqueToken(),
          bindingRevision: (previous?.bindingRevision ?? 0) + 1,
          fingerprint,
        }
      if (previous !== undefined && previous.token !== incarnation.token) this.bindingTargets.delete(previous.token)
      this.bindingIncarnations.set(binding.bindingId, incarnation)
      this.bindingTargets.set(incarnation.token, { binding, bindingRevision: incarnation.bindingRevision })
      const sessionToken = this.sessionTokens.get(binding.bindingId) ?? opaqueToken()
      this.sessionTokens.set(binding.bindingId, sessionToken)
      const routeToken = this.routeTokens.get(binding.bindingId) ?? opaqueToken()
      this.routeTokens.set(binding.bindingId, routeToken)
      const connectionToken = this.connectionTokens.get(connectionKey(binding.channel)) ?? opaqueToken()
      this.connectionTokens.set(connectionKey(binding.channel), connectionToken)
      if (!this.connectionTargets.has(connectionToken)) {
        this.connectionTargets.set(connectionToken, {
          ref: {
            adapterId: binding.channel.adapterId,
            accountId: binding.channel.accountId,
            tenantId: binding.channel.tenantId,
          },
        })
      }
      return {
        bindingToken: incarnation.token,
        connectionToken,
        sessionToken,
        routeToken,
        bindingRevision: incarnation.bindingRevision,
        state: binding.state,
        availableOperations: this.input.actionsAvailable()
          ? (binding.state === 'archived'
            ? ['binding.restore', 'binding.unbind'] as const
            : ['binding.archive', 'binding.unbind'] as const)
          : [],
      }
    })
    const fingerprint = JSON.stringify({ accounts, bindings })
    if (this.projectionFingerprint !== undefined && this.projectionFingerprint !== fingerprint) this.revision += 1
    this.projectionFingerprint = fingerprint
    const currentConnectionTokens = new Set(accounts.map(account => account.connectionToken))
    for (const binding of bindings) currentConnectionTokens.add(binding.connectionToken)
    for (const token of this.connectionTargets.keys()) {
      if (!currentConnectionTokens.has(token)) this.connectionTargets.delete(token)
    }
    const currentBindingTokens = new Set(bindings.map(binding => binding.bindingToken))
    for (const token of this.bindingTargets.keys()) {
      if (!currentBindingTokens.has(token)) this.bindingTargets.delete(token)
    }
    return immutable({
      contract: 'cordisx.channel-runtime-snapshot/v3',
      schemaVersion: 3,
      profileId: this.input.profileId,
      hostGeneration: this.input.hostGeneration,
      revision: this.revision,
      observedAt: projection.observedAt ?? new Date().toISOString(),
      availableOperations: this.input.credentials === undefined
        ? []
        : ['target.credential.capture.create', 'credential.capture', 'target.connection.create', 'connection.create'],
      accounts,
      bindings,
      pendingAuthorizations: [],
    })
  }

  async issue(request: ChannelManagerTargetRequestV1, owner = 'host'): Promise<ChannelManagerTargetResultV1> {
    const fence = this.fence(request)
    const result = fence.status === 'applied'
      ? await this.input.credentials?.issue(request, owner)
        ?? { status: 'unavailable' as const, code: 'OPERATION_UNAVAILABLE' }
      : fence
    return immutable(
      {
        ...this.resultFence(request),
        contract: 'cordisx.channel-manager-target-result/v1',
        schemaVersion: 1,
        operation: request.operation,
        ...result,
      } as ChannelManagerTargetResultV1,
    )
  }

  async execute(
    request: ChannelManagerRequestV2,
    owner = 'host',
    active = () => true,
    signal?: AbortSignal,
    authorizeCredential: ChannelCredentialAuthorizer = async () => false,
    callerOperations?: Partial<Pick<PublicChannelManagerInput, 'update' | 'runAction'>>,
    credentialConfiguration?: ChannelCredentialConfigurationWrite,
  ): Promise<ChannelManagerResultV2> {
    const fence = this.fence(request)
    if (fence.status !== 'applied') return this.operationResult(request, fence.status, fence.code)
    if (!active()) return this.operationResult(request, 'unavailable', 'STALE_GENERATION')
    if (
      request.operation === 'credential.capture' || request.operation === 'connection.create'
      || request.operation === 'connection.rotate-credential'
    ) {
      const result = await this.input.credentials?.execute(
        request,
        owner,
        active,
        authorizeCredential,
        signal,
        undefined,
        credentialConfiguration,
      )
        ?? { status: 'unavailable' as const, code: 'OPERATION_UNAVAILABLE' }
      return immutable(
        {
          ...this.resultFence(request),
          contract: 'cordisx.channel-manager-result/v2',
          schemaVersion: 2,
          operation: request.operation,
          target: request.target,
          ...result,
        } as ChannelManagerResultV2,
      )
    }
    if (request.operation === 'connection.update') {
      const target = this.connectionTargets.get(request.target.connectionToken)
      if (!target || !this.connectionExists(target.ref)) {
        return this.operationResult(request, 'rejected', 'TARGET_UNAVAILABLE')
      }
      const result = await (callerOperations?.update ?? this.input.update)?.(target.ref, request.patch)
        ?? { status: 'unavailable' as const, code: 'OPERATION_UNAVAILABLE' }
      return this.operationResult(request, result.status, result.code)
    }
    if (request.operation === 'logs.query') {
      try {
        this.validateLogRequest(request)
        return this.operationResult(request, 'applied', 'APPLIED')
      } catch (error) {
        return this.operationResult(request, 'rejected', error instanceof Error ? error.message : 'INVALID_REQUEST')
      }
    }
    if (
      request.operation === 'connection.enable' || request.operation === 'connection.disable'
      || request.operation === 'connection.reconnect'
    ) {
      const target = this.connectionTargets.get(request.target.connectionToken)
      if (target === undefined || !target.ref.tenantId || !this.connectionExists(target.ref)) {
        return this.operationResult(request, 'rejected', 'TARGET_UNAVAILABLE')
      }
      const result = await (callerOperations?.runAction ?? this.input.runAction)(
        request.operation.slice('connection.'.length) as 'enable' | 'disable' | 'reconnect',
        {
          ref: target.ref,
        },
      )
      return this.actionResult(request, result)
    }
    if (
      request.operation === 'binding.archive' || request.operation === 'binding.restore'
      || request.operation === 'binding.unbind'
    ) {
      const target = this.bindingTargets.get(request.target.bindingToken)
      if (
        target === undefined || request.target.bindingRevision !== target.bindingRevision
        || !this.input.projection().bindings.some(binding => binding.bindingId === target.binding.bindingId)
      ) {
        return this.operationResult(request, 'rejected', 'TARGET_UNAVAILABLE')
      }
      const result = await (callerOperations?.runAction ?? this.input.runAction)(
        request.operation.slice('binding.'.length) as 'archive' | 'restore' | 'unbind',
        {
          bindingId: target.binding.bindingId,
        },
      )
      return this.actionResult(request, result)
    }
    return this.operationResult(request, 'unavailable', 'OPERATION_UNAVAILABLE')
  }

  queryLogs(request: Extract<ChannelManagerRequestV2, { operation: 'logs.query' }>): Promise<ChannelManagerLogPageV2> {
    try {
      const { logs, offset, filterDigest } = this.validateLogRequest(request)
      const entries = logs.slice(offset, offset + request.query.limit).map((log, index) => ({
        entryId: safeEntryId(log.id, offset + index),
        occurredAt: log.recordedAt,
        level: logLevel(log.outcome),
        event: logEvent(log.action),
        code: safeCode(log.outcome),
        connectionToken: request.target.connectionToken,
      }))
      const nextOffset = offset + entries.length
      let nextCursor: string | undefined
      if (nextOffset < logs.length) {
        nextCursor = opaqueToken().replace('chm1_', 'chmc1_')
        this.logCursors.set(nextCursor, {
          connectionToken: request.target.connectionToken,
          snapshotRevision: this.revision,
          filterDigest,
          offset: nextOffset,
        })
        if (this.logCursors.size > 1_024) this.logCursors.delete(this.logCursors.keys().next().value!)
      }
      return Promise.resolve(immutable({
        ...this.resultFence(request),
        contract: 'cordisx.channel-manager-log-page/v2',
        schemaVersion: 2,
        snapshotRevision: this.revision,
        target: request.target,
        generatedAt: new Date().toISOString(),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        entries,
      }))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  exportLogs(
    request: Extract<ChannelManagerRequestV2, { operation: 'logs.export' }>,
  ): Promise<ChannelManagerLogExportResultV2> {
    return Promise.resolve(immutable({
      ...this.resultFence(request),
      contract: 'cordisx.channel-manager-log-export-result/v2',
      schemaVersion: 2,
      target: request.target,
      observedAt: new Date().toISOString(),
      status: 'unavailable',
      code: 'HOST_EXPORT_UNAVAILABLE',
      retryable: false,
    }))
  }

  private fence(
    request: { readonly expectedRevision: number; readonly profileId: string; readonly hostGeneration: string },
  ) {
    const snapshot = this.snapshot()
    if (request.profileId !== snapshot.profileId || request.hostGeneration !== snapshot.hostGeneration) {
      return { status: 'unavailable' as const, code: 'STALE_GENERATION' }
    }
    if (request.expectedRevision !== snapshot.revision) {
      return { status: 'conflict' as const, code: 'REVISION_CONFLICT' }
    }
    return { status: 'applied' as const, code: 'APPLIED' }
  }

  private resultFence(
    request: {
      readonly requestId: string
      readonly expectedRevision: number
      readonly profileId: string
      readonly hostGeneration: string
    },
  ) {
    return {
      requestId: request.requestId,
      expectedRevision: request.expectedRevision,
      profileId: request.profileId,
      hostGeneration: request.hostGeneration,
      revision: this.revision,
    }
  }

  private operationResult(
    request: ChannelManagerRequestV2,
    status: 'applied' | 'conflict' | 'rejected' | 'unavailable',
    code: string,
  ): ChannelManagerResultV2 {
    return immutable({
      ...this.resultFence(request),
      contract: 'cordisx.channel-manager-result/v2',
      schemaVersion: 2,
      operation: request.operation,
      target: request.target,
      status,
      code,
    } as ChannelManagerResultV2)
  }

  private actionResult(request: ChannelManagerRequestV2, result: ChannelManagerActionResult): ChannelManagerResultV2 {
    if (result.status !== 'applied') return this.operationResult(request, 'unavailable', 'OPERATION_UNAVAILABLE')
    return this.operationResult(request, 'applied', 'APPLIED')
  }

  target(token: string): ChannelManagerConnectionProjection['ref'] | undefined {
    const ref = this.connectionTargets.get(token)?.ref
    return ref && this.connectionExists(ref) ? ref : undefined
  }

  /** Bound internally to the current opaque token incarnation, never supplied by the plugin. */
  bindingTargetsForConnection(connectionToken: string, conversationId: string) {
    const snapshot = this.fullSnapshot()
    return {
      snapshotRevision: snapshot.revision,
      bindings: snapshot.bindings.flatMap(binding => {
        const target = this.bindingTargets.get(binding.bindingToken)
        return binding.connectionToken === connectionToken && target?.binding.channel.conversationId === conversationId
          ? [{ bindingId: target.binding.bindingId, binding }]
          : []
      }),
    }
  }

  bindingTarget(token: string) {
    this.fullSnapshot()
    const target = this.bindingTargets.get(token)
    return target && this.input.projection().bindings.some(binding => binding.bindingId === target.binding.bindingId)
      ? target.binding
      : undefined
  }

  tokenFor(ref: ChannelManagerConnectionProjection['ref']): string {
    const key = connectionKey(ref)
    const token = this.connectionTokens.get(key) ?? opaqueToken()
    this.connectionTokens.set(key, token)
    this.connectionTargets.set(token, { ref })
    return token
  }

  /** Keep the page target stable when an unscoped pending account gains its real tenant identity. */
  resolvePendingToken(
    pending: ChannelManagerConnectionProjection['ref'],
    resolved: ChannelManagerConnectionProjection['ref'],
  ): void {
    if (
      pending.tenantId !== '' || !resolved.tenantId || pending.adapterId !== resolved.adapterId
      || pending.accountId !== resolved.accountId
    ) return
    const oldKey = connectionKey(pending), newKey = connectionKey(resolved)
    const token = this.connectionTokens.get(oldKey)
    if (!token || this.connectionTokens.has(newKey)) return
    this.connectionTokens.delete(oldKey)
    this.connectionTokens.set(newKey, token)
    this.connectionTargets.set(token, { ref: resolved })
  }

  currentRevision(): number {
    return this.revision
  }

  /** Resolve an existing opaque target internally; callers never provide a second permission scope. */
  permissionTarget(request: ChannelManagerRequestV2): ChannelManagerConnectionProjection['ref'] | undefined {
    if (this.fence(request).status !== 'applied') return undefined
    if ('bindingToken' in request.target) {
      const value = this.bindingTargets.get(request.target.bindingToken)
      return value && request.target.bindingRevision === value.bindingRevision
          && this.input.projection().bindings.some(binding => binding.bindingId === value.binding.bindingId)
        ? value.binding.channel
        : undefined
    }
    if ('connectionToken' in request.target) return this.target(request.target.connectionToken)
    return undefined
  }

  invalidate(): void {
    this.revision += 1
    this.projectionFingerprint = undefined
  }

  private validateLogRequest(request: Extract<ChannelManagerRequestV2, { operation: 'logs.query' }>): {
    readonly logs: readonly ChannelManagerLogProjection[]
    readonly offset: number
    readonly filterDigest: string
  } {
    const fence = this.fence(request)
    if (fence.status !== 'applied') throw new Error(fence.code)
    if (!Number.isInteger(request.query.limit) || request.query.limit < 1 || request.query.limit > 1_000) {
      throw new Error('INVALID_LIMIT')
    }
    const levels = request.query.filter?.levels ?? []
    const events = request.query.filter?.events ?? []
    if (levels.some(level => !LOG_LEVELS.has(level)) || new Set(levels).size !== levels.length) {
      throw new Error('INVALID_FILTER')
    }
    if (events.some(event => !LOG_EVENTS.has(event)) || new Set(events).size !== events.length) {
      throw new Error('INVALID_FILTER')
    }
    const target = this.connectionTargets.get(request.target.connectionToken)
    if (target === undefined || !target.ref.tenantId || !this.connectionExists(target.ref)) {
      throw new Error('TARGET_UNAVAILABLE')
    }
    const projection = this.input.projection()
    if (projection.logs === undefined || this.input.logsAvailable?.() === false) {
      throw new Error('OPERATION_UNAVAILABLE')
    }
    const filterDigest = JSON.stringify({ levels: [...levels].sort(), events: [...events].sort() })
    let offset = 0
    if (request.query.cursor !== undefined) {
      const cursor = this.logCursors.get(request.query.cursor)
      if (cursor === undefined) throw new Error('INVALID_CURSOR')
      this.logCursors.delete(request.query.cursor)
      if (cursor.snapshotRevision !== this.revision) throw new Error('STALE_CURSOR')
      if (cursor.connectionToken !== request.target.connectionToken || cursor.filterDigest !== filterDigest) {
        throw new Error('INVALID_CURSOR')
      }
      offset = cursor.offset
    }
    const logs = projection.logs
      .filter(log => connectionKey(log.account) === connectionKey(target.ref))
      .map((log, index) => ({ log, index, level: logLevel(log.outcome), event: logEvent(log.action) }))
      .filter(item => levels.length === 0 || levels.includes(item.level))
      .filter(item => events.length === 0 || events.includes(item.event))
      .sort((left, right) => right.log.recordedAt.localeCompare(left.log.recordedAt) || left.index - right.index)
      .map(item => item.log)
    return { logs, offset, filterDigest }
  }

  private connectionExists(ref: ChannelManagerConnectionProjection['ref']): boolean {
    const key = connectionKey(ref)
    const projection = this.input.projection()
    return [...projection.connections, ...projection.accounts].some(item => connectionKey(item.ref) === key)
  }
}
