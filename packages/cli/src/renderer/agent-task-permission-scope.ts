import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { ApprovalAgentBinding } from '@cordisx/protocol/approval/v2'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type {
  AgentTaskApprovalAuthorityLeaseV1,
  AgentTaskPermissionSourceV1,
} from '@cordisx/protocol/agent-task-permission/v1'
import type {
  AgentApprovalAuthorityRouteRequest,
  AgentRouteSessionScopeOptions,
  AgentRuntimePermissionDeclaration,
} from './agent-route-session-scope.js'

export type AgentTaskScopeSource =
  | AgentTaskPermissionSourceV1
  | Readonly<{
    kind: 'host-agent-task-authority'
    lease: AgentTaskApprovalAuthorityLeaseV1
  }>

interface SourceRecord {
  readonly source: AgentTaskPermissionSourceV1
  readonly requester: ApprovalAgentBinding
  readonly current: () => boolean
  readonly readback: () => Promise<boolean>
}
interface AuthorityRecord {
  readonly lease: AgentTaskApprovalAuthorityLeaseV1
  readonly source: SourceRecord
  readonly current: () => boolean
  permissionLeaseId?: string
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const ownerKey = (owner: PluginOwnerIdentity): string => `${owner.pluginId}\u0000${owner.generation}`

/** Ephemeral Host provenance only. Persistent decisions remain in the existing permission broker. */
export class AgentTaskPermissionScopeAuthority {
  private readonly declarations = new Map<string, readonly AgentRuntimePermissionDeclaration[]>()
  private readonly requiredSessions = new Set<string>()
  private readonly sources = new Map<string, SourceRecord>()
  private readonly authorities = new Map<string, AuthorityRecord>()

  constructor(private readonly options: AgentRouteSessionScopeOptions) {}

  install(owner: PluginOwnerIdentity, declarations: readonly AgentRuntimePermissionDeclaration[]): void {
    this.revoke(owner.pluginId)
    for (const key of this.declarations.keys()) {
      if (key.startsWith(`${owner.pluginId}\u0000`)) this.declarations.delete(key)
    }
    this.declarations.set(ownerKey(owner), declarations)
  }

  uninstall(owner: PluginOwnerIdentity): void {
    this.declarations.delete(ownerKey(owner))
    this.revoke(owner.pluginId)
  }

  declares(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, commandId?: string): boolean {
    const declaration = this.declarations.get(ownerKey(owner))?.find(item => item.name === capability)
    const selector = capability === 'approvals.request' ? declaration?.scope.task : declaration?.scope.taskRequester
    return declaration?.manifestVersion === 12 && selector?.kind === 'agent-task-command'
      && (commandId === undefined || selector.commandId === commandId)
  }

  /** Called only after the owner-store required intent and actual Agent have been matched by Host installation. */
  bind(
    source: AgentTaskPermissionSourceV1,
    requester: ApprovalAgentBinding,
    current: () => boolean,
    readback: () => Promise<boolean>,
  ): () => void {
    if (
      !current() || source.sessionId !== requester.sessionId || requester.agentId !== requester.sessionId
      || !equal(source.definition, requester.definition)
      || source.connectionGeneration !== this.options.connectionGeneration()
      || !this.declares(source.owner, 'approvals.request', source.commandId)
      || !this.declares(source.owner, 'approvals.answer', source.commandId)
    ) throw new Error('Task permission source is unavailable')
    const key = this.key(source.owner, source.sessionId)
    if (this.sources.has(key)) throw new Error('Task permission source already installed')
    const record = {
      source: Object.freeze(structuredClone(source)),
      requester: structuredClone(requester),
      current,
      readback,
    }
    this.requiredSessions.add(key)
    this.sources.set(key, record)
    return () => {
      if (this.sources.get(key) === record) this.sources.delete(key)
      for (const [id, authority] of this.authorities) if (authority.source === record) this.authorities.delete(id)
    }
  }

  markRequired(owner: PluginOwnerIdentity, sessionId: string): void {
    this.requiredSessions.add(this.key(owner, sessionId))
  }

  hasSource(owner: PluginOwnerIdentity, sessionId: string): boolean {
    return this.requiredSessions.has(this.key(owner, sessionId))
  }

  async authorizeRequest(owner: PluginOwnerIdentity, sessionId: string): Promise<boolean> {
    const record = this.sources.get(this.key(owner, sessionId))
    if (record === undefined || !this.active(record)) return false
    const decision = await this.decide(owner, 'approvals.request', sessionId, record.source)
    return decision.authorized && this.active(record)
      && decision.leaseId !== undefined && this.options.isLeaseActive?.(owner, decision.leaseId) === true
  }

  async mint(
    owner: PluginOwnerIdentity,
    request: AgentApprovalAuthorityRouteRequest,
    current: () => boolean,
  ): Promise<AgentTaskApprovalAuthorityLeaseV1 | undefined> {
    const source = this.sources.get(this.key(owner, request.requester.sessionId))
    if (
      source === undefined || !this.active(source)
      || !equal(source.requester, request.requester)
      || !current() || !request.registrationId || !request.routingId
      || !this.declares(owner, 'approvals.answer', source.source.commandId)
    ) return undefined
    const lease: AgentTaskApprovalAuthorityLeaseV1 = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-task-approval-authority-lease.v1.schema.json',
      contract: 'cordisx.agent-task-approval-authority-lease/v1',
      schemaVersion: 1,
      leaseId: crypto.randomUUID(),
      taskSource: source.source,
      routingId: request.routingId,
      registrationId: request.registrationId,
      requester: Object.freeze(structuredClone(request.requester)),
      authority: Object.freeze(structuredClone(request.authority)),
    })
    const record: AuthorityRecord = { lease, source, current }
    this.authorities.set(lease.leaseId, record)
    try {
      const decision = await this.decide(owner, 'approvals.answer', request.authority.sessionId, {
        kind: 'host-agent-task-authority',
        lease,
      })
      if (!decision.authorized || decision.leaseId === undefined) return undefined
      record.permissionLeaseId = decision.leaseId
      return this.leaseActive(owner, lease, request.requester, request.authority) ? lease : undefined
    } finally {
      if (
        record.permissionLeaseId === undefined || !this.leaseActive(owner, lease, request.requester, request.authority)
      ) {
        this.authorities.delete(lease.leaseId)
      }
    }
  }

  /** Broker re-reads Host registration at every asynchronous authorization boundary. */
  validate(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
    source: AgentTaskScopeSource,
  ): boolean {
    if (source.kind === 'host-agent-task') {
      const record = this.sources.get(this.key(owner, sessionId))
      return capability === 'approvals.request' && record !== undefined && record.source === source
        && this.active(record) && source.sessionId === sessionId
    }
    const record = this.authorities.get(source.lease.leaseId)
    return capability === 'approvals.answer' && record?.lease === source.lease
      && ownerKey(owner) === ownerKey(record.source.source.owner)
      && record.lease.authority.sessionId === sessionId && this.active(record.source) && record.current()
  }

  async readback(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
    source: AgentTaskScopeSource,
  ): Promise<boolean> {
    if (!this.validate(owner, capability, sessionId, source)) return false
    const record = source.kind === 'host-agent-task'
      ? this.sources.get(this.key(owner, sessionId))
      : this.authorities.get(source.lease.leaseId)?.source
    try {
      return record !== undefined && await record.readback() && this.validate(owner, capability, sessionId, source)
    } catch {
      return false
    }
  }

  leaseActive(
    owner: PluginOwnerIdentity,
    lease: AgentTaskApprovalAuthorityLeaseV1,
    requester: ApprovalAgentBinding,
    authority: ApprovalAgentBinding,
  ): boolean {
    const record = this.authorities.get(lease.leaseId)
    return record?.lease === lease && equal(lease.requester, requester) && equal(lease.authority, authority)
      && this.validate(owner, 'approvals.answer', authority.sessionId, { kind: 'host-agent-task-authority', lease })
      && record.permissionLeaseId !== undefined
      && this.options.isLeaseActive?.(owner, record.permissionLeaseId) === true
  }

  release(lease: AgentTaskApprovalAuthorityLeaseV1): void {
    this.authorities.delete(lease.leaseId)
  }

  revoke(pluginId: string): void {
    for (const [key, record] of this.sources) if (record.source.owner.pluginId === pluginId) this.sources.delete(key)
    for (const [key, record] of this.authorities) {
      if (record.source.source.owner.pluginId === pluginId) this.authorities.delete(key)
    }
  }

  private active(record: SourceRecord): boolean {
    return this.sources.get(this.key(record.source.owner, record.source.sessionId)) === record
      && record.current() && record.source.connectionGeneration === this.options.connectionGeneration()
      && this.declares(record.source.owner, 'approvals.request', record.source.commandId)
      && this.declares(record.source.owner, 'approvals.answer', record.source.commandId)
  }

  private key(owner: PluginOwnerIdentity, sessionId: string): string {
    return `${ownerKey(owner)}\u0000${sessionId}`
  }

  private async decide(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
    scopeSource: AgentTaskScopeSource,
  ) {
    try {
      return await this.options.decide({
        schemaVersion: 4,
        owner,
        capability,
        scope: { sessionIds: [sessionId] },
        routeId: scopeSource.kind,
        routeInstanceId: scopeSource.kind === 'host-agent-task' ? scopeSource.operationId : scopeSource.lease.routingId,
        scopeSource,
      })
    } catch {
      return { authorized: false }
    }
  }
}
