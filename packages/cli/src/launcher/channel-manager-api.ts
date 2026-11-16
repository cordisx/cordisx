import type {
  ChannelAuditSnapshot,
  ChannelRuntime,
  ChannelRuntimeSnapshot,
  ChannelTenantRef,
} from '@cordisx/channel-runtime'
import type { ChannelAccountIdentity } from './channel-account-identity.js'

export type ChannelManagerActionStatus = 'applied' | 'unavailable' | 'not-found'

export interface ChannelManagerRuntimeProjection {
  readonly contract: 'cordisx.channel-manager-runtime/v1'
  readonly schemaVersion: 1
  readonly observedAt: string
  readonly accounts: readonly (ChannelRuntimeSnapshot['accounts'][number] & ChannelAccountIdentity)[]
  /** Consumer-owned task bindings are intentionally not supplied by Channel. */
  readonly bindings: readonly ChannelManagerBindingProjection[]
}

export interface ChannelManagerBindingProjection {
  readonly bindingId: string
  readonly channel: {
    readonly adapterId: string
    readonly accountId: string
    readonly tenantId: string
    readonly conversationId: string
    readonly threadId: string
  }
  readonly session: { readonly providerId: string; readonly remoteSessionId: string }
  readonly routeId: string
  readonly state: 'active' | 'archived' | 'unavailable'
}

export interface ChannelManagerLogRecord {
  readonly id: string
  readonly recordedAt: string
  readonly account?: ChannelTenantRef
  readonly generation: number
  readonly operationId: string
  readonly action: string
  readonly outcome: string
  readonly capability?: string
  readonly bindingRevision?: number
}

export interface ChannelManagerLogsPage {
  readonly records: readonly ChannelManagerLogRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
}

export interface ChannelManagerLogQuery {
  readonly account?: ChannelTenantRef
  readonly action?: string
  readonly outcome?: string
  readonly offset?: number
  readonly limit?: number
}

export interface ChannelManagerLogsExport {
  readonly filename: string
  readonly payload: string
}

export interface ChannelManagerActionResult {
  readonly conversationPage?: import('./channel-conversation-management.js').ChannelConversationManagementPage
  readonly conversationDetail?: import('./channel-conversation-management.js').ChannelConversationManagementDetail
  readonly conversationActivity?: import('./channel-conversation-management.js').ChannelConversationManagementActivity
  readonly conversationBindings?: import('./channel-conversation-management.js').ChannelConversationManagementBindings
  readonly bindingNavigation?: string
  readonly status: ChannelManagerActionStatus
  readonly generation?: string
  readonly projection?: ChannelManagerRuntimeProjection
  readonly conversationPolicy?: {
    readonly revision: number
    readonly policy: import('./channel-conversation-policy.js').ChannelConversationPolicy
  }
  readonly code?: string
  readonly task?: unknown
  readonly execution?: {
    readonly status: string
    readonly revision?: number
    readonly settings?: unknown
    readonly code?: string
  }
  readonly bindingLabels?: readonly {
    readonly bindingId: string
    readonly sessionName: string
    readonly conversationName: string
  }[]
}

export interface ChannelManagerActionInput {
  /** The active launcher generation observed by the caller. */
  readonly generation?: string
}

export interface ChannelManagerConnectionActionInput extends ChannelManagerActionInput {
  readonly ref: ChannelTenantRef
}

export interface ChannelManagerBindingActionInput extends ChannelManagerActionInput {
  readonly bindingId: string
}

export interface ChannelManagerApi {
  snapshot(): ChannelManagerRuntimeProjection | undefined
  logs(query?: ChannelManagerLogQuery): ChannelManagerLogsPage
  exportLogs(query?: Omit<ChannelManagerLogQuery, 'offset' | 'limit'>): ChannelManagerLogsExport
  readonly connections: {
    enable(input: ChannelManagerConnectionActionInput): Promise<ChannelManagerActionResult>
    disable(input: ChannelManagerConnectionActionInput): Promise<ChannelManagerActionResult>
    reconnect(input: ChannelManagerConnectionActionInput): Promise<ChannelManagerActionResult>
  }
  readonly bindings: {
    archive(input: ChannelManagerBindingActionInput): Promise<ChannelManagerActionResult>
    restore(input: ChannelManagerBindingActionInput): Promise<ChannelManagerActionResult>
    unbind(input: ChannelManagerBindingActionInput): Promise<ChannelManagerActionResult>
  }
}

export interface ActiveChannelManagerRuntime {
  readonly generation: string
  readonly runtime: ChannelRuntime
}

export interface ChannelManagerRuntimeAccess {
  active(): ActiveChannelManagerRuntime | undefined
  identity?(ref: ChannelTenantRef): ChannelAccountIdentity | undefined
  bindings?(): readonly ChannelManagerBindingProjection[]
  binding?(action: 'archive' | 'restore' | 'unbind', id: string): Promise<boolean>
  connection(
    action: 'enable' | 'disable' | 'reconnect',
    ref: ChannelTenantRef,
    expectedGeneration: string,
  ): Promise<ChannelManagerActionStatus>
}

function sameAccount(left: ChannelTenantRef, right: ChannelTenantRef): boolean {
  return left.adapterId === right.adapterId
    && left.accountId === right.accountId
    && left.tenantId === right.tenantId
}

/** Re-project by allowlist so private store/audit fields never cross this seam. */
function projectSnapshot(
  snapshot: ChannelRuntimeSnapshot,
  identity?: ChannelManagerRuntimeAccess['identity'],
  bindings: readonly ChannelManagerBindingProjection[] = [],
): ChannelManagerRuntimeProjection {
  return Object.freeze({
    contract: 'cordisx.channel-manager-runtime/v1',
    schemaVersion: 1,
    observedAt: snapshot.observedAt,
    accounts: snapshot.accounts.map(account =>
      Object.freeze({
        ref: { ...account.ref },
        ...identity?.(account.ref),
        adapterKind: account.adapterKind,
        implementationStatus: account.implementationStatus,
        connectionState: account.connectionState,
        secretState: account.secretState,
        generation: account.generation,
        lastGoodRevision: account.lastGoodRevision,
        ...(account.cursorUpdatedAt === undefined ? {} : { cursorUpdatedAt: account.cursorUpdatedAt }),
        ...(account.lastErrorCode === undefined ? {} : { lastErrorCode: account.lastErrorCode }),
        inbound: { ...account.inbound },
        outbound: { ...account.outbound },
      })
    ),
    bindings: Object.freeze(bindings.map(binding => Object.freeze({ ...binding }))),
  })
}

function projectLog(record: ChannelAuditSnapshot, snapshot: ChannelRuntimeSnapshot): ChannelManagerLogRecord {
  const account = snapshot.accounts.find(candidate => (
    record.accountKey === JSON.stringify([
      candidate.ref.adapterId,
      candidate.ref.accountId,
      candidate.ref.tenantId,
    ])
  ))
  return Object.freeze({
    id: record.auditId,
    recordedAt: record.recordedAt,
    ...(account === undefined ? {} : { account: { ...account.ref } }),
    generation: record.generation,
    operationId: record.operationId,
    action: record.action,
    outcome: record.outcome,
    ...(record.capability === undefined ? {} : { capability: record.capability }),
  })
}

function boundedOffset(value: number | undefined): number {
  return Number.isInteger(value) && value! > 0 ? value! : 0
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined) return 100
  return Math.max(1, Math.min(500, value))
}

function filteredLogs(
  active: ActiveChannelManagerRuntime | undefined,
  query: Omit<ChannelManagerLogQuery, 'offset' | 'limit'> = {},
): readonly ChannelManagerLogRecord[] {
  if (active === undefined) return []
  const snapshot = active.runtime.snapshot()
  return active.runtime.auditSnapshot()
    .map(record => projectLog(record, snapshot))
    .filter(record =>
      query.account === undefined || (record.account !== undefined && sameAccount(record.account, query.account))
    )
    .filter(record => query.action === undefined || record.action === query.action)
    .filter(record => query.outcome === undefined || record.outcome === query.outcome)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id))
}

function logPage(
  active: ActiveChannelManagerRuntime | undefined,
  query: ChannelManagerLogQuery = {},
): ChannelManagerLogsPage {
  const offset = boundedOffset(query.offset)
  const limit = boundedLimit(query.limit)
  const records = filteredLogs(active, query)
  return Object.freeze({
    records: Object.freeze(records.slice(offset, offset + limit)),
    total: records.length,
    offset,
    limit,
    hasMore: offset + limit < records.length,
  })
}

function expectedActive(
  access: ChannelManagerRuntimeAccess,
  input: ChannelManagerActionInput,
): ActiveChannelManagerRuntime | undefined {
  const active = access.active()
  if (active === undefined || (input.generation !== undefined && input.generation !== active.generation)) {
    return undefined
  }
  return active
}

function result(access: ChannelManagerRuntimeAccess, status: ChannelManagerActionStatus): ChannelManagerActionResult {
  const active = access.active()
  return Object.freeze({
    status,
    ...(active === undefined
      ? {}
      : {
        generation: active.generation,
        projection: projectSnapshot(active.runtime.snapshot(), access.identity, access.bindings?.()),
      }),
  })
}

/**
 * Host-private manager action API. It deliberately has no renderer binding;
 * callers receive redacted projections and explicit, refreshable outcomes.
 */
export function createChannelManagerApi(access: ChannelManagerRuntimeAccess): ChannelManagerApi {
  const connection = async (
    action: 'enable' | 'disable' | 'reconnect',
    input: ChannelManagerConnectionActionInput,
  ): Promise<ChannelManagerActionResult> => {
    const active = expectedActive(access, input)
    if (active === undefined) return result(access, 'unavailable')
    return result(access, await access.connection(action, input.ref, active.generation))
  }

  const binding = async (
    action: 'archive' | 'restore' | 'unbind',
    input: ChannelManagerBindingActionInput,
  ): Promise<ChannelManagerActionResult> => {
    const active = expectedActive(access, input)
    if (active === undefined) return result(access, 'unavailable')
    const status = access.binding === undefined
      ? 'unavailable'
      : await access.binding(action, input.bindingId)
      ? 'applied'
      : 'not-found'
    return result(access, status)
  }

  return Object.freeze({
    snapshot: () => {
      const active = access.active()
      return active === undefined
        ? undefined
        : projectSnapshot(active.runtime.snapshot(), access.identity, access.bindings?.())
    },
    logs: (query?: ChannelManagerLogQuery) => logPage(access.active(), query),
    exportLogs: (query?: Omit<ChannelManagerLogQuery, 'offset' | 'limit'>) => {
      const records = filteredLogs(access.active(), query)
      const exportedAt = new Date().toISOString()
      return Object.freeze({
        filename: `cordisx-channel-logs-${exportedAt.replace(/[:.]/g, '-')}.json`,
        payload: `${
          JSON.stringify(
            {
              contract: 'cordisx.channel-manager-logs-export/v1',
              schemaVersion: 1,
              exportedAt,
              records,
            },
            null,
            2,
          )
        }\n`,
      })
    },
    connections: Object.freeze({
      enable: async (input: ChannelManagerConnectionActionInput) => await connection('enable', input),
      disable: async (input: ChannelManagerConnectionActionInput) => await connection('disable', input),
      reconnect: async (input: ChannelManagerConnectionActionInput) => await connection('reconnect', input),
    }),
    bindings: Object.freeze({
      archive: async (input: ChannelManagerBindingActionInput) => await binding('archive', input),
      restore: async (input: ChannelManagerBindingActionInput) => await binding('restore', input),
      unbind: async (input: ChannelManagerBindingActionInput) => await binding('unbind', input),
    }),
  })
}
