import { PlaygroundScenarioSessionScopeAuthorityBase } from './playground-scenario-session-scope-base.js'

import type { MessageId, PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
} from '@cordisx/protocol/agent-admission/v5'
import type { AgentAdmissionBootstrapRouteClaimRequest } from '@cordisx/protocol/agent-admission/v6'
import type { AgentRuntimeRouteScope } from '../platform.js'

import {
  ActivationRecord,
  CapturedScenarioSource,
  ConversationOriginRecord,
  opaque,
  PlaygroundScenarioBootstrapRouteActivation,
  PlaygroundScenarioConversationOrigin,
  PlaygroundScenarioSessionScopeActivationResult,
  PlaygroundScenarioSessionScopeClosedCode,
  PlaygroundScenarioSessionScopeHandle,
  PlaygroundScenarioSubmissionCapture,
  sameOwner,
  sourceKey,
} from './playground-scenario-session-scope-contract.js'

export class PlaygroundScenarioSessionScopeAuthority extends PlaygroundScenarioSessionScopeAuthorityBase {
  /**
   * V5 is a bootstrap declaration for a Room already mounted on this binding.
   * It intentionally cannot turn a fresh/no-Room command into a later route
   * transfer; that boundary belongs solely to v6.
   */
  bootstrapAdmissionRoomTargetActive(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRoomTarget,
  ): boolean {
    if (this.disposed || !this.validBootstrapOrigin(bootstrapOrigin) || !this.validBootstrapRoomTarget(target)) {
      return false
    }
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && origin.roomId === target.roomId
      && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
    return candidates.length === 1
  }

  captureBootstrapAdmissionRoomTarget(
    owner: PluginOwnerIdentity,
    bootstrapOrigin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRoomTarget,
    receipt: AgentAdmissionBootstrapRoomTargetReceipt,
    sessionId: string,
    agentGeneration: number,
    messageId: string,
  ): PlaygroundScenarioSubmissionCapture | undefined {
    if (
      !this.bootstrapAdmissionRoomTargetActive(owner, bootstrapOrigin, target)
      || !this.validBootstrapRoomReceipt(receipt, target)
    ) return undefined
    const candidates = [...this.commandOrigins].filter(origin =>
      origin.active()
      && sameOwner(origin.owner, owner) && origin.roomId === target.roomId
      && this.sameBootstrapOrigin(origin.bootstrapOrigin, bootstrapOrigin)
    )
    if (candidates.length !== 1) return undefined
    const origin = candidates[0]!
    if (
      origin.bindingId !== bootstrapOrigin.binding.bindingId
      || origin.ownerGeneration !== bootstrapOrigin.binding.ownerGeneration
      || !sameOwner(this.options.ownerForSession(sessionId), owner)
    ) return undefined
    return this.captureAdmissionFromConversationOrigin(
      owner,
      origin,
      target,
      sessionId,
      agentGeneration,
      messageId,
      receipt,
    )
  }

  /** Host-only, synchronous claim performed from the matching newly mounted Room route. */
  protected claimBootstrapRoute(input: PlaygroundScenarioBootstrapRouteActivation): void {
    if (
      this.disposed || !opaque(input.owner.pluginId) || !Number.isSafeInteger(input.owner.generation)
      || !opaque(input.binding.binding.bindingId) || !opaque(input.binding.binding.ownerGeneration)
      || !opaque(input.binding.generation) || !opaque(input.binding.route.routeId)
      || input.binding.route.param !== 'roomId' || !opaque(input.binding.route.roomId)
      || typeof input.active !== 'function' || !input.active()
    ) return
    const candidates = [...this.sources.values()].filter(source => {
      const route = source.routeContinuation
      return source.active && source.committed && route !== undefined && route.state === 'pending-route-claim'
        && this.commandOrigins.has(source.origin)
        && sameOwner(source.owner, input.owner)
        && route.target.roomId === input.binding.route.roomId
        && route.target.route.routeId === input.binding.route.routeId
        && route.target.route.param === input.binding.route.param
        && route.target.route.roomId === input.binding.route.roomId
    })
    if (candidates.length !== 1) {
      for (const source of candidates) this.retireSource(source, 'route-replaced')
      return
    }
    const source = candidates[0]!
    const route = source.routeContinuation!
    if (
      route.origin.binding.ownerGeneration !== input.binding.binding.ownerGeneration
      || route.origin.generation !== input.binding.generation
      || route.origin.binding.bindingId === input.binding.binding.bindingId
      || source.connectionGeneration !== this.options.connectionGeneration()
      || !sameOwner(this.options.ownerForSession(source.sourceSessionId), source.owner)
    ) {
      this.retireSource(source, 'route-replaced')
      return
    }
    const request: AgentAdmissionBootstrapRouteClaimRequest = {
      continuation: route.continuation,
      binding: input.binding,
      source: { sessionId: source.sourceSessionId, messageId: source.sourceMessageId as MessageId },
    }
    if (!this.bootstrapAdmissionRouteClaimActive(source.owner, route.origin, route.target)) {
      this.retireSource(source, 'route-replaced')
      return
    }
    const result = this.options.claimBootstrapRoute?.(source.owner, request)
    if (result?.status !== 'claimed') {
      this.retireSource(source, 'route-replaced')
      return
    }
    route.state = 'claimed'
    route.receipt = result.receipt
    route.rebound = Object.freeze({
      owner: Object.freeze({ ...input.owner }),
      binding: Object.freeze(structuredClone(input.binding)),
      active: input.active,
    })
  }

  reconcileVisibleRoute(): void {
    const source = this.current?.source
    if (
      source !== undefined
      && (!source.active || !this.sourceAwaitingRouteClaim(source) && !this.sourceLive(source))
    ) {
      this.retireSource(source, 'route-replaced')
    }
  }

  fenceSession(
    sessionId: string,
    code: Exclude<PlaygroundScenarioSessionScopeClosedCode, 'completed' | 'authorization-unavailable' | 'disposed'>,
  ): void {
    for (const source of this.allSources()) {
      if (source.active && source.sourceSessionId === sessionId) this.retireSource(source, code)
    }
    const current = this.current
    if (current?.active === true && current.targetSessionId === sessionId) this.retire(current, code)
  }

  closeRun(runId: string): void {
    const current = this.current
    if (current?.active === true && current.runId === runId) this.retire(current, 'completed')
    for (const source of this.allSources()) {
      if (source.scenarioRunId === runId) this.retireSource(source, 'completed')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.current
    if (current?.active === true) this.retire(current, 'disposed')
    for (const source of this.allSources()) this.retireSource(source, 'disposed')
    this.commandOrigins.clear()
  }

  protected async executeConversation<Value>(
    origin: PlaygroundScenarioConversationOrigin,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    if (this.disposed || !this.validOrigin(origin)) return await operation()
    const record: ConversationOriginRecord = Object.freeze({
      ...origin,
      runs: Object.freeze(origin.runs.map(run => Object.freeze({ ...run }))),
      token: Object.freeze({}),
    })
    this.commandOrigins.add(record)
    try {
      return await operation()
    } finally {
      this.commandOrigins.delete(record)
      // An unsubmitted reservation has no durable authority after command
      // completion. A v6 source must have already moved to its exact new Room
      // binding; pending continuations never survive a completed command.
      for (const source of [...this.sources.values()]) {
        if (
          source.origin === record && (!source.committed || source.routeContinuation?.state !== undefined
              && source.routeContinuation.state !== 'claimed')
        ) this.retireSource(source, 'completed')
      }
    }
  }

  protected validOrigin(origin: PlaygroundScenarioConversationOrigin): boolean {
    if (
      typeof origin.owner !== 'object' || origin.owner === null
      || !opaque(origin.owner.pluginId) || !Number.isSafeInteger(origin.owner.generation) || origin.owner.generation < 1
      || !opaque(origin.bindingId) || !opaque(origin.ownerGeneration)
      || !opaque(origin.snapshotGeneration) || !opaque(origin.routeId)
      || typeof origin.active !== 'function' || !origin.active()
      || !Array.isArray(origin.runs) || origin.runs.length > 64
    ) return false
    if (origin.bootstrapOrigin === undefined && (origin.runs.length === 0 || !opaque(origin.roomId))) return false
    if (
      origin.bootstrapOrigin !== undefined && (!this.validBootstrapOrigin(origin.bootstrapOrigin)
        || origin.roomId !== undefined && !opaque(origin.roomId)
        || origin.bootstrapOrigin.binding.bindingId !== origin.bindingId
        || origin.bootstrapOrigin.binding.ownerGeneration !== origin.ownerGeneration)
    ) return false
    const seen = new Set<string>()
    for (const run of origin.runs) {
      if (!opaque(run.runId) || !opaque(run.sessionId)) return false
      const key = `${run.runId}\u0000${run.sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  }

  protected fenceBinding(bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode): void {
    if (!opaque(bindingId)) return
    for (const source of [...this.sources.values()]) {
      const route = source.routeContinuation
      if (route?.state === 'claimed' && route.rebound?.binding.binding.bindingId === bindingId) {
        this.retireSource(source, code)
        continue
      }
      if (source.origin.bindingId !== bindingId) continue
      if (code === 'route-replaced' && source.committed && route !== undefined && route.state !== 'claimed') {
        route.state = 'pending-route-claim'
        continue
      }
      if (route?.state === 'claimed') continue
      this.retireSource(source, code)
    }
    for (const source of [...this.pageSources.values()]) {
      const claimed = source.claimed
      if (claimed?.receipt.binding.binding.bindingId === bindingId) {
        this.retireSource(source, code)
        continue
      }
      if (source.origin.binding.bindingId !== bindingId) continue
      // Only a committed fresh-page source may await its exact Host claim.
      if (code === 'route-replaced' && source.fresh && source.committed && claimed === undefined) continue
      this.retireSource(source, code)
    }
  }

  protected async activate(
    input: Readonly<{
      runId: string
      sourceMessageId: string
      sourceSessionId: string
      targetSessionId: string
    }>,
  ): Promise<PlaygroundScenarioSessionScopeActivationResult> {
    if (this.disposed) return this.unavailable('disposed', 'Playground scenario Session scope authority is disposed.')
    if (
      !opaque(input.runId) || !opaque(input.sourceMessageId) || !opaque(input.sourceSessionId)
      || !opaque(input.targetSessionId)
    ) {
      return this.unavailable('invalid-request', 'Playground scenario Session scope request is invalid.')
    }
    if (input.sourceSessionId === input.targetSessionId) {
      return this.unavailable(
        'invalid-request',
        'Playground scenario Session scope requires a delegated target Session.',
      )
    }
    const prior = this.current
    if (prior?.active === true) {
      if (
        prior.runId === input.runId && prior.sourceSessionId === input.sourceSessionId
        && prior.targetSessionId === input.targetSessionId
      ) return Object.freeze({ status: 'available', handle: prior.handle })
      return this.unavailable('activation-conflict', 'Another Playground scenario Session scope is already active.')
    }
    const source = this.sourceFor(sourceKey(input.sourceSessionId, input.sourceMessageId))
    if (source === undefined) {
      return this.unavailable(
        'source-route-unavailable',
        'The scenario source Session has no captured exact Room authority.',
      )
    }
    if (!source.committed || !this.sourceLive(source)) {
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
    if (owner === undefined) {
      return this.unavailable('session-unavailable', 'The delegated scenario Session is unavailable.')
    }
    if (!sameOwner(owner, sourceOwner)) {
      return this.unavailable(
        'owner-mismatch',
        'The delegated scenario Session has a different plugin owner or generation.',
      )
    }
    const routeOwner = this.options.routeOwner(owner)
    if (routeOwner === undefined) {
      return this.unavailable('owner-mismatch', 'The delegated scenario Session owner is invalid.')
    }
    const routeInstanceId = `playground-scenario:${this.options.hostGeneration}:${input.runId}`
    if (!opaque(routeInstanceId)) {
      return this.unavailable('invalid-request', 'The scenario route activation identity is invalid.')
    }
    const route: AgentRuntimeRouteScope = Object.freeze({
      kind: 'host-route',
      active: true,
      owner: Object.freeze({ ...routeOwner }),
      routeId: routeDefinition.routeId,
      routeInstanceId,
      path: routeDefinition.path,
      params: Object.freeze({ sessionId: input.targetSessionId }),
    })
    let disposeRoute: () => void
    try {
      disposeRoute = this.options.mountRoute(route)
    } catch {
      return this.unavailable('route-unavailable', 'The exact delegated Session route could not be activated.')
    }
    let settle!: ActivationRecord['settle']
    const closed = new Promise<Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>>(resolve => {
      settle = resolve
    })
    let record!: ActivationRecord
    const handle: PlaygroundScenarioSessionScopeHandle = Object.freeze({
      runId: input.runId,
      sessionId: input.targetSessionId,
      routeInstanceId,
      closed,
      active: () =>
        record.active && this.current === record && !this.disposed
        && (record.source === undefined || this.sourceLive(record.source)),
      close: () => {
        if (record.active && this.current === record) this.retire(record, 'completed')
      },
    })
    record = {
      runId: input.runId,
      source,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      route,
      handle,
      disposeRoute,
      settle,
      active: true,
    }
    this.current = record
    this.options.changed(true)
    let authorized = false
    try {
      authorized = await this.options.authorize(owner, 'approvals.request', input.targetSessionId)
    } catch {
      authorized = false
    }
    if (!record.active || this.current !== record || this.disposed || !this.sourceLive(source)) {
      if (record.active) this.retire(record, 'route-replaced')
      return this.unavailable('stale', 'The scenario Session scope was fenced before authorization completed.')
    }
    if (!authorized) {
      this.retire(record, 'authorization-unavailable')
      return this.unavailable('authorization-unavailable', 'The exact delegated Session approval scope is unavailable.')
    }
    return Object.freeze({ status: 'available', handle })
  }

  protected release(input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>): void {
    if (!opaque(input.sourceMessageId) || !opaque(input.sourceSessionId) || !opaque(input.runId)) return
    const source = this.sourceFor(sourceKey(input.sourceSessionId, input.sourceMessageId))
    if (source === undefined || source.scenarioRunId !== undefined && source.scenarioRunId !== input.runId) return
    if (this.current?.source === source && this.current.active) this.retire(this.current, 'completed')
    this.retireSource(source, 'completed')
  }

  protected retireSource(
    source: CapturedScenarioSource,
    code: PlaygroundScenarioSessionScopeClosedCode | 'stale',
  ): void {
    if (!source.active) return
    source.active = false
    if (source.kind === 'conversation') {
      if (this.sources.get(source.key) === source) this.sources.delete(source.key)
    } else if (this.pageSources.get(source.key) === source) {
      this.pageSources.delete(source.key)
    }
    const current = this.current
    if (current?.source === source && current.active) this.retire(current, code === 'stale' ? 'route-replaced' : code)
  }

  protected retire(record: ActivationRecord, code: PlaygroundScenarioSessionScopeClosedCode): void {
    if (!record.active) return
    record.active = false
    if (this.current === record) delete this.current
    try {
      record.disposeRoute()
    } catch {
      /* first-terminal cleanup continues even if a downstream observer fails */
    } finally {
      record.settle(Object.freeze({ code }))
      this.options.changed(false)
    }
  }

  protected unavailable(
    code: Extract<PlaygroundScenarioSessionScopeActivationResult, { readonly status: 'unavailable' }>['code'],
    message: string,
  ): PlaygroundScenarioSessionScopeActivationResult {
    return Object.freeze({ status: 'unavailable', code, message })
  }
}
