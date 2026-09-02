import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'

const DYNAMIC_CAPABILITIES = new Set<AgentRuntimeCapability>([
  'agents.create', 'agents.resume', 'agents.get', 'agents.message.submit', 'agents.message.cancel',
  'agents.cancel', 'agents.live.subscribe', 'sessions.get', 'sessions.read',
  'sessions.subscribe', 'approvals.request', 'approvals.answer',
])
const SESSION_CAPABILITIES = new Set<AgentRuntimeCapability>([
  'sessions.get', 'sessions.read', 'sessions.subscribe',
])
const localId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const paramId = /^[a-z][a-zA-Z0-9]*$/u

export interface AgentRouteDefinition {
  readonly id: string
  readonly path: string
}

export interface AgentActiveRoute {
  readonly owner: string
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
  readonly name: AgentRuntimeCapability
  readonly required: boolean
  readonly scope: Readonly<{ readonly sessionIds?: readonly string[] | AgentRouteScopeBinding }>
}

export interface AgentPermissionPlanV4 {
  readonly schemaVersion: 4
  readonly owner: PluginOwnerIdentity
  readonly capability: AgentRuntimeCapability
  readonly scope: Readonly<{ readonly sessionIds: readonly [string, ...string[]] }>
  readonly routeId: string
  readonly routeInstanceId: string
  readonly scopeSource: Readonly<
    | { kind: 'host-route'; routeId: string; routeInstanceId: string; path: string; params: Readonly<{ sessionId: string }> }
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

export type AgentRouteFenceCode = 'route-replaced' | 'plugin-generation-replaced' | 'permission-revoked' | 'connection-replaced'

export interface AgentRouteSessionScopeOptions {
  readonly activeRoute: () => AgentActiveRoute | undefined
  readonly routes: (owner: string) => readonly AgentRouteDefinition[]
  /** Host-only permission-v4 decision seam; it receives an already exact scope. */
  readonly decide: (plan: AgentPermissionPlanV4) => Promise<Readonly<{ authorized: boolean; leaseId?: string }>>
  readonly isLeaseActive?: (owner: PluginOwnerIdentity, leaseId: string) => boolean
  readonly connectionGeneration: () => number
}

interface InstalledDeclaration {
  readonly owner: string
  readonly declaration: AgentRuntimePermissionDeclaration
}

interface LeaseRecord {
  readonly lease: AgentPermissionLeaseV4
  readonly sessionId: string
  readonly routeParam: string
  readonly permissionLeaseId?: string
}

/**
 * Host-private dynamic Session scope resolver. It accepts no route identity or
 * Session id from a caller as authority: the active Host route is read during
 * each authorization, then an exact permission-v4 plan is submitted.
 */
export class AgentRouteSessionScopeAuthority {
  private readonly declarations = new Map<string, InstalledDeclaration[]>()
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly listeners = new Set<(owner: string, sessionId: string, code: AgentRouteFenceCode) => void>()

  constructor(private readonly options: AgentRouteSessionScopeOptions) {}

  install(owner: string, declarations: readonly AgentRuntimePermissionDeclaration[]): void {
    const normalized = declarations.map(item => this.validate(owner, item))
    this.declarations.set(owner, normalized)
  }

  /** Must run after the same plugin's route contributions have mounted. */
  validateInstalledRoutes(owner: string): void {
    for (const installed of this.declarations.get(owner) ?? []) {
      const scope = installed.declaration.scope.sessionIds
    if (isBinding(scope)) {
        const route = this.options.routes(owner).find(item => item.id === scope.routeId)
        if (route === undefined || !routeHasParam(route.path, scope.param)) {
          throw new Error('dynamic Agent Session scope does not name an owned route parameter')
        }
      }
    }
  }

  uninstall(owner: string): void { this.fence(owner, 'plugin-generation-replaced') }

  subscribe(listener: (owner: string, sessionId: string, code: AgentRouteFenceCode) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Call on history/navigation changes; it settles every stale lease. */
  reconcileRoutes(): void {
    for (const [key, record] of this.leases) {
      if (record.lease.status !== 'active' || !this.matchesActiveRoute(record)) {
        this.leases.delete(key)
        this.emit(record.lease.owner.pluginId, record.sessionId, 'route-replaced')
      }
    }
  }

  revoke(owner: string, code: Exclude<AgentRouteFenceCode, 'route-replaced'> = 'permission-revoked'): void { this.fence(owner, code) }

  /** Permission-store changes invalidate v1 leases until their exact decision is re-established. */
  revokeAll(code: Exclude<AgentRouteFenceCode, 'route-replaced'> = 'permission-revoked'): void {
    for (const owner of new Set([...this.leases.values()].map(item => item.lease.owner.pluginId))) this.fence(owner, code)
  }

  async authorize(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, sessionId?: string): Promise<boolean> {
    const declaration = this.declarations.get(owner.pluginId)?.find(item => item.declaration.name === capability)?.declaration
    if (declaration === undefined) return false
    if (sessionId === undefined) return false
    if (!validSessionId(sessionId)) return false
    const scope = declaration.scope.sessionIds
    if (scope === undefined) {
      const source: AgentPermissionPlanV4['scopeSource'] = capability === 'agents.create'
        ? { kind: 'host-create', reservedSessionId: sessionId }
        : { kind: 'host-exact', exactSessionId: sessionId }
      const decision = await this.decide(owner, capability, [sessionId], source)
      return decision.authorized && (decision.leaseId === undefined || this.options.isLeaseActive?.(owner, decision.leaseId) !== false)
    }
    if (Array.isArray(scope)) {
      if (!scope.includes(sessionId)) return false
      const decision = await this.decide(owner, capability, [sessionId], { kind: 'host-exact', exactSessionId: sessionId })
      return decision.authorized && (decision.leaseId === undefined || this.options.isLeaseActive?.(owner, decision.leaseId) !== false)
    }
    if (!isBinding(scope)) return false
    const active = this.options.activeRoute()
    if (active === undefined || active.owner !== owner.pluginId || active.routeId !== scope.routeId) return false
    const value = active.params[scope.param]
    if (typeof value !== 'string' || value !== sessionId || !validSessionId(value)) return false
    const route = this.options.routes(owner.pluginId).find(item => item.id === scope.routeId)
    if (route === undefined || !routeHasParam(route.path, scope.param)) return false
    const key = `${owner.pluginId}\u0000${owner.generation}\u0000${capability}\u0000${sessionId}\u0000${active.instanceId}\u0000${this.options.connectionGeneration()}`
    const existing = this.leases.get(key)
    if (existing?.lease.status === 'active' && (existing.permissionLeaseId === undefined || this.options.isLeaseActive?.(owner, existing.permissionLeaseId) !== false)) return true
    const decision = await this.decide(owner, capability, [sessionId], {
      kind: 'host-route', routeId: scope.routeId, routeInstanceId: active.instanceId, path: route.path, params: { sessionId },
    })
    if (!decision.authorized) return false
    const lease = Object.freeze({
      schemaVersion: 4 as const, owner: Object.freeze({ ...owner }), capability,
      scope: Object.freeze({ sessionIds: Object.freeze([sessionId] as [string]) }),
      routeId: scope.routeId, routeInstanceId: active.instanceId, leaseId: crypto.randomUUID(), pluginGeneration: owner.generation,
      connectionGeneration: this.options.connectionGeneration(), status: 'active' as const,
      scopeSource: Object.freeze({
        kind: 'host-route' as const, routeId: scope.routeId, routeInstanceId: active.instanceId,
        path: route.path, params: Object.freeze({ sessionId }),
      }),
    })
    this.leases.set(key, { lease, sessionId, routeParam: scope.param, ...(decision.leaseId === undefined ? {} : { permissionLeaseId: decision.leaseId }) })
    return true
  }

  private validate(owner: string, declaration: AgentRuntimePermissionDeclaration): InstalledDeclaration {
    const scope = declaration.scope.sessionIds
    if (isBinding(scope)) {
      if (!DYNAMIC_CAPABILITIES.has(declaration.name) || declaration.required || !localId.test(scope.routeId) || !paramId.test(scope.param)) {
        throw new Error('invalid dynamic Agent Session permission declaration')
      }
    }
    if (SESSION_CAPABILITIES.has(declaration.name)) {
      if (Array.isArray(scope) && (scope.length === 0 || scope.some(item => !validSessionId(item)))) {
        throw new Error('Session read declarations require exact non-wildcard sessionIds')
      }
    }
    if (Array.isArray(scope) && scope.some(item => !validSessionId(item))) throw new Error('invalid exact SessionId scope')
    return Object.freeze({ owner, declaration: Object.freeze({ ...declaration, scope: Object.freeze({ ...(scope === undefined ? {} : { sessionIds: Array.isArray(scope) ? Object.freeze([...scope]) : Object.freeze({ ...scope }) }) }) }) })
  }

  private async decide(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionIds: readonly [string, ...string[]],
    scopeSource: AgentPermissionPlanV4['scopeSource'],
  ): Promise<Readonly<{ authorized: boolean; leaseId?: string }>> {
    const plan: AgentPermissionPlanV4 = Object.freeze({
      schemaVersion: 4, owner: Object.freeze({ ...owner }), capability,
      scope: Object.freeze({ sessionIds: Object.freeze([...sessionIds]) as [string, ...string[]] }),
      routeInstanceId: scopeSource.kind === 'host-route'
        ? scopeSource.routeInstanceId
        : scopeSource.kind === 'host-create' ? `reserved:${scopeSource.reservedSessionId}` : `exact:${scopeSource.exactSessionId}`,
      routeId: scopeSource.kind === 'host-route' ? scopeSource.routeId : scopeSource.kind,
      scopeSource: Object.freeze(scopeSource),
    })
    try { return await this.options.decide(plan) } catch { return Object.freeze({ authorized: false }) }
  }

  private matchesActiveRoute(record: LeaseRecord): boolean {
    const active = this.options.activeRoute()
    return active !== undefined && active.owner === record.lease.owner.pluginId
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
  }

  private emit(owner: string, sessionId: string, code: AgentRouteFenceCode): void {
    for (const listener of this.listeners) listener(owner, sessionId, code)
  }
}

function validSessionId(value: string): boolean { return value.length > 0 && value.length <= 512 && value !== '*' }
function routeHasParam(path: string, param: string): boolean { return path.split('/').includes(`:${param}`) }
function isBinding(value: readonly string[] | AgentRouteScopeBinding | undefined): value is AgentRouteScopeBinding {
  return value !== undefined && !Array.isArray(value)
}
