import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v2'
import type { AgentAdmissionTarget } from '@cordisx/protocol/agent-admission/v3'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
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
    sourceMessageId: string
    sourceSessionId: string
    targetSessionId: string
  }>): Promise<PlaygroundScenarioSessionScopeActivationResult>
  release(input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>): void
}

export interface PlaygroundScenarioConversationOrigin {
  readonly owner: string
  readonly bindingId: string
  readonly ownerGeneration: string
  readonly snapshotGeneration: string
  readonly roomId: string
  readonly routeId: string
  readonly runs: readonly Readonly<{
    readonly runId: string
    readonly sessionId: string
    readonly participantId?: string
    readonly memberId?: string
  }>[]
  readonly active: () => boolean
  /** Present only for Shell v8: capability created by Host command admission. */
  readonly admissionOrigin?: AgentCommandOrigin
  /** Present only for Shell v9: Host capability minted before any Room run exists. */
  readonly bootstrapOrigin?: AgentBootstrapCommandOrigin
}

/** Host Shell only; never projected through plugin context. */
export interface PlaygroundScenarioConversationSourceAuthority {
  execute<Value>(origin: PlaygroundScenarioConversationOrigin, operation: () => Promise<Value>): Promise<Value>
  fenceBinding(bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode): void
}

export interface PlaygroundScenarioSubmissionCapture {
  /** True only while the exact command/owner/connection source authority remains live. */
  active(): boolean
  commit(): void
  close(): void
}

export interface PlaygroundScenarioSessionScopeAuthorityOptions {
  readonly hostGeneration: string
  readonly connectionGeneration: () => number
  /** Legacy exact route fallback for non-Shell Host callers. */
  readonly currentRoute: () => AgentRuntimeRouteScope | undefined
  /** The exact live Agent owner for source and target Sessions. */
  readonly ownerForSession: (sessionId: string) => PluginOwnerIdentity | undefined
  /** Host-only authenticated mapping; never derive source coordinates from an opaque owner string. */
  readonly routeOwner: (owner: PluginOwnerIdentity) => AgentRuntimeRouteScope['owner'] | undefined
  /** Resolves only the installed dynamic declaration owned by this plugin. */
  readonly permissionRoute: (owner: PluginOwnerIdentity, capability: AgentRuntimeCapability) => Readonly<{
    readonly routeId: string
    readonly path: string
  }> | undefined
  readonly authorize: (
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
  ) => Promise<boolean>
  /** Mounts a supplemental exact route in the existing PermissionBroker. */
  readonly mountRoute: (route: AgentRuntimeRouteScope) => () => void
  /** Reconcile the single normal permission/route authority after a change. */
  readonly changed: (active: boolean) => void
}

interface ConversationOriginRecord extends PlaygroundScenarioConversationOrigin {
  readonly token: object
}

interface CapturedSourceRecord {
  readonly key: string
  readonly origin: ConversationOriginRecord
  readonly owner: PluginOwnerIdentity
  readonly sourceMessageId: string
  readonly sourceSessionId: string
  readonly roomRunId: string
  readonly permissionRoute: Readonly<{ readonly routeId: string; readonly path: string }>
  readonly connectionGeneration: number
  active: boolean
  committed: boolean
  scenarioRunId?: string
}

interface ActivationRecord {
  readonly runId: string
  readonly source: CapturedSourceRecord | undefined
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly route: AgentRuntimeRouteScope
  readonly handle: PlaygroundScenarioSessionScopeHandle
  readonly disposeRoute: () => void
  readonly settle: (value: Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>) => void
  active: boolean
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '*'
}

function sameOwner(left: PluginOwnerIdentity | undefined, right: PluginOwnerIdentity): boolean {
  return left !== undefined && left.pluginId === right.pluginId && left.generation === right.generation
}

function sourceKey(sessionId: string, messageId: string): string { return `${sessionId}\u0000${messageId}` }

/**
 * Host-private Playground authority. The originating Shell command captures
 * an exact Room/binding/run capability while it is current; Agent submission
 * commits that capability under the source MessageId before the deterministic
 * driver can execute asynchronous scenario steps.
 */
export class PlaygroundScenarioSessionScopeAuthority {
  private readonly commandOrigins = new Set<ConversationOriginRecord>()
  private readonly sources = new Map<string, CapturedSourceRecord>()
  private current?: ActivationRecord
  private disposed = false

  readonly client: PlaygroundScenarioSessionScopeClient = Object.freeze({
    activate: async (input: Readonly<{ runId: string; sourceMessageId: string; sourceSessionId: string; targetSessionId: string }>) => await this.activate(input),
    release: (input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>) => { this.release(input) },
  })

  readonly conversationSource: PlaygroundScenarioConversationSourceAuthority = Object.freeze({
    execute: async <Value>(origin: PlaygroundScenarioConversationOrigin, operation: () => Promise<Value>) => await this.executeConversation(origin, operation),
    fenceBinding: (bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode) => { this.fenceBinding(bindingId, code) },
  })

  constructor(private readonly options: PlaygroundScenarioSessionScopeAuthorityOptions) {
    if (!opaque(options.hostGeneration)) throw new Error('Playground scenario Host generation is invalid')
  }

  effectiveRoute(): AgentRuntimeRouteScope | undefined {
    return this.current?.active === true ? this.current.route : this.options.currentRoute()
  }

  /** Exact Agent authority retained with the supplemental route; never reconstructed from its public owner. */
  supplementalOwner(): PluginOwnerIdentity | undefined {
    const current = this.current
    return current?.active === true ? current.source?.owner : undefined
  }

  active(): boolean { return this.current?.active === true && !this.disposed }

  captureSubmission(owner: PluginOwnerIdentity, sessionId: string, messageId: string): PlaygroundScenarioSubmissionCapture | undefined {
    if (this.disposed || !opaque(sessionId) || !opaque(messageId)) return undefined
    const candidates = [...this.commandOrigins].filter(origin => origin.active()
      && origin.owner === owner.pluginId
      && origin.runs.some(run => run.sessionId === sessionId))
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    const matchingRuns = origin.runs.filter(run => run.sessionId === sessionId)
    if (matchingRuns.length !== 1) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) return undefined
    const key = sourceKey(sessionId, messageId)
    if (this.sources.has(key)) return undefined
    const source: CapturedSourceRecord = {
      key, origin, owner: Object.freeze({ ...owner }), sourceMessageId: messageId, sourceSessionId: sessionId,
      roomRunId: matchingRuns[0]!.runId, permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(), active: true, committed: false,
    }
    this.sources.set(key, source)
    let open = true
    return Object.freeze({
      active: () => open && this.sources.get(key) === source && source.active && !this.disposed
        && origin.active() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open) return
        open = false
        if (this.sources.get(key) !== source || !source.active) return
        if (!origin.active() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()) {
          this.retireSource(source, 'stale')
          return
        }
        source.committed = true
      },
      close: () => {
        if (!open) return
        open = false
        this.retireSource(source, 'completed')
      },
    })
  }

  /**
   * v2 pre-submit capture. The admitted handle is authoritative: unlike the
   * frozen v1 fallback it may be a Session created inside the command handler.
   */
  admissionTargetActive(owner: PluginOwnerIdentity, admissionOrigin: AgentCommandOrigin, target: AgentAdmissionTarget): boolean {
    if (this.disposed || !opaque(target.participantId) || !opaque(target.memberId) || !opaque(target.runId)) return false
    const candidates = [...this.commandOrigins].filter(origin => origin.active()
      && origin.owner === owner.pluginId && this.sameAdmissionOrigin(origin.admissionOrigin, admissionOrigin)
      && origin.runs.some(run => run.runId === target.runId
        && run.participantId === target.participantId && run.memberId === target.memberId))
    return candidates.length === 1
  }

  captureAdmissionTarget(
    owner: PluginOwnerIdentity,
    admissionOrigin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (!this.admissionTargetActive(owner, admissionOrigin, target)) return undefined
    return this.captureAdmissionForTarget(owner, admissionOrigin, target, sessionId, agentGeneration, messageId)
  }

  captureAdmission(
    owner: PluginOwnerIdentity,
    admissionOrigin: AgentCommandOrigin,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    return this.captureAdmissionForTarget(owner, admissionOrigin, admissionOrigin.room, sessionId, agentGeneration, messageId)
  }

  /** Shell v9/v4 declares a newly materialized target while its bootstrap command is live. */
  bootstrapAdmissionTargetActive(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
  ): boolean {
    if (this.disposed || !this.validBootstrapOrigin(bootstrapOrigin)
      || !opaque(target.participantId) || !opaque(target.memberId) || !opaque(target.runId)) return false
    const candidates = [...this.commandOrigins].filter(origin => origin.active()
      && origin.owner === owner.pluginId && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin))
    return candidates.length === 1
  }

  captureBootstrapAdmissionTarget(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (!this.bootstrapAdmissionTargetActive(owner, bootstrapOrigin, target)) return undefined
    const candidates = [...this.commandOrigins].filter(origin => origin.active()
      && origin.owner === owner.pluginId && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin))
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (origin.bindingId !== bootstrapOrigin.binding.bindingId || origin.ownerGeneration !== bootstrapOrigin.binding.ownerGeneration
      || !sameOwner(this.options.ownerForSession(sessionId), owner)) return undefined
    return this.captureAdmissionFromConversationOrigin(owner, origin, target, sessionId, agentGeneration, messageId)
  }

  private captureAdmissionForTarget(
    owner: PluginOwnerIdentity,
    admissionOrigin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (this.disposed || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration) || agentGeneration < 1) return undefined
    const candidates = [...this.commandOrigins].filter(origin => origin.active()
      && origin.owner === owner.pluginId
      && origin.admissionOrigin?.originId === admissionOrigin.originId
      && origin.admissionOrigin.executionId === admissionOrigin.executionId
      && origin.admissionOrigin.binding.bindingId === admissionOrigin.binding.bindingId
      && origin.admissionOrigin.binding.ownerGeneration === admissionOrigin.binding.ownerGeneration
      && origin.admissionOrigin.generation === admissionOrigin.generation
      && origin.admissionOrigin.commandId === admissionOrigin.commandId
      && origin.admissionOrigin.scope === admissionOrigin.scope
      && origin.admissionOrigin.room.roomId === admissionOrigin.room.roomId
      && origin.admissionOrigin.room.participantId === admissionOrigin.room.participantId
      && origin.admissionOrigin.room.memberId === admissionOrigin.room.memberId
      && origin.admissionOrigin.room.runId === admissionOrigin.room.runId)
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (origin.bindingId !== admissionOrigin.binding.bindingId || origin.ownerGeneration !== admissionOrigin.binding.ownerGeneration
      || origin.roomId !== admissionOrigin.room.roomId || !sameOwner(this.options.ownerForSession(sessionId), owner)
      || !origin.runs.some(run => run.runId === target.runId && run.participantId === target.participantId && run.memberId === target.memberId)) return undefined
    return this.captureAdmissionFromConversationOrigin(owner, origin, target, sessionId, agentGeneration, messageId)
  }

  private captureAdmissionFromConversationOrigin(
    owner: PluginOwnerIdentity,
    origin: ConversationOriginRecord,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (this.disposed || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration) || agentGeneration < 1) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) return undefined
    const key = sourceKey(sessionId, messageId)
    if (this.sources.has(key)) return undefined
    const source: CapturedSourceRecord = {
      key, origin, owner: Object.freeze({ ...owner }), sourceMessageId: messageId, sourceSessionId: sessionId,
      roomRunId: target.runId, permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(), active: true, committed: false,
    }
    this.sources.set(key, source)
    let open = true
    return Object.freeze({
      active: () => open && this.sources.get(key) === source && source.active && !this.disposed
        && origin.active() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open) return
        open = false
        if (this.sources.get(key) !== source || !source.active) return
        if (!origin.active() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()) {
          this.retireSource(source, 'stale')
          return
        }
        source.committed = true
      },
      close: () => {
        if (!open) return
        open = false
        this.retireSource(source, 'completed')
      },
    })
  }

  private sameAdmissionOrigin(left: AgentCommandOrigin | undefined, right: AgentCommandOrigin): boolean {
    return left !== undefined && left.originId === right.originId && left.executionId === right.executionId
      && left.binding.bindingId === right.binding.bindingId && left.binding.ownerGeneration === right.binding.ownerGeneration
      && left.generation === right.generation && left.commandId === right.commandId && left.scope === right.scope
      && left.room.roomId === right.room.roomId && left.room.participantId === right.room.participantId
      && left.room.memberId === right.room.memberId && left.room.runId === right.room.runId
  }

  private validBootstrapOrigin(origin: AgentBootstrapCommandOrigin | undefined): origin is AgentBootstrapCommandOrigin {
    return origin !== undefined
      && origin.$schema === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json'
      && origin.contract === 'cordisx.agent-bootstrap-command-origin/v1' && origin.schemaVersion === 1
      && origin.scope === 'composer-submit' && opaque(origin.originId) && opaque(origin.executionId)
      && opaque(origin.binding.bindingId) && opaque(origin.binding.ownerGeneration)
      && opaque(origin.generation) && opaque(origin.commandId)
  }

  private sameBootstrapOrigin(left: AgentBootstrapCommandOrigin | undefined, right: AgentBootstrapCommandOrigin): boolean {
    return left !== undefined && left.originId === right.originId && left.executionId === right.executionId
      && left.binding.bindingId === right.binding.bindingId && left.binding.ownerGeneration === right.binding.ownerGeneration
      && left.generation === right.generation && left.commandId === right.commandId && left.scope === right.scope
  }

  reconcileVisibleRoute(): void {
    const source = this.current?.source
    if (source !== undefined && (!source.active || !source.origin.active())) this.retireSource(source, 'route-replaced')
  }

  fenceSession(sessionId: string, code: Exclude<PlaygroundScenarioSessionScopeClosedCode, 'completed' | 'authorization-unavailable' | 'disposed'>): void {
    for (const source of [...this.sources.values()]) {
      if (source.active && source.sourceSessionId === sessionId) this.retireSource(source, code)
    }
    const current = this.current
    if (current?.active === true && current.targetSessionId === sessionId) this.retire(current, code)
  }

  closeRun(runId: string): void {
    const current = this.current
    if (current?.active === true && current.runId === runId) this.retire(current, 'completed')
    for (const source of [...this.sources.values()]) if (source.scenarioRunId === runId) this.retireSource(source, 'completed')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.current
    if (current?.active === true) this.retire(current, 'disposed')
    for (const source of [...this.sources.values()]) this.retireSource(source, 'disposed')
    this.commandOrigins.clear()
  }

  private async executeConversation<Value>(origin: PlaygroundScenarioConversationOrigin, operation: () => Promise<Value>): Promise<Value> {
    if (this.disposed || !this.validOrigin(origin)) return await operation()
    const record: ConversationOriginRecord = Object.freeze({
      ...origin, runs: Object.freeze(origin.runs.map(run => Object.freeze({ ...run }))), token: Object.freeze({}),
    })
    this.commandOrigins.add(record)
    try { return await operation() }
    finally {
      this.commandOrigins.delete(record)
      // An unsubmitted v2 reservation has no durable authority after its
      // command completes. A committed source remains available only for the
      // ensuing deterministic scenario activation.
      for (const source of [...this.sources.values()]) {
        if (source.origin === record && !source.committed) this.retireSource(source, 'completed')
      }
    }
  }

  private validOrigin(origin: PlaygroundScenarioConversationOrigin): boolean {
    if (!opaque(origin.owner) || !opaque(origin.bindingId) || !opaque(origin.ownerGeneration)
      || !opaque(origin.snapshotGeneration) || !opaque(origin.roomId) || !opaque(origin.routeId)
      || typeof origin.active !== 'function' || !origin.active()
      || !Array.isArray(origin.runs) || origin.runs.length > 64) return false
    if (origin.bootstrapOrigin === undefined && origin.runs.length === 0) return false
    if (origin.bootstrapOrigin !== undefined && (!this.validBootstrapOrigin(origin.bootstrapOrigin)
      || origin.bootstrapOrigin.binding.bindingId !== origin.bindingId
      || origin.bootstrapOrigin.binding.ownerGeneration !== origin.ownerGeneration)) return false
    const seen = new Set<string>()
    for (const run of origin.runs) {
      if (!opaque(run.runId) || !opaque(run.sessionId)) return false
      const key = `${run.runId}\u0000${run.sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  }

  private fenceBinding(bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode): void {
    if (!opaque(bindingId)) return
    for (const source of [...this.sources.values()]) {
      if (source.origin.bindingId === bindingId) this.retireSource(source, code)
    }
  }

  private async activate(input: Readonly<{
    runId: string
    sourceMessageId: string
    sourceSessionId: string
    targetSessionId: string
  }>): Promise<PlaygroundScenarioSessionScopeActivationResult> {
    if (this.disposed) return this.unavailable('disposed', 'Playground scenario Session scope authority is disposed.')
    if (!opaque(input.runId) || !opaque(input.sourceMessageId) || !opaque(input.sourceSessionId) || !opaque(input.targetSessionId)) {
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
    const source = this.sources.get(sourceKey(input.sourceSessionId, input.sourceMessageId))
    if (source === undefined) {
      return this.unavailable('source-route-unavailable', 'The scenario source Session has no captured exact Room authority.')
    }
    if (!source.active || !source.committed || !source.origin.active()
      || source.connectionGeneration !== this.options.connectionGeneration()
      || !sameOwner(this.options.ownerForSession(input.sourceSessionId), source.owner)) {
      this.retireSource(source, 'stale')
      return this.unavailable('stale', 'The captured scenario source authority is stale.')
    }
    if (source.scenarioRunId !== undefined && source.scenarioRunId !== input.runId) {
      return this.unavailable('activation-conflict', 'The captured scenario source authority belongs to another run.')
    }
    source.scenarioRunId = input.runId
    const sourceOwner = source.owner
    const routeDefinition = source.permissionRoute
    const owner = this.options.ownerForSession(input.targetSessionId)
    if (owner === undefined) return this.unavailable('session-unavailable', 'The delegated scenario Session is unavailable.')
    if (!sameOwner(owner, sourceOwner)) {
      return this.unavailable('owner-mismatch', 'The delegated scenario Session has a different plugin owner or generation.')
    }
    const routeOwner = this.options.routeOwner(owner)
    if (routeOwner === undefined) return this.unavailable('owner-mismatch', 'The delegated scenario Session owner is invalid.')
    const routeInstanceId = `playground-scenario:${this.options.hostGeneration}:${input.runId}`
    if (!opaque(routeInstanceId)) return this.unavailable('invalid-request', 'The scenario route activation identity is invalid.')
    const route: AgentRuntimeRouteScope = Object.freeze({
      kind: 'host-route', active: true,
      owner: Object.freeze({ ...routeOwner }), routeId: routeDefinition.routeId, routeInstanceId,
      path: routeDefinition.path, params: Object.freeze({ sessionId: input.targetSessionId }),
    })
    let disposeRoute: () => void
    try { disposeRoute = this.options.mountRoute(route) }
    catch { return this.unavailable('route-unavailable', 'The exact delegated Session route could not be activated.') }
    let settle!: ActivationRecord['settle']
    const closed = new Promise<Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>>(resolve => { settle = resolve })
    let record!: ActivationRecord
    const handle: PlaygroundScenarioSessionScopeHandle = Object.freeze({
      runId: input.runId, sessionId: input.targetSessionId, routeInstanceId, closed,
      active: () => record.active && this.current === record && !this.disposed
        && (record.source === undefined || record.source.active && record.source.origin.active()
          && record.source.connectionGeneration === this.options.connectionGeneration()),
      close: () => { if (record.active && this.current === record) this.retire(record, 'completed') },
    })
    record = {
      runId: input.runId, source, sourceSessionId: input.sourceSessionId, targetSessionId: input.targetSessionId,
      route, handle, disposeRoute, settle, active: true,
    }
    this.current = record
    this.options.changed(true)
    let authorized = false
    try { authorized = await this.options.authorize(owner, 'approvals.request', input.targetSessionId) } catch { authorized = false }
    if (!record.active || this.current !== record || this.disposed
      || !source.active || !source.origin.active() || source.connectionGeneration !== this.options.connectionGeneration()) {
      if (record.active) this.retire(record, 'route-replaced')
      return this.unavailable('stale', 'The scenario Session scope was fenced before authorization completed.')
    }
    if (!authorized) {
      this.retire(record, 'authorization-unavailable')
      return this.unavailable('authorization-unavailable', 'The exact delegated Session approval scope is unavailable.')
    }
    return Object.freeze({ status: 'available', handle })
  }

  private release(input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>): void {
    if (!opaque(input.sourceMessageId) || !opaque(input.sourceSessionId) || !opaque(input.runId)) return
    const source = this.sources.get(sourceKey(input.sourceSessionId, input.sourceMessageId))
    if (source === undefined || source.scenarioRunId !== undefined && source.scenarioRunId !== input.runId) return
    if (this.current?.source === source && this.current.active) this.retire(this.current, 'completed')
    this.retireSource(source, 'completed')
  }

  private retireSource(source: CapturedSourceRecord, code: PlaygroundScenarioSessionScopeClosedCode | 'stale'): void {
    if (!source.active) return
    source.active = false
    if (this.sources.get(source.key) === source) this.sources.delete(source.key)
    const current = this.current
    if (current?.source === source && current.active) this.retire(current, code === 'stale' ? 'route-replaced' : code)
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
