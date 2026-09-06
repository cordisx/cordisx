import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v2'
import type { AgentAdmissionTarget } from '@cordisx/protocol/agent-admission/v3'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
} from '@cordisx/protocol/agent-admission/v5'
import type {
  AgentAdmissionBootstrapRouteContinuation,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6'
import type {
  AgentPageAdmissionRouteClaimReceipt,
  AgentPageAdmissionRouteTarget,
  AgentPageAdmissionTarget,
  AgentPageComposerOrigin,
} from '@cordisx/protocol/agent-page-admission/v2'
import type { AgentRuntimeRouteScope } from '../platform.js'

import {
  ActivationRecord,
  CapturedScenarioSource,
  CapturedSourceRecord,
  ConversationOriginRecord,
  opaque,
  PageCapturedSourceRecord,
  PlaygroundScenarioBootstrapRouteActivation,
  PlaygroundScenarioConversationOrigin,
  PlaygroundScenarioConversationSourceAuthority,
  PlaygroundScenarioSessionScopeActivationResult,
  PlaygroundScenarioSessionScopeAuthorityOptions,
  PlaygroundScenarioSessionScopeClient,
  PlaygroundScenarioSessionScopeClosedCode,
  PlaygroundScenarioSubmissionCapture,
  sameOwner,
  sourceKey,
} from './playground-scenario-session-scope-contract.js'

export abstract class PlaygroundScenarioSessionScopeAuthorityBase {
  protected readonly commandOrigins = new Set<ConversationOriginRecord>()

  protected readonly sources = new Map<string, CapturedSourceRecord>()

  protected readonly pageSources = new Map<string, PageCapturedSourceRecord>()

  protected current?: ActivationRecord

  protected disposed = false

  readonly client: PlaygroundScenarioSessionScopeClient = Object.freeze({
    activate: async (
      input: Readonly<{ runId: string; sourceMessageId: string; sourceSessionId: string; targetSessionId: string }>,
    ) => await this.activate(input),
    release: (input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>) => {
      this.release(input)
    },
  })

  readonly conversationSource: PlaygroundScenarioConversationSourceAuthority = Object.freeze({
    execute: async <Value>(origin: PlaygroundScenarioConversationOrigin, operation: () => Promise<Value>) =>
      await this.executeConversation(origin, operation),
    fenceBinding: (bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode) => {
      this.fenceBinding(bindingId, code)
    },
    claimBootstrapRoute: (input: PlaygroundScenarioBootstrapRouteActivation) => {
      this.claimBootstrapRoute(input)
    },
  })

  constructor(protected readonly options: PlaygroundScenarioSessionScopeAuthorityOptions) {
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

  active(): boolean {
    return this.current?.active === true && !this.disposed
  }

  captureSubmission(
    owner: PluginOwnerIdentity,
    sessionId: string,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (this.disposed || !opaque(sessionId) || !opaque(messageId)) return undefined
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner)
      && origin.runs.some(run => run.sessionId === sessionId)
    )
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    const matchingRuns = origin.runs.filter(run => run.sessionId === sessionId)
    if (matchingRuns.length !== 1) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) {
      return undefined
    }
    const key = sourceKey(sessionId, messageId)
    if (this.sourceFor(key) !== undefined) return undefined
    const source: CapturedSourceRecord = {
      kind: 'conversation',
      key,
      origin,
      owner: Object.freeze({ ...owner }),
      sourceMessageId: messageId,
      sourceSessionId: sessionId,
      roomRunId: matchingRuns[0]!.runId,
      permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(),
      active: true,
      committed: false,
    }
    this.sources.set(key, source)
    let open = true
    return Object.freeze({
      active: () =>
        open && this.sources.get(key) === source && source.active && !this.disposed
        && origin.active() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open) return
        open = false
        if (this.sources.get(key) !== source || !source.active) return
        if (
          !origin.active() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()
        ) {
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
  admissionTargetActive(
    owner: PluginOwnerIdentity,
    admissionOrigin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
  ): boolean {
    if (this.disposed || !opaque(target.participantId) || !opaque(target.memberId) || !opaque(target.runId)) {
      return false
    }
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && this.sameAdmissionOrigin(origin.admissionOrigin, admissionOrigin)
      && origin.runs.some(run =>
        run.runId === target.runId
        && run.participantId === target.participantId && run.memberId === target.memberId
      )
    )
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
    return this.captureAdmissionForTarget(
      owner,
      admissionOrigin,
      admissionOrigin.room,
      sessionId,
      agentGeneration,
      messageId,
    )
  }

  /**
   * Host-only page-admission capture. A fresh page target is deliberately not
   * usable by scenario work until the page lifecycle has atomically claimed
   * its exact destination binding.
   */
  capturePageAdmission(
    owner: PluginOwnerIdentity,
    origin: AgentPageComposerOrigin,
    target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
    commandActive: () => boolean,
    originActive: () => boolean,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (
      this.disposed || !this.validPageOrigin(origin) || !this.validPageTarget(target)
      || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration)
      || agentGeneration < 1 || typeof commandActive !== 'function' || typeof originActive !== 'function'
      || !commandActive() || !originActive()
      || !sameOwner(this.options.ownerForSession(sessionId), owner)
    ) return undefined
    const fresh = this.pageRouteTarget(target)
    if (
      fresh
        ? origin.page.roomId !== undefined
          || target.route.outlet !== origin.page.outlet
          || target.route.routeDefinitionId === origin.page.routeDefinitionId
        : origin.page.roomId !== target.roomId
    ) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) {
      return undefined
    }
    const key = sourceKey(sessionId, messageId)
    if (this.sourceFor(key) !== undefined) return undefined
    const source: PageCapturedSourceRecord = {
      kind: 'page',
      key,
      owner: Object.freeze({ ...owner }),
      origin: Object.freeze(structuredClone(origin)),
      target: Object.freeze(structuredClone(target)),
      originActive,
      commandActive,
      sourceMessageId: messageId,
      sourceSessionId: sessionId,
      roomRunId: target.runId,
      permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(),
      fresh,
      active: true,
      committed: false,
    }
    this.pageSources.set(key, source)
    let open = true
    let closed = false
    return Object.freeze({
      active: () =>
        open && !closed && this.pageSources.get(key) === source && source.active && !this.disposed
        && commandActive() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open || closed) return
        open = false
        if (this.pageSources.get(key) !== source || !source.active) return
        if (
          !commandActive() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()
        ) {
          this.retireSource(source, 'stale')
          return
        }
        source.committed = true
      },
      close: () => {
        if (closed) return
        closed = true
        open = false
        this.retireSource(source, 'completed')
      },
    })
  }

  /**
   * Host-only page destination claim. The receipt is created by the admitted
   * page lifecycle; plugins have neither this method nor the binding callback.
   */
  claimPageAdmission(
    owner: PluginOwnerIdentity,
    receipt: AgentPageAdmissionRouteClaimReceipt,
    bindingActive: () => boolean,
  ): boolean {
    if (
      this.disposed || !this.validPageClaimReceipt(receipt) || typeof bindingActive !== 'function' || !bindingActive()
      || !sameOwner(receipt.owner, owner)
    ) return false
    const source = this.pageSources.get(sourceKey(receipt.source.sessionId, receipt.source.messageId))
    if (
      source === undefined || !source.active || !source.committed || !source.fresh || source.claimed !== undefined
      || !sameOwner(source.owner, owner) || !this.samePageOrigin(source.origin, receipt.origin)
      || !this.samePageTarget(source.target, receipt.target)
      || receipt.binding.binding.bindingId === source.origin.binding.bindingId
      || receipt.binding.generation !== source.origin.generation
      || !this.pageRouteTarget(source.target)
      || !this.samePageRoute(source.target.route, receipt.binding.route)
      || !sameOwner(this.options.ownerForSession(source.sourceSessionId), source.owner)
      || source.connectionGeneration !== this.options.connectionGeneration()
    ) return false
    source.claimed = Object.freeze({ receipt: Object.freeze(structuredClone(receipt)), active: bindingActive })
    return true
  }

  /** Shell v9/v4 declares a newly materialized target while its bootstrap command is live. */
  bootstrapAdmissionTargetActive(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
  ): boolean {
    if (
      this.disposed || !this.validBootstrapOrigin(bootstrapOrigin)
      || !opaque(target.participantId) || !opaque(target.memberId) || !opaque(target.runId)
    ) return false
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
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
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (
      origin.bindingId !== bootstrapOrigin.binding.bindingId
      || origin.ownerGeneration !== bootstrapOrigin.binding.ownerGeneration
      || !sameOwner(this.options.ownerForSession(sessionId), owner)
    ) return undefined
    return this.captureAdmissionFromConversationOrigin(owner, origin, target, sessionId, agentGeneration, messageId)
  }

  /**
   * Shell v9/v6 adds the exact Room route to a fresh bootstrap target. The
   * route is checked against the registered same-owner declaration while the
   * command is still live; no pre-command Room snapshot is consulted.
   */
  bootstrapAdmissionRouteTargetActive(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
  ): boolean {
    if (
      this.disposed || !this.validBootstrapOrigin(bootstrapOrigin) || !this.validBootstrapRouteTarget(target)
      || this.options.bootstrapRouteRegistered?.(owner, target) !== true
    ) return false
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
    return candidates.length === 1
  }

  /** A v6 claim may follow old-binding disposal, but never command completion. */
  bootstrapAdmissionRouteClaimActive(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
  ): boolean {
    if (this.disposed || !this.validBootstrapOrigin(bootstrapOrigin) || !this.validBootstrapRouteTarget(target)) {
      return false
    }
    return [...this.commandOrigins].filter(origin =>
      sameOwner(origin.owner, owner)
      && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    ).length === 1
  }

  /**
   * Captures a v6 source under the opaque continuation before the driver sees
   * submission. Its close callback can still retire a committed pending claim
   * when owner, connection, or continuation lifecycle is fenced.
   */
  captureBootstrapAdmissionRouteTarget(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
    continuation: AgentAdmissionBootstrapRouteContinuation,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (
      !this.bootstrapAdmissionRouteTargetActive(owner, bootstrapOrigin, target)
      || !this.validBootstrapRouteContinuation(continuation)
      || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration) || agentGeneration < 1
    ) return undefined
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (
      origin.bindingId !== bootstrapOrigin.binding.bindingId
      || origin.ownerGeneration !== bootstrapOrigin.binding.ownerGeneration
      || !sameOwner(this.options.ownerForSession(sessionId), owner)
    ) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) {
      return undefined
    }
    const key = sourceKey(sessionId, messageId)
    if (this.sourceFor(key) !== undefined) return undefined
    const source: CapturedSourceRecord = {
      kind: 'conversation',
      key,
      origin,
      owner: Object.freeze({ ...owner }),
      sourceMessageId: messageId,
      sourceSessionId: sessionId,
      roomRunId: target.runId,
      permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(),
      active: true,
      committed: false,
      routeContinuation: {
        continuation,
        target: Object.freeze(structuredClone(target)),
        origin: Object.freeze(structuredClone(bootstrapOrigin)),
        state: 'captured',
      },
    }
    this.sources.set(key, source)
    let open = true
    let closed = false
    return Object.freeze({
      active: () =>
        open && !closed && this.sources.get(key) === source && source.active && !this.disposed
        && origin.active() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open || closed) return
        open = false
        if (this.sources.get(key) !== source || !source.active) return
        if (
          !origin.active() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()
        ) {
          this.retireSource(source, 'stale')
          return
        }
        source.committed = true
      },
      close: () => {
        if (closed) return
        closed = true
        open = false
        this.retireSource(source, 'completed')
      },
    })
  }

  protected captureAdmissionForTarget(
    owner: PluginOwnerIdentity,
    admissionOrigin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (
      this.disposed || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration)
      || agentGeneration < 1
    ) return undefined
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner)
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
      && origin.admissionOrigin.room.runId === admissionOrigin.room.runId
    )
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (
      origin.bindingId !== admissionOrigin.binding.bindingId
      || origin.ownerGeneration !== admissionOrigin.binding.ownerGeneration
      || origin.roomId !== admissionOrigin.room.roomId || !sameOwner(this.options.ownerForSession(sessionId), owner)
      || !origin.runs.some(run =>
        run.runId === target.runId && run.participantId === target.participantId && run.memberId === target.memberId
      )
    ) return undefined
    return this.captureAdmissionFromConversationOrigin(owner, origin, target, sessionId, agentGeneration, messageId)
  }

  protected captureAdmissionFromConversationOrigin(
    owner: PluginOwnerIdentity,
    origin: ConversationOriginRecord,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
    bootstrapRoomReceipt?: AgentAdmissionBootstrapRoomTargetReceipt,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (
      this.disposed || !opaque(sessionId) || !opaque(messageId) || !Number.isSafeInteger(agentGeneration)
      || agentGeneration < 1
    ) return undefined
    const permissionRoute = this.options.permissionRoute(owner, 'approvals.request')
    if (permissionRoute === undefined || !opaque(permissionRoute.routeId) || !opaque(permissionRoute.path)) {
      return undefined
    }
    const key = sourceKey(sessionId, messageId)
    if (this.sourceFor(key) !== undefined) return undefined
    const source: CapturedSourceRecord = {
      kind: 'conversation',
      key,
      origin,
      owner: Object.freeze({ ...owner }),
      sourceMessageId: messageId,
      sourceSessionId: sessionId,
      roomRunId: target.runId,
      permissionRoute: Object.freeze({ ...permissionRoute }),
      connectionGeneration: this.options.connectionGeneration(),
      active: true,
      committed: false,
      ...(bootstrapRoomReceipt === undefined
        ? {}
        : { bootstrapRoomReceipt: Object.freeze(structuredClone(bootstrapRoomReceipt)) }),
    }
    this.sources.set(key, source)
    let open = true
    return Object.freeze({
      active: () =>
        open && this.sources.get(key) === source && source.active && !this.disposed
        && origin.active() && source.connectionGeneration === this.options.connectionGeneration()
        && sameOwner(this.options.ownerForSession(sessionId), owner),
      commit: () => {
        if (!open) return
        open = false
        if (this.sources.get(key) !== source || !source.active) return
        if (
          !origin.active() || this.disposed || !sameOwner(this.options.ownerForSession(sessionId), owner)
          || source.connectionGeneration !== this.options.connectionGeneration()
        ) {
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

  protected sameAdmissionOrigin(left: AgentCommandOrigin | undefined, right: AgentCommandOrigin): boolean {
    return left !== undefined && left.originId === right.originId && left.executionId === right.executionId
      && left.binding.bindingId === right.binding.bindingId
      && left.binding.ownerGeneration === right.binding.ownerGeneration
      && left.generation === right.generation && left.commandId === right.commandId && left.scope === right.scope
      && left.room.roomId === right.room.roomId && left.room.participantId === right.room.participantId
      && left.room.memberId === right.room.memberId && left.room.runId === right.room.runId
  }

  protected validBootstrapOrigin(
    origin: AgentBootstrapCommandOrigin | undefined,
  ): origin is AgentBootstrapCommandOrigin {
    return origin !== undefined
      && origin.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json'
      && origin.contract === 'cordisx.agent-bootstrap-command-origin/v1' && origin.schemaVersion === 1
      && origin.scope === 'composer-submit' && opaque(origin.originId) && opaque(origin.executionId)
      && opaque(origin.binding.bindingId) && opaque(origin.binding.ownerGeneration)
      && opaque(origin.generation) && opaque(origin.commandId)
  }

  protected sameBootstrapOrigin(
    left: AgentBootstrapCommandOrigin | undefined,
    right: AgentBootstrapCommandOrigin,
  ): boolean {
    return left !== undefined && left.originId === right.originId && left.executionId === right.executionId
      && left.binding.bindingId === right.binding.bindingId
      && left.binding.ownerGeneration === right.binding.ownerGeneration
      && left.generation === right.generation && left.commandId === right.commandId && left.scope === right.scope
  }

  protected validBootstrapRoomTarget(
    target: AgentAdmissionBootstrapRoomTarget | undefined,
  ): target is AgentAdmissionBootstrapRoomTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId)
      && opaque(target.memberId) && opaque(target.runId)
  }

  protected sameBootstrapRoomTarget(
    left: AgentAdmissionBootstrapRoomTarget,
    right: AgentAdmissionBootstrapRoomTarget,
  ): boolean {
    return left.roomId === right.roomId && left.participantId === right.participantId
      && left.memberId === right.memberId && left.runId === right.runId
  }

  protected validBootstrapRoomReceipt(
    receipt: AgentAdmissionBootstrapRoomTargetReceipt | undefined,
    target: AgentAdmissionBootstrapRoomTarget,
  ): receipt is AgentAdmissionBootstrapRoomTargetReceipt {
    return receipt !== undefined
      && receipt.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-receipt.v5.schema.json'
      && receipt.contract === 'cordisx.agent-admission-bootstrap-room-target-receipt/v5'
      && receipt.schemaVersion === 5 && opaque(receipt.receiptId)
      && this.validBootstrapRoomTarget(receipt.target) && this.sameBootstrapRoomTarget(receipt.target, target)
  }

  protected validBootstrapRouteTarget(
    target: AgentAdmissionBootstrapRouteTarget | undefined,
  ): target is AgentAdmissionBootstrapRouteTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId) && opaque(target.memberId)
      && opaque(target.runId)
      && target.route !== undefined && opaque(target.route.routeId) && target.route.param === 'roomId'
      && opaque(target.route.roomId) && target.route.roomId === target.roomId
  }

  protected validBootstrapRouteContinuation(
    value: AgentAdmissionBootstrapRouteContinuation | undefined,
  ): value is AgentAdmissionBootstrapRouteContinuation {
    return value !== undefined
      && value.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json'
      && value.contract === 'cordisx.agent-admission-bootstrap-route-continuation/v6'
      && value.schemaVersion === 6 && opaque(value.token)
  }

  protected validPageOrigin(origin: AgentPageComposerOrigin | undefined): origin is AgentPageComposerOrigin {
    return origin !== undefined
      && origin.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json'
      && origin.contract === 'cordisx.agent-page-composer-origin/v1' && origin.schemaVersion === 1
      && opaque(origin.originId) && opaque(origin.binding.bindingId) && opaque(origin.binding.ownerGeneration)
      && opaque(origin.generation) && opaque(origin.executionId) && opaque(origin.commandId)
      && origin.scope === 'page-composer-submit' && opaque(origin.page.outlet)
      && opaque(origin.page.routeDefinitionId)
      && (origin.page.roomId === undefined || opaque(origin.page.roomId))
  }

  protected samePageOrigin(left: AgentPageComposerOrigin, right: AgentPageComposerOrigin): boolean {
    return left.originId === right.originId && left.binding.bindingId === right.binding.bindingId
      && left.binding.ownerGeneration === right.binding.ownerGeneration && left.generation === right.generation
      && left.executionId === right.executionId && left.commandId === right.commandId && left.scope === right.scope
      && left.page.outlet === right.page.outlet && left.page.routeDefinitionId === right.page.routeDefinitionId
      && left.page.roomId === right.page.roomId
  }

  protected validPageTarget(
    target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget | undefined,
  ): target is AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId)
      && opaque(target.memberId) && opaque(target.runId)
      && (!this.pageRouteTarget(target)
        || opaque(target.route.outlet) && opaque(target.route.routeDefinitionId) && target.route.param === 'roomId'
          && opaque(target.route.roomId) && target.route.roomId === target.roomId)
  }

  protected pageRouteTarget(
    target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget,
  ): target is AgentPageAdmissionRouteTarget {
    return 'route' in target
  }

  protected samePageTarget(
    left: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget,
    right: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget,
  ): boolean {
    if (
      left.roomId !== right.roomId || left.participantId !== right.participantId
      || left.memberId !== right.memberId || left.runId !== right.runId
      || this.pageRouteTarget(left) !== this.pageRouteTarget(right)
    ) return false
    return !this.pageRouteTarget(left) || !this.pageRouteTarget(right)
      || this.samePageRoute(left.route, right.route)
  }

  protected samePageRoute(
    left: AgentPageAdmissionRouteTarget['route'],
    right: AgentPageAdmissionRouteTarget['route'],
  ): boolean {
    return left.outlet === right.outlet && left.routeDefinitionId === right.routeDefinitionId
      && left.param === right.param && left.roomId === right.roomId
  }

  protected validPageClaimReceipt(
    receipt: AgentPageAdmissionRouteClaimReceipt | undefined,
  ): receipt is AgentPageAdmissionRouteClaimReceipt {
    return receipt !== undefined
      && receipt.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-claim-receipt.v1.schema.json'
      && receipt.contract === 'cordisx.agent-page-admission-route-claim-receipt/v1'
      && receipt.schemaVersion === 1 && opaque(receipt.receiptId)
      && opaque(receipt.owner.pluginId) && Number.isSafeInteger(receipt.owner.generation)
      && receipt.owner.generation >= 1
      && this.validPageOrigin(receipt.origin) && this.validPageTarget(receipt.target)
      && this.pageRouteTarget(receipt.target)
      && opaque(receipt.binding.binding.bindingId) && opaque(receipt.binding.binding.ownerGeneration)
      && opaque(receipt.binding.generation) && this.samePageRoute(receipt.target.route, receipt.binding.route)
      && opaque(receipt.source.sessionId) && opaque(receipt.source.messageId)
  }

  protected allSources(): readonly CapturedScenarioSource[] {
    return [...this.sources.values(), ...this.pageSources.values()]
  }

  protected sourceFor(key: string): CapturedScenarioSource | undefined {
    return this.sources.get(key) ?? this.pageSources.get(key)
  }

  protected sourceAwaitingRouteClaim(source: CapturedScenarioSource): boolean {
    return source.kind === 'conversation'
      ? source.routeContinuation?.state === 'pending-route-claim'
      : source.fresh && source.claimed === undefined
  }

  protected sourceLive(source: CapturedScenarioSource): boolean {
    if (!source.active || this.disposed || source.connectionGeneration !== this.options.connectionGeneration()) {
      return false
    }
    if (source.kind === 'page') {
      if (!sameOwner(this.options.ownerForSession(source.sourceSessionId), source.owner)) return false
      if (!source.fresh) return source.originActive()
      return source.claimed !== undefined && source.claimed.active()
    }
    const route = source.routeContinuation
    if (route?.state === 'pending-route-claim') return false
    if (route?.state === 'claimed') {
      return route.rebound !== undefined && route.rebound.active()
        && sameOwner(this.options.ownerForSession(source.sourceSessionId), source.owner)
    }
    return source.origin.active() && sameOwner(this.options.ownerForSession(source.sourceSessionId), source.owner)
  }

  protected abstract claimBootstrapRoute(input: PlaygroundScenarioBootstrapRouteActivation): void

  protected abstract executeConversation<Value>(
    origin: PlaygroundScenarioConversationOrigin,
    operation: () => Promise<Value>,
  ): Promise<Value>

  protected abstract fenceBinding(bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode): void

  protected abstract activate(
    input: Readonly<{
      runId: string
      sourceMessageId: string
      sourceSessionId: string
      targetSessionId: string
    }>,
  ): Promise<PlaygroundScenarioSessionScopeActivationResult>

  protected abstract release(input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>): void

  protected abstract retireSource(
    source: CapturedScenarioSource,
    code: PlaygroundScenarioSessionScopeClosedCode | 'stale',
  ): void

  protected abstract retire(record: ActivationRecord, code: PlaygroundScenarioSessionScopeClosedCode): void

  protected abstract unavailable(
    code: Extract<PlaygroundScenarioSessionScopeActivationResult, { readonly status: 'unavailable' }>['code'],
    message: string,
  ): PlaygroundScenarioSessionScopeActivationResult
}
