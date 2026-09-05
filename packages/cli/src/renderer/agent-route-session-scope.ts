import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { ApprovalAgentBinding } from '@cordisx/protocol/approval/v2'
import type { PluginApprovalAuthorityLeaseV8 } from '@cordisx/protocol/plugin-manifest/v8'

const DYNAMIC_CAPABILITIES = new Set<AgentRuntimeCapability>([
  'agents.create',
  'agents.resume',
  'agents.get',
  'agents.message.submit',
  'agents.message.cancel',
  'agents.cancel',
  'agents.live.subscribe',
  'sessions.get',
  'sessions.read',
  'sessions.subscribe',
  'approvals.request',
  'approvals.answer',
])
const localId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const paramId = /^[a-z][a-zA-Z0-9]*$/u

export interface AgentRouteDefinition {
  readonly id: string
  readonly path: string
  readonly schemaVersion?: 1 | 2
}

export interface AgentActiveRoute {
  readonly owner: PluginOwnerIdentity
  readonly routeId: string
  readonly instanceId: string
  readonly params: Readonly<Record<string, string | number | boolean | null>>
}

export interface AgentRouteScopeBinding {
  readonly kind: 'host-route-param'
  readonly routeId: string
  readonly param: string
}

export interface AgentRuntimePermissionDeclaration {
  /** Host-owned source schema discriminator; omitted only by legacy v5 callers. */
  readonly manifestVersion?: 5 | 6 | 8
  readonly name: AgentRuntimeCapability
  readonly required: boolean
  readonly scope: Readonly<
    {
      readonly sessionIds?: readonly string[] | AgentRouteScopeBinding
      readonly authorityRequester?: AgentApprovalAuthorityRequesterScope
    }
  >
}

export interface AgentApprovalAuthorityRequesterScope {
  readonly kind: 'approval-authority-requester-route'
  readonly requester: AgentRouteScopeBinding
}

export interface AgentApprovalAuthorityRouteRequest {
  readonly routingId: string
  readonly registrationId: string
  readonly requester: ApprovalAgentBinding
  readonly authority: ApprovalAgentBinding
}

export interface AgentPermissionPlanV4 {
  readonly schemaVersion: 4
  readonly owner: PluginOwnerIdentity
  readonly capability: AgentRuntimeCapability
  readonly scope: Readonly<{ readonly sessionIds: readonly [string, ...string[]] }>
  readonly routeId: string
  readonly routeInstanceId: string
  readonly scopeSource: Readonly<
    | {
      kind: 'host-route'
      routeId: string
      routeInstanceId: string
      path: string
      params: Readonly<{ sessionId: string }>
    }
    | { kind: 'host-create'; reservedSessionId: string }
    | { kind: 'host-exact'; exactSessionId: string }
  >
}

export interface AgentPermissionLeaseV4 extends AgentPermissionPlanV4 {
  readonly leaseId: string
  readonly pluginGeneration: number
  readonly connectionGeneration: number
  readonly status: 'active' | 'revoked'
}

export type AgentRouteFenceCode =
  | 'route-replaced'
  | 'plugin-generation-replaced'
  | 'permission-revoked'
  | 'connection-replaced'

export interface AgentRouteSessionScopeOptions {
  readonly activeRoute: () => AgentActiveRoute | undefined
  readonly routes: (owner: PluginOwnerIdentity) => readonly AgentRouteDefinition[]
  /** Host-only permission-v4 decision seam; it receives an already exact scope. */
  readonly decide: (plan: AgentPermissionPlanV4) => Promise<Readonly<{ authorized: boolean; leaseId?: string }>>
  readonly isLeaseActive?: (owner: PluginOwnerIdentity, leaseId: string) => boolean
  readonly connectionGeneration: () => number
}

interface InstalledDeclaration {
  readonly owner: PluginOwnerIdentity
  readonly declaration: AgentRuntimePermissionDeclaration
}

interface LeaseRecord {
  readonly lease: AgentPermissionLeaseV4
  readonly sessionId: string
  readonly routeParam: string
  readonly permissionLeaseId?: string
}

interface ApprovalAuthorityLeaseRecord {
  readonly lease: PluginApprovalAuthorityLeaseV8
  readonly owner: PluginOwnerIdentity
  readonly routeParam: 'sessionId'
  readonly routeInstanceId: string
  readonly connectionGeneration: number
}

/**
 * Host-private dynamic Session scope resolver. It accepts no route identity or
 * Session id from a caller as authority: the active Host route is read during
 * each authorization, then an exact permission-v4 plan is submitted.
 */
export class AgentRouteSessionScopeAuthority {
  private readonly declarations = new Map<string, InstalledDeclaration[]>()
  private readonly generations = new Map<string, number>()
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly listeners = new Set<(owner: string, sessionId: string, code: AgentRouteFenceCode) => void>()
  private readonly approvalAuthorityLeases = new Map<string, ApprovalAuthorityLeaseRecord>()

  constructor(private readonly options: AgentRouteSessionScopeOptions) {}

  install(owner: PluginOwnerIdentity, declarations: readonly AgentRuntimePermissionDeclaration[]): void {
    if (this.declarations.has(owner.pluginId)) this.fence(owner.pluginId, 'plugin-generation-replaced')
    const names = new Set<AgentRuntimeCapability>()
    for (const declaration of declarations) {
      if (names.has(declaration.name)) {
        throw new Error(`duplicate Agent runtime capability declaration: ${declaration.name}`)
      }
      names.add(declaration.name)
    }
    const normalized = declarations.map(item => this.validate(owner, item))
    this.declarations.set(owner.pluginId, normalized)
    this.generations.set(owner.pluginId, owner.generation)
  }

  /** Must run after the same plugin's route contributions have mounted. */
  validateInstalledRoutes(owner: PluginOwnerIdentity): void {
    if (this.generations.get(owner.pluginId) !== owner.generation) {
      throw new Error('Agent Session permission declaration generation is stale')
    }
    for (const installed of this.declarations.get(owner.pluginId) ?? []) {
      if (installed.owner.generation !== owner.generation) {
        throw new Error('Agent Session permission declaration generation is stale')
      }
      const scope = installed.declaration.scope.sessionIds
      if (isBinding(scope)) {
        const route = this.options.routes(owner).find(item => item.id === scope.routeId)
        if (route === undefined || !validRouteBinding(route, scope, installed.declaration.manifestVersion)) {
          throw new Error('dynamic Agent Session scope does not name an owned route parameter')
        }
      }
      const authorityRequester = installed.declaration.scope.authorityRequester
      if (authorityRequester !== undefined) {
        const route = this.options.routes(owner).find(item => item.id === authorityRequester.requester.routeId)
        if (route === undefined || !validRouteBinding(route, authorityRequester.requester, 8)) {
          throw new Error('invalid approval authority requester route declaration')
        }
      }
    }
  }

  /** Host-only readback of one installed exact dynamic permission route. */
  permissionRoute(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability): AgentRouteDefinition | undefined {
    const installed = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === capability)
    const declaration = installed?.owner.generation === owner.generation ? installed.declaration : undefined
    const scope = declaration?.scope.sessionIds
    if (!isBinding(scope)) return undefined
    const route = this.options.routes(owner).find(item => item.id === scope.routeId)
    return route === undefined || !validRouteBinding(route, scope, declaration?.manifestVersion)
      ? undefined
      : Object.freeze({ ...route })
  }

  /**
   * Registration-time declaration check. This never reads an active route,
   * asks for a permission decision, or creates a lease. Dynamic declarations
   * are accepted only when their exact owned route definition is valid.
   */
  declares(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability): boolean {
    const installed = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === capability)
    const declaration = installed?.owner.generation === owner.generation ? installed.declaration : undefined
    if (declaration === undefined) return false
    const scope = declaration.scope.sessionIds
    if (isBinding(scope)) {
      const route = this.options.routes(owner).find(item => item.id === scope.routeId)
      if (route === undefined || !validRouteBinding(route, scope, declaration.manifestVersion)) return false
    }
    const authorityRequester = declaration.scope.authorityRequester
    if (authorityRequester === undefined) return true
    const route = this.options.routes(owner).find(item => item.id === authorityRequester.requester.routeId)
    return route !== undefined && validRouteBinding(route, authorityRequester.requester, 8)
  }

  uninstall(owner: PluginOwnerIdentity): void {
    if (this.generations.get(owner.pluginId) !== owner.generation) return
    this.fence(owner.pluginId, 'plugin-generation-replaced')
    this.declarations.delete(owner.pluginId)
    this.generations.delete(owner.pluginId)
  }

  subscribe(listener: (owner: string, sessionId: string, code: AgentRouteFenceCode) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Call on history/navigation changes; it settles every stale lease. */
  reconcileRoutes(): void {
    for (const [key, record] of this.leases) {
      if (record.lease.status !== 'active' || !this.matchesActiveRoute(record)) {
        this.leases.delete(key)
        this.emit(
          record.lease.owner.pluginId,
          record.sessionId,
          record.lease.connectionGeneration === this.options.connectionGeneration()
            ? 'route-replaced'
            : 'connection-replaced',
        )
      }
    }
  }

  revoke(owner: string, code: Exclude<AgentRouteFenceCode, 'route-replaced'> = 'permission-revoked'): void {
    this.fence(owner, code)
  }

  /** Permission-store changes invalidate v1 leases until their exact decision is re-established. */
  revokeAll(code: Exclude<AgentRouteFenceCode, 'route-replaced'> = 'permission-revoked'): void {
    for (const owner of new Set([...this.leases.values()].map(item => item.lease.owner.pluginId))) {
      this.fence(owner, code)
    }
  }

  async authorize(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean> {
    const installed = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === capability)
    const declaration = installed?.owner.generation === owner.generation ? installed.declaration : undefined
    if (declaration === undefined) return false
    if (sessionId === undefined) return false
    if (!validSessionId(sessionId)) return false
    const scope = declaration.scope.sessionIds
    if (scope === undefined) {
      const source: AgentPermissionPlanV4['scopeSource'] = capability === 'agents.create'
        ? { kind: 'host-create', reservedSessionId: sessionId }
        : { kind: 'host-exact', exactSessionId: sessionId }
      const decision = await this.decide(owner, capability, [sessionId], source)
      return decision.authorized
        && (decision.leaseId === undefined || this.options.isLeaseActive?.(owner, decision.leaseId) !== false)
    }
    if (Array.isArray(scope)) {
      if (!scope.includes(sessionId)) return false
      const decision = await this.decide(owner, capability, [sessionId], {
        kind: 'host-exact',
        exactSessionId: sessionId,
      })
      return decision.authorized
        && (decision.leaseId === undefined || this.options.isLeaseActive?.(owner, decision.leaseId) !== false)
    }
    if (!isBinding(scope)) return false
    const active = this.options.activeRoute()
    if (active === undefined || !sameOwner(active.owner, owner) || active.routeId !== scope.routeId) return false
    const value = active.params[scope.param]
    if (typeof value !== 'string' || value !== sessionId || !validSessionId(value)) return false
    const route = this.options.routes(owner).find(item => item.id === scope.routeId)
    if (route === undefined || !validRouteBinding(route, scope, declaration.manifestVersion)) return false
    const key =
      `${owner.pluginId}\u0000${owner.generation}\u0000${capability}\u0000${sessionId}\u0000${active.instanceId}\u0000${this.options.connectionGeneration()}`
    const existing = this.leases.get(key)
    if (
      existing?.lease.status === 'active'
      && (existing.permissionLeaseId === undefined
        || this.options.isLeaseActive?.(owner, existing.permissionLeaseId) !== false)
    ) return true
    const decision = await this.decide(owner, capability, [sessionId], {
      kind: 'host-route',
      routeId: scope.routeId,
      routeInstanceId: active.instanceId,
      path: route.path,
      params: { sessionId },
    })
    if (!decision.authorized) return false
    const lease = Object.freeze({
      schemaVersion: 4 as const,
      owner: Object.freeze({ ...owner }),
      capability,
      scope: Object.freeze({ sessionIds: Object.freeze([sessionId] as [string]) }),
      routeId: scope.routeId,
      routeInstanceId: active.instanceId,
      leaseId: crypto.randomUUID(),
      pluginGeneration: owner.generation,
      connectionGeneration: this.options.connectionGeneration(),
      status: 'active' as const,
      scopeSource: Object.freeze({
        kind: 'host-route' as const,
        routeId: scope.routeId,
        routeInstanceId: active.instanceId,
        path: route.path,
        params: Object.freeze({ sessionId }),
      }),
    })
    this.leases.set(key, {
      lease,
      sessionId,
      routeParam: scope.param,
      ...(decision.leaseId === undefined ? {} : { permissionLeaseId: decision.leaseId }),
    })
    return true
  }

  /** Mints a one-use-in-context authority lease only after Host accepted v3 routing. */
  async mintApprovalAuthorityLease(
    owner: PluginOwnerIdentity,
    request: AgentApprovalAuthorityRouteRequest,
  ): Promise<PluginApprovalAuthorityLeaseV8 | undefined> {
    const installed = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === 'approvals.answer')
    const declaration = installed?.owner.generation === owner.generation ? installed.declaration : undefined
    const scope = declaration?.scope.authorityRequester
    if (scope === undefined || declaration?.required || !this.sameBindingOwner(owner, request)) return undefined
    const active = this.options.activeRoute()
    if (active === undefined || !sameOwner(active.owner, owner) || active.routeId !== scope.requester.routeId) {
      return undefined
    }
    const routeSessionId = active.params[scope.requester.param]
    if (
      typeof routeSessionId !== 'string' || routeSessionId !== request.requester.sessionId
      || request.requester.agentId !== routeSessionId
      || request.authority.sessionId === request.requester.sessionId
      || request.authority.agentId !== request.authority.sessionId
    ) return undefined
    const route = this.options.routes(owner).find(item => item.id === scope.requester.routeId)
    if (route === undefined || !validRouteBinding(route, scope.requester, 8)) return undefined
    const decision = await this.decide(owner, 'approvals.answer', [request.authority.sessionId], {
      kind: 'host-route',
      routeId: scope.requester.routeId,
      routeInstanceId: active.instanceId,
      path: route.path,
      params: { sessionId: routeSessionId },
    })
    if (!decision.authorized) return undefined
    if (this.options.isLeaseActive?.(owner, decision.leaseId ?? '') === false) return undefined
    const correlation = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-authority-route-correlation.v1.schema.json' as const,
      contract: 'cordisx.approval-authority-route-correlation/v1' as const,
      schemaVersion: 1 as const,
      routingId: request.routingId,
      registrationId: request.registrationId,
      owner: Object.freeze({ ...owner }),
      route: Object.freeze({
        routeId: scope.requester.routeId,
        param: 'sessionId' as const,
        sessionId: routeSessionId,
      }),
      requester: Object.freeze(structuredClone(request.requester)),
      authority: Object.freeze(structuredClone(request.authority)),
    })
    const lease = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-authority-route-lease.v1.schema.json' as const,
      contract: 'cordisx.approval-authority-route-lease/v1' as const,
      schemaVersion: 1 as const,
      leaseId: crypto.randomUUID(),
      correlation,
    })
    this.approvalAuthorityLeases.set(lease.leaseId, {
      lease,
      owner: Object.freeze({ ...owner }),
      routeParam: 'sessionId',
      routeInstanceId: active.instanceId,
      connectionGeneration: this.options.connectionGeneration(),
    })
    return lease
  }

  requiresApprovalAuthorityLease(owner: PluginOwnerIdentity): boolean {
    const installed = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === 'approvals.answer')
    return installed?.owner.generation === owner.generation
      && installed.declaration.scope.authorityRequester !== undefined
  }

  approvalAuthorityLeaseActive(
    owner: PluginOwnerIdentity,
    lease: PluginApprovalAuthorityLeaseV8,
    requester: ApprovalAgentBinding,
    authority: ApprovalAgentBinding,
  ): boolean {
    const stored = this.approvalAuthorityLeases.get(lease.leaseId)
    if (
      stored === undefined || stored.lease !== lease || !sameOwner(stored.owner, owner)
      || JSON.stringify(lease.correlation.requester) !== JSON.stringify(requester)
      || JSON.stringify(lease.correlation.authority) !== JSON.stringify(authority)
      || stored.connectionGeneration !== this.options.connectionGeneration()
    ) return false
    const active = this.options.activeRoute()
    return active !== undefined && sameOwner(active.owner, owner) && active.instanceId === stored.routeInstanceId
      && active.routeId === lease.correlation.route.routeId
      && active.params[stored.routeParam] === lease.correlation.route.sessionId
  }

  releaseApprovalAuthorityLease(lease: PluginApprovalAuthorityLeaseV8): void {
    this.approvalAuthorityLeases.delete(lease.leaseId)
  }

  private validate(owner: PluginOwnerIdentity, declaration: AgentRuntimePermissionDeclaration): InstalledDeclaration {
    const scope = declaration.scope.sessionIds
    if (isBinding(scope)) {
      if (
        !DYNAMIC_CAPABILITIES.has(declaration.name) || declaration.required || !localId.test(scope.routeId)
        || !paramId.test(scope.param) || (declaration.manifestVersion === 6 && scope.param !== 'sessionId')
      ) {
        throw new Error('invalid dynamic Agent Session permission declaration')
      }
    }
    if (
      Array.isArray(scope)
      && (scope.length === 0 || new Set(scope).size !== scope.length || scope.some(item => !validSessionId(item)))
    ) {
      throw new Error('exact Agent Session scopes require unique non-wildcard sessionIds')
    }
    const authorityRequester = declaration.scope.authorityRequester
    if (
      authorityRequester !== undefined && (declaration.manifestVersion !== 8 || declaration.name !== 'approvals.answer'
        || declaration.required || authorityRequester.kind !== 'approval-authority-requester-route'
        || !localId.test(authorityRequester.requester.routeId) || authorityRequester.requester.param !== 'sessionId')
    ) {
      throw new Error('invalid approval authority requester route declaration')
    }
    return Object.freeze({
      owner: Object.freeze({ ...owner }),
      declaration: Object.freeze({
        ...declaration,
        scope: Object.freeze({
          ...(scope === undefined
            ? {}
            : { sessionIds: Array.isArray(scope) ? Object.freeze([...scope]) : Object.freeze({ ...scope }) }),
          ...(authorityRequester === undefined
            ? {}
            : {
              authorityRequester: Object.freeze({
                kind: authorityRequester.kind,
                requester: Object.freeze({ ...authorityRequester.requester }),
              }),
            }),
        }),
      }),
    })
  }

  private async decide(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionIds: readonly [string, ...string[]],
    scopeSource: AgentPermissionPlanV4['scopeSource'],
  ): Promise<Readonly<{ authorized: boolean; leaseId?: string }>> {
    const plan: AgentPermissionPlanV4 = Object.freeze({
      schemaVersion: 4,
      owner: Object.freeze({ ...owner }),
      capability,
      scope: Object.freeze({ sessionIds: Object.freeze([...sessionIds]) as [string, ...string[]] }),
      routeInstanceId: scopeSource.kind === 'host-route'
        ? scopeSource.routeInstanceId
        : scopeSource.kind === 'host-create'
        ? `reserved:${scopeSource.reservedSessionId}`
        : `exact:${scopeSource.exactSessionId}`,
      routeId: scopeSource.kind === 'host-route' ? scopeSource.routeId : scopeSource.kind,
      scopeSource: Object.freeze(scopeSource),
    })
    try {
      return await this.options.decide(plan)
    } catch {
      return Object.freeze({ authorized: false })
    }
  }

  private matchesActiveRoute(record: LeaseRecord): boolean {
    const active = this.options.activeRoute()
    return active !== undefined && sameOwner(active.owner, record.lease.owner)
      && active.instanceId === record.lease.routeInstanceId
      && active.params[record.routeParam] === record.sessionId
      && record.lease.connectionGeneration === this.options.connectionGeneration()
  }

  private fence(owner: string, code: Exclude<AgentRouteFenceCode, 'route-replaced'>): void {
    for (const [key, record] of this.leases) {
      if (record.lease.owner.pluginId !== owner) continue
      this.leases.delete(key)
      this.emit(owner, record.sessionId, code)
    }
    for (const [leaseId, record] of this.approvalAuthorityLeases) {
      if (record.owner.pluginId === owner) this.approvalAuthorityLeases.delete(leaseId)
    }
  }

  private sameBindingOwner(owner: PluginOwnerIdentity, request: AgentApprovalAuthorityRouteRequest): boolean {
    return request.requester.agentId === request.requester.sessionId
      && request.authority.agentId === request.authority.sessionId
      && request.requester.agentGeneration > 0 && request.authority.agentGeneration > 0
      && request.requester.definition.agentId.length > 0 && request.requester.definition.revision.length > 0
      && request.authority.definition.agentId.length > 0 && request.authority.definition.revision.length > 0
      && owner.pluginId.length > 0
  }

  private emit(owner: string, sessionId: string, code: AgentRouteFenceCode): void {
    for (const listener of this.listeners) listener(owner, sessionId, code)
  }
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('*')
}
function routeHasParam(path: string, param: string): boolean {
  return path.split('/').filter(segment => segment === `:${param}`).length === 1
}
function validRouteBinding(
  route: AgentRouteDefinition,
  scope: AgentRouteScopeBinding,
  manifestVersion: 5 | 6 | 8 | undefined,
): boolean {
  return routeHasParam(route.path, scope.param)
    && ((manifestVersion !== 6 && manifestVersion !== 8) || route.schemaVersion === 2)
}
function sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean {
  return left.pluginId === right.pluginId && left.generation === right.generation
}
function isBinding(value: readonly string[] | AgentRouteScopeBinding | undefined): value is AgentRouteScopeBinding {
  return value !== undefined && !Array.isArray(value)
}
