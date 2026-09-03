import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { AgentRuntimeRouteScope } from './platform.js'

export type PlaygroundScenarioSessionScopeClosedCode =
  | 'completed'
  | 'route-replaced'
  | 'plugin-generation-replaced'
  | 'permission-revoked'
  | 'connection-replaced'
  | 'authorization-unavailable'
  | 'disposed'

export interface PlaygroundScenarioSessionScopeHandle {
  readonly runId: string
  readonly sessionId: string
  readonly routeInstanceId: string
  readonly closed: Promise<Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>>
  active(): boolean
  close(): void
}

export type PlaygroundScenarioSessionScopeActivationResult =
  | Readonly<{ status: 'available'; handle: PlaygroundScenarioSessionScopeHandle }>
  | Readonly<{
    status: 'unavailable'
    code: 'invalid-request' | 'source-route-unavailable' | 'session-unavailable' | 'owner-mismatch'
      | 'activation-conflict' | 'route-unavailable' | 'authorization-unavailable' | 'stale' | 'disposed'
    message: string
  }>

export interface PlaygroundScenarioSessionScopeClient {
  activate(input: Readonly<{
    runId: string
    sourceSessionId: string
    targetSessionId: string
  }>): Promise<PlaygroundScenarioSessionScopeActivationResult>
}

export interface PlaygroundScenarioSessionScopeAuthorityOptions {
  readonly hostGeneration: string
  /** The real visible Host route, never a caller-provided route projection. */
  readonly currentRoute: () => AgentRuntimeRouteScope | undefined
  /** The exact persisted Agent owner for the target Session. */
  readonly ownerForSession: (sessionId: string) => PluginOwnerIdentity | undefined
  readonly authorize: (
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
  ) => Promise<boolean>
  /** Mounts a supplemental exact route in the existing PermissionBroker. */
  readonly mountRoute: (baseRouteInstanceId: string, route: AgentRuntimeRouteScope) => () => void
  /** Reconcile the single normal PermissionBroker/route authority after a change. */
  readonly changed: (active: boolean) => void
}

interface ActivationRecord {
  readonly runId: string
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly base: AgentRuntimeRouteScope
  readonly route: AgentRuntimeRouteScope
  readonly handle: PlaygroundScenarioSessionScopeHandle
  readonly disposeRoute: () => void
  readonly settle: (value: Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>) => void
  active: boolean
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '*'
}

function sameVisibleRoute(left: AgentRuntimeRouteScope | undefined, right: AgentRuntimeRouteScope): boolean {
  return left !== undefined
    && left.owner.source === right.owner.source
    && left.owner.pluginId === right.owner.pluginId
    && left.routeId === right.routeId
    && left.routeInstanceId === right.routeInstanceId
    && left.path === right.path
    && left.params.sessionId === right.params.sessionId
}

/**
 * Host-private Playground authority for temporarily projecting one delegated
 * Session through the same exact route and PermissionBroker used by the real
 * Room. It does not navigate, persist a grant, or expose a plugin service.
 */
export class PlaygroundScenarioSessionScopeAuthority {
  private current?: ActivationRecord
  private disposed = false

  readonly client: PlaygroundScenarioSessionScopeClient = Object.freeze({
    activate: async (input: Readonly<{ runId: string; sourceSessionId: string; targetSessionId: string }>) => await this.activate(input),
  })

  constructor(private readonly options: PlaygroundScenarioSessionScopeAuthorityOptions) {
    if (!opaque(options.hostGeneration)) throw new Error('Playground scenario Host generation is invalid')
  }

  effectiveRoute(): AgentRuntimeRouteScope | undefined {
    return this.current?.active === true ? this.current.route : this.options.currentRoute()
  }

  active(): boolean { return this.current?.active === true && !this.disposed }

  reconcileVisibleRoute(): void {
    const current = this.current
    if (current === undefined || !current.active) return
    if (!sameVisibleRoute(this.options.currentRoute(), current.base)) this.retire(current, 'route-replaced')
  }

  fenceSession(sessionId: string, code: Exclude<PlaygroundScenarioSessionScopeClosedCode, 'completed' | 'authorization-unavailable' | 'disposed'>): void {
    const current = this.current
    if (current?.active === true && current.targetSessionId === sessionId) this.retire(current, code)
  }

  closeRun(runId: string): void {
    const current = this.current
    if (current?.active === true && current.runId === runId) this.retire(current, 'completed')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.current
    if (current?.active === true) this.retire(current, 'disposed')
  }

  private async activate(input: Readonly<{
    runId: string
    sourceSessionId: string
    targetSessionId: string
  }>): Promise<PlaygroundScenarioSessionScopeActivationResult> {
    if (this.disposed) return this.unavailable('disposed', 'Playground scenario Session scope authority is disposed.')
    if (!opaque(input.runId) || !opaque(input.sourceSessionId) || !opaque(input.targetSessionId)) {
      return this.unavailable('invalid-request', 'Playground scenario Session scope request is invalid.')
    }
    if (input.sourceSessionId === input.targetSessionId) {
      return this.unavailable('invalid-request', 'Playground scenario Session scope requires a delegated target Session.')
    }
    const prior = this.current
    if (prior?.active === true) {
      if (prior.runId === input.runId && prior.sourceSessionId === input.sourceSessionId
        && prior.targetSessionId === input.targetSessionId) return Object.freeze({ status: 'available', handle: prior.handle })
      return this.unavailable('activation-conflict', 'Another Playground scenario Session scope is already active.')
    }
    const base = this.options.currentRoute()
    if (base === undefined || base.params.sessionId !== input.sourceSessionId) {
      return this.unavailable('source-route-unavailable', 'The scenario source Session is not the exact active Room route.')
    }
    const owner = this.options.ownerForSession(input.targetSessionId)
    if (owner === undefined) return this.unavailable('session-unavailable', 'The delegated scenario Session is unavailable.')
    const qualifiedOwner = `${base.owner.source}:${base.owner.pluginId}`
    if (owner.pluginId !== qualifiedOwner) {
      return this.unavailable('owner-mismatch', 'The delegated scenario Session has a different plugin owner.')
    }
    const routeInstanceId = `playground-scenario:${this.options.hostGeneration}:${input.runId}`
    if (!opaque(routeInstanceId)) return this.unavailable('invalid-request', 'The scenario route activation identity is invalid.')
    const route: AgentRuntimeRouteScope = Object.freeze({
      kind: 'host-route', active: true,
      owner: Object.freeze({ ...base.owner }), routeId: base.routeId, routeInstanceId,
      path: base.path, params: Object.freeze({ sessionId: input.targetSessionId }),
    })
    let disposeRoute: () => void
    try { disposeRoute = this.options.mountRoute(base.routeInstanceId, route) }
    catch { return this.unavailable('route-unavailable', 'The exact delegated Session route could not be activated.') }
    let settle!: ActivationRecord['settle']
    const closed = new Promise<Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>>(resolve => { settle = resolve })
    let record!: ActivationRecord
    const handle: PlaygroundScenarioSessionScopeHandle = Object.freeze({
      runId: input.runId, sessionId: input.targetSessionId, routeInstanceId, closed,
      active: () => record.active && this.current === record && !this.disposed,
      close: () => { if (record.active && this.current === record) this.retire(record, 'completed') },
    })
    record = {
      runId: input.runId, sourceSessionId: input.sourceSessionId, targetSessionId: input.targetSessionId,
      base: Object.freeze({ ...base, owner: Object.freeze({ ...base.owner }), params: Object.freeze({ ...base.params }) }),
      route, handle, disposeRoute, settle, active: true,
    }
    this.current = record
    this.options.changed(true)
    let authorized = false
    try { authorized = await this.options.authorize(owner, 'approvals.request', input.targetSessionId) } catch { authorized = false }
    this.reconcileVisibleRoute()
    if (!record.active || this.current !== record || this.disposed) {
      return this.unavailable('stale', 'The scenario Session scope was fenced before authorization completed.')
    }
    if (!authorized) {
      this.retire(record, 'authorization-unavailable')
      return this.unavailable('authorization-unavailable', 'The exact delegated Session approval scope is unavailable.')
    }
    return Object.freeze({ status: 'available', handle })
  }

  private retire(record: ActivationRecord, code: PlaygroundScenarioSessionScopeClosedCode): void {
    if (!record.active) return
    record.active = false
    if (this.current === record) delete this.current
    try { record.disposeRoute() }
    catch { /* first-terminal cleanup continues even if a downstream observer fails */ }
    finally {
      record.settle(Object.freeze({ code }))
      this.options.changed(false)
    }
  }

  private unavailable(
    code: Extract<PlaygroundScenarioSessionScopeActivationResult, { readonly status: 'unavailable' }>['code'],
    message: string,
  ): PlaygroundScenarioSessionScopeActivationResult {
    return Object.freeze({ status: 'unavailable', code, message })
  }
}
