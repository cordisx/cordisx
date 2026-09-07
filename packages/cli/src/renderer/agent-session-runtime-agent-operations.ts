import type { AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentAcquireResult,
  AgentAdmission,
  AgentCancelOptions,
  AgentCreateOptions,
  AgentDefinitionIdentity,
  AgentDetailReference,
  AgentDisposeOptions,
  AgentHandle,
  AgentIdleResult,
  AgentLiveEvent,
  AgentLiveEventObserver,
  AgentLiveSubscribeResult,
  AgentMessageDiscardResult,
  AgentMutationResult,
  AgentOptions,
  AgentRegistry,
  AgentResumeOptions,
  AgentRuntimeCapability,
  AgentSetup,
  AgentStatus,
  AgentStatusObservation,
} from '@cordisx/protocol/agents/v1'
import type {
  ApprovalAnswerer as ApprovalAnswererV1,
  ApprovalAnswererHandle as ApprovalAnswererHandleV1,
  ApprovalDecision as ApprovalDecisionV1,
  ApprovalQuestion as ApprovalQuestionV1,
  ApprovalService as ApprovalServiceV1,
} from '@cordisx/protocol/approval/v1'
import type {
  ApprovalAgentBinding,
  ApprovalAgentTarget,
  ApprovalAnswerer as ApprovalAnswererV2,
  ApprovalAuthorityAnswererHandle,
  ApprovalDecision as ApprovalDecisionV2,
  ApprovalQuestion as ApprovalQuestionV2,
  ApprovalRequest as ApprovalRequestV2,
  ApprovalService as ApprovalServiceV2,
} from '@cordisx/protocol/approval/v2'
import type {
  ApprovalRequestResolver,
  ApprovalRequestResolverClosed,
  ApprovalRequestResolverHandle,
  ApprovalRequestResolverRegisterResult,
  ApprovalRequestRoutingQuestion,
  ApprovalRequestRoutingRegistration,
  ApprovalRequestRoutingResult,
  ApprovalService as ApprovalServiceV3,
} from '@cordisx/protocol/approval/v3'
import type {
  AgentCancelCause,
  ApprovalOutcome,
  MessageId,
  PluginOwnerIdentity,
  Session,
  SessionEvent,
  SessionEventDataMap,
  SessionEventObserver,
  SessionHeader,
  SessionId,
  SessionReadRequest,
  SessionRegistry,
  SessionSnapshotResult,
  SessionSubscribeRequest,
  SessionSubscribeResult,
  SessionSubscription,
  SessionSubscriptionCloseCode,
  SessionSubscriptionClosed,
  UserMessage,
} from '@cordisx/protocol/sessions/v1'
import type {
  EntityAgentAcquireResult,
  EntityAgentCreateOptions,
  EntityAgentResumeOptions,
  EntityBackedAgentRegistry,
  EntityDefinitionResolution,
  EntityRegistry,
  EntitySessionDefinitionBinding,
} from '@cordisx/protocol/entities/v1'
import type {
  AgentAdmissionReservationRequest,
  AgentAdmissionReservationResult,
  AgentAdmissionReservationService,
  AgentCommandOrigin,
} from '@cordisx/protocol/agent-admission/v2'
import type {
  AgentAdmissionTarget,
  AgentAdmissionTargetOrigin,
  AgentAdmissionTargetOriginRequest,
  AgentAdmissionTargetOriginResult,
  AgentAdmissionTargetOriginService,
  AgentAdmissionTargetReservationRequest,
  AgentAdmissionTargetReservationResult,
  AgentAdmissionTargetReservationService,
} from '@cordisx/protocol/agent-admission/v3'
import type {
  AgentAdmissionBootstrapReservationRequest,
  AgentAdmissionBootstrapReservationResult,
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetOrigin,
  AgentAdmissionBootstrapTargetRequest,
  AgentAdmissionBootstrapTargetResult,
  AgentAdmissionBootstrapTargetService,
  AgentBootstrapCommandOrigin,
} from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentAdmissionBootstrapRoomReservationRequest,
  AgentAdmissionBootstrapRoomReservationResult,
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetOrigin,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetRequest,
  AgentAdmissionBootstrapRoomTargetResult,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5'
import type {
  AgentAdmissionBootstrapRouteClaimReceipt,
  AgentAdmissionBootstrapRouteClaimRequest,
  AgentAdmissionBootstrapRouteClaimResult,
  AgentAdmissionBootstrapRouteContinuation,
  AgentAdmissionBootstrapRouteDeclarationRequest,
  AgentAdmissionBootstrapRouteDeclarationResult,
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationRequest,
  AgentAdmissionBootstrapRouteReservationResult,
  AgentAdmissionBootstrapRouteReservationService,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6'
import type {
  AgentPageAdmissionReservationRequest,
  AgentPageAdmissionReservationResult,
  AgentPageAdmissionReservationService,
  AgentPageAdmissionRouteClaimReceipt,
  AgentPageAdmissionRouteClaimResult,
  AgentPageAdmissionRouteContinuation,
  AgentPageAdmissionRouteDeclarationRequest,
  AgentPageAdmissionRouteDeclarationResult,
  AgentPageAdmissionRouteDeclarationService,
  AgentPageAdmissionRouteReservationRequest,
  AgentPageAdmissionRouteReservationResult,
  AgentPageAdmissionRouteReservationService,
  AgentPageAdmissionRouteTarget,
  AgentPageAdmissionTarget,
  AgentPageAdmissionTargetOrigin,
  AgentPageAdmissionTargetReceipt,
  AgentPageAdmissionTargetRequest,
  AgentPageAdmissionTargetResult,
  AgentPageAdmissionTargetService,
  AgentPageComposerCommandContext,
  AgentPageComposerCommandResult,
  AgentPageComposerOrigin,
  AgentPageFreshRoomNavigation,
  AgentPageFreshRoomNavigationRequest,
  AgentPageFreshRoomNavigationResult,
  AgentPageFreshRoomNavigationService,
  AgentPageRoomRoute,
} from '@cordisx/protocol/agent-page-admission/v2'
import type {
  AgentDetailNavigationRequest,
  AgentDetailNavigationResult,
  AgentDetailNavigationService,
  AgentSessionDetailReferenceRequest,
  AgentSessionDetailReferenceResult,
  AgentSessionDetailReferenceService,
} from '@cordisx/protocol/agent-detail-navigation/v1'
import type { PluginApprovalAuthorityLeaseV8 } from '@cordisx/protocol/plugin-manifest/v8'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { generationFromContext } from './ownership.js'
import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireRequestV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
} from '../agent-session-migration-contracts.js'
import { type CordisXResolvedAgentDefinition, resolveAgentDefinitionCatalog } from './agent-loop.js'
import { type CordisXAgentDefinitionPresentation, presentationForDefinition } from './agent-loop-v4.js'
import type { PlaygroundScenarioSubmissionCapture } from './playground-scenario-session-scope.js'
import {
  type PageAdmissionBinding,
  PageAdmissionBindingRegistry,
  type PageAdmissionCommand,
  type PageAdmissionCommandCompletion,
  type PageAdmissionDestinationRoute as HostPageAdmissionDestinationRoute,
  type PageAdmissionRoute as HostPageAdmissionRoute,
  type PageAdmissionSourceCapture,
  type PageAdmissionTarget as HostPageAdmissionTarget,
} from './page-admission-lifecycle.js'
import { AgentSessionRuntimePageAdmission } from './agent-session-runtime-page-admission.js'
import {
  ACQUIRE_SCHEMA,
  ADMISSION_SCHEMA,
  AgentRecord,
  AgentSubscriber,
  clone,
  CordisXPrivateAgentDriver,
  DISCARD_SCHEMA,
  MUTATION_SCHEMA,
  ownerKey,
  PAGE_SCHEMA,
  SessionRecord,
  SessionSubscriber,
  SNAPSHOT_SCHEMA,
  SUBSCRIPTION_SCHEMA,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimeOperations extends AgentSessionRuntimePageAdmission {
  protected async acquire(
    owner: PluginOwnerIdentity,
    operation: 'create' | 'resume',
    sessionId: string,
    input: AgentCreateOptions | AgentResumeOptions,
    source: 'host' | 'caller',
    resolvedLegacy = false,
    entityBinding?: EntitySessionDefinitionBinding,
    executionContext?: AgentTaskResolvedContext,
  ): Promise<AgentAcquireResult> {
    if (this.disposed) return this.acquireUnavailable(operation, input.mutationId, 'runtime-unavailable')
    const mutationId = input.mutationId
    const mutationKey = mutationId === undefined ? undefined : `${ownerKey(owner)}\u0000${operation}\u0000${mutationId}`
    const fingerprint = JSON.stringify(clone(input))
    const prior = mutationKey === undefined ? undefined : this.mutations.get(mutationKey)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return this.acquireConflict(operation, mutationId, 'mutation-conflict')
      if (prior.result.status === 'accepted') {
        const record = this.handleCapabilities.get(prior.result.handle as object)
        if (record === undefined || !this.current(record)) {
          return this.acquireUnavailable(operation, mutationId, 'host-unavailable')
        }
        return { ...prior.result, disposition: 'replayed' }
      }
      return clone(prior.result)
    }
    if (operation === 'create' && this.sessions.has(sessionId)) {
      return this.remember(
        mutationKey,
        fingerprint,
        this.acquireConflict(operation, mutationId, 'session-already-exists'),
      )
    }
    const live = this.agents.get(sessionId)
    if (live !== undefined && live.disposed === undefined) {
      return this.remember(mutationKey, fingerprint, this.acquireConflict(operation, mutationId, 'agent-already-live'))
    }
    const existing = this.sessions.get(sessionId)
    const recovering = operation === 'resume' && existing === undefined && !resolvedLegacy
      && input.setup !== undefined && this.options.driver.recover !== undefined
    if (operation === 'resume' && existing === undefined && !resolvedLegacy && !recovering) {
      return this.remember(
        mutationKey,
        fingerprint,
        this.acquireUnavailable(operation, mutationId, 'session-unavailable'),
      )
    }
    let definitions: readonly CordisXResolvedAgentDefinition[] | undefined
    const effectiveSetup = input.setup ?? existing?.setup
    if (input.setup !== undefined) {
      try {
        definitions = resolveAgentDefinitionCatalog(input.setup).definitions
      } catch {
        return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'unsupported'))
      }
    }
    const driver = recovering && input.setup !== undefined && this.options.driver.recover !== undefined
      ? await this.options.driver.recover({
        sessionId,
        owner: clone(owner),
        options: input.options ?? {},
        setup: clone(input.setup),
      })
      : operation === 'create'
      ? await this.options.driver.create({
        ...(executionContext === undefined ? {} : { executionContext }),
        sessionId,
        owner: clone(owner),
        options: input.options ?? {},
        ...(effectiveSetup === undefined ? {} : { setup: clone(effectiveSetup) }),
      })
      : await this.options.driver.resume({
        sessionId,
        owner: clone(owner),
        options: input.options ?? {},
        ...(effectiveSetup === undefined ? {} : { setup: clone(effectiveSetup) }),
      })
    if (driver.status !== 'accepted') {
      return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, driver.code))
    }
    const session = existing ?? await this.newSession(sessionId, input.setup, definitions, entityBinding, recovering)
    if (session === undefined) {
      return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'host-unavailable'))
    }
    if (
      existing !== undefined && input.setup !== undefined && definitions !== undefined
      && !await this.updateSessionSetup(session, input.setup, definitions)
    ) {
      return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'host-unavailable'))
    }
    const setup = input.setup ?? session.setup
    const resolvedDefinitions = definitions ?? session.definitions
    const record: AgentRecord = {
      id: sessionId,
      generation: ++this.nextAgentGeneration,
      owner: clone(owner),
      session,
      options: clone(input.options ?? {}),
      pending: new Map(),
      claimed: new Set(),
      live: new Set(),
      status: 'idle',
      idleWaiters: new Set(),
      approvalControllers: new Set(),
      ...(setup === undefined ? {} : { definition: clone(setup.definition) }),
      ...(resolvedDefinitions === undefined ? {} : { definitions: clone(resolvedDefinitions) }),
      ...(driver.detail === undefined ? {} : { detail: clone(driver.detail) }),
    }
    this.agents.set(sessionId, record)
    this.emitLive(record, 'agent/created', {})
    this.emitLive(record, 'agent/session-start', { source: operation === 'create' ? 'startup' : 'resume' })
    const handle = this.handle(owner, record)
    const accepted = {
      $schema: ACQUIRE_SCHEMA,
      contract: 'cordisx.agent-acquire-result/v1' as const,
      schemaVersion: 1 as const,
      operation,
      ...(mutationId === undefined ? {} : { mutationId }),
      status: 'accepted' as const,
      sessionId,
      agentGeneration: record.generation,
      sessionGeneration: session.generation,
      owner: clone(owner),
      sessionIdSource: source,
      disposition: operation === 'create' ? 'created' as const : 'resumed' as const,
      handle,
    }
    return this.remember(mutationKey, fingerprint, accepted)
  }

  protected agent(owner: PluginOwnerIdentity, record: AgentRecord): Agent {
    const session = this.sessionHandle(owner, record.session)
    const admission = async (message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean) =>
      await this.submitAdmission(owner, record, message, target, wakeup)
    const agent = Object.freeze({
      id: record.id,
      generation: record.generation,
      options: clone(record.options),
      session,
      inbox: Object.freeze({
        nextTurn: [...record.pending.values()].filter(item => item.target === 'next-turn').map(item =>
          clone(item.message)
        ),
        nextStep: [...record.pending.values()].filter(item => item.target === 'next-step').map(item =>
          clone(item.message)
        ),
      }),
      status: this.current(record)
        ? ({ status: 'available', value: record.status } satisfies AgentStatusObservation)
        : { status: 'unavailable', code: 'agent-replaced' },
      ...(record.detail === undefined ? {} : { detail: clone(record.detail) }),
      send: admission,
      followup: async (message: UserMessage) => await admission(message, 'next-turn', true),
      steer: async (message: UserMessage) => await admission(message, 'next-step', true),
      inject: async (message: UserMessage) => await admission(message, 'next-step', false),
      discard: async (messageId: MessageId): Promise<AgentMessageDiscardResult> => {
        if (!this.current(record)) return this.discard(messageId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.message.cancel', record.id)) {
          return this.discard(messageId, 'denied', 'permission-denied')
        }
        const driver = await this.options.driver.discard({ sessionId: record.id, messageId })
        if (driver === 'already-claimed' || record.claimed.has(messageId)) {
          return this.discard(messageId, 'conflict', 'already-claimed')
        }
        const pending = record.pending.get(messageId)
        if (driver === 'not-found' || pending === undefined) return this.discard(messageId, 'not-found')
        if (driver === 'unavailable') return this.discard(messageId, 'unavailable', 'host-unavailable')
        record.pending.delete(messageId)
        if (
          !await this.append(record.session, 'agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [],
            outcome: 'canceled',
          })
        ) {
          return this.discard(messageId, 'unavailable', 'host-unavailable')
        }
        this.emitLive(record, 'agent/inbox/discarded', { message: pending.message })
        return this.discard(messageId, 'accepted')
      },
      cancel: async (cause: AgentCancelCause, options?: AgentCancelOptions): Promise<AgentMutationResult<'cancel'>> => {
        if (!this.current(record)) return this.mutation('cancel', options?.mutationId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.cancel', record.id)) {
          return this.mutation('cancel', options?.mutationId, 'denied', 'permission-denied')
        }
        const result = await this.options.driver.cancel({
          sessionId: record.id,
          cause,
          keepInbox: options?.keepInbox === true,
        })
        if (result !== 'accepted') return this.mutation('cancel', options?.mutationId, 'unavailable', 'unsupported')
        if (options?.keepInbox !== true) {
          for (const pending of record.pending.values()) {
            if (
              !await this.append(record.session, 'agent/inbox/spliced', {
                target: pending.target,
                start: 0,
                removedCount: 1,
                inserted: [],
                outcome: 'canceled',
              })
            ) {
              return this.mutation('cancel', options?.mutationId, 'unavailable', 'host-unavailable')
            }
            this.emitLive(record, 'agent/inbox/discarded', { message: pending.message })
          }
          record.pending.clear()
        }
        return this.mutation('cancel', options?.mutationId, 'accepted')
      },
      whenIdle: async (): Promise<AgentIdleResult> => {
        if (!this.current(record)) return { status: 'unavailable', code: 'agent-replaced' }
        if (record.status === 'idle') return { status: 'idle' }
        return await new Promise(resolve => record.idleWaiters.add(resolve))
      },
      subscribe: async (observer: AgentLiveEventObserver): Promise<AgentLiveSubscribeResult> => {
        if (!this.current(record)) return { status: 'unavailable', code: 'agent-replaced' }
        if (!await this.allowed(owner, 'agents.live.subscribe', record.id)) {
          return { status: 'denied', code: 'permission-denied' }
        }
        const subscriber: AgentSubscriber = { owner: clone(owner), observer }
        record.live.add(subscriber)
        const subscription = Object.freeze({
          agentId: record.id,
          agentGeneration: record.generation,
          unsubscribe: async () => {
            subscriber.closed = 'unsubscribed'
            record.live.delete(subscriber)
            return { status: 'closed' as const, code: 'unsubscribed' as const }
          },
        })
        return { status: 'subscribed', subscription } as AgentLiveSubscribeResult
      },
    })
    const branded = agent as unknown as Agent
    this.agentCapabilities.set(branded, record)
    return branded
  }

  protected async submitAdmission(
    owner: PluginOwnerIdentity,
    record: AgentRecord,
    message: UserMessage,
    target: 'next-turn' | 'next-step',
    wakeup: boolean,
    captured?: PlaygroundScenarioSubmissionCapture,
  ): Promise<Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never> {
    if (captured !== undefined && !captured.active()) {
      captured.close()
      return this.admission(message.id, 'unavailable', 'agent-replaced')
    }
    if (!this.current(record)) {
      captured?.close()
      return this.admission(message.id, 'unavailable', 'agent-replaced')
    }
    if (!this.sameSource(owner, message.source)) {
      captured?.close()
      return this.admission(message.id, 'denied', 'source-denied')
    }
    if (!await this.allowed(owner, 'agents.message.submit', record.id)) {
      captured?.close()
      return this.admission(message.id, 'denied', 'permission-denied')
    }
    const prior = record.pending.get(message.id)
    if (prior !== undefined) {
      captured?.close()
      return this.admission(message.id, 'accepted')
    }
    const sourceCapture = captured ?? this.options.captureSubmission?.(owner, record.id, message.id)
    let submitted: Awaited<ReturnType<CordisXPrivateAgentDriver['submit']>>
    try {
      submitted = await this.options.driver.submit({ sessionId: record.id, message: clone(message), target, wakeup })
    } catch (error) {
      sourceCapture?.close()
      throw error
    }
    if (submitted === 'replayed') {
      sourceCapture?.close()
      return this.admission(message.id, 'accepted')
    }
    if (submitted !== 'accepted') {
      sourceCapture?.close()
      return this.admission(message.id, 'unavailable', 'host-unavailable')
    }
    sourceCapture?.commit()
    const stored = clone(message)
    record.pending.set(stored.id, { message: stored, target })
    const appended = await this.appendMany(record.session, [
      {
        type: 'agent/inbox/spliced',
        data: { target, start: target === 'next-turn' ? record.pending.size - 1 : 0, inserted: [stored] },
      },
      { type: 'user/message', data: stored },
    ])
    if (!appended) {
      record.pending.delete(stored.id)
      return this.admission(message.id, 'unavailable', 'host-unavailable')
    }
    this.emitLive(record, 'agent/inbox/inserted', { message: stored })
    return this.admission(stored.id, 'accepted')
  }

  protected sessionHandle(owner: PluginOwnerIdentity, record: SessionRecord): Session {
    const session = Object.freeze({
      id: record.id,
      generation: record.generation,
      header: clone(record.header),
      snapshot: async (): Promise<SessionSnapshotResult> => {
        await record.appendQueue
        if (!this.sessionLive(record)) {
          return {
            status: 'unavailable',
            code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable',
          }
        }
        if (!await this.allowed(owner, 'sessions.read', record.id)) {
          return { status: 'unavailable', code: 'permission-revoked' }
        }
        return {
          status: 'available',
          snapshot: {
            $schema: SNAPSHOT_SCHEMA,
            contract: 'cordisx.session-snapshot/v1',
            schemaVersion: 1,
            sessionId: record.id,
            sessionGeneration: record.generation,
            header: clone(record.header),
            snapshotSeq: record.events.length - 1,
          },
        }
      },
      read: async (request: SessionReadRequest = {}) => {
        await record.appendQueue
        if (!this.sessionLive(record)) {
          return {
            status: 'unavailable' as const,
            code: record.closed === 'connection-replaced' ? 'session-replaced' as const : 'host-unavailable' as const,
          }
        }
        if (!await this.allowed(owner, 'sessions.read', record.id)) {
          return { status: 'unavailable' as const, code: 'permission-revoked' as const }
        }
        const afterSeq = request.afterSeq ?? -1
        const snapshotSeq = request.snapshotSeq ?? record.events.length - 1
        const limit = request.limit ?? 100
        if (
          !Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < -1
          || snapshotSeq > record.events.length - 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
        ) {
          return { status: 'unavailable' as const, code: 'unsupported' as const }
        }
        const events = record.events.filter(event => event.seq > afterSeq && event.seq <= snapshotSeq).slice(0, limit)
          .map(clone)
        const nextAfterSeq = events.at(-1)?.seq ?? afterSeq
        return {
          status: 'available' as const,
          page: {
            $schema: PAGE_SCHEMA,
            contract: 'cordisx.session-event-page/v1',
            schemaVersion: 1,
            sessionId: record.id,
            sessionGeneration: record.generation,
            afterSeq,
            snapshotSeq,
            events,
            nextAfterSeq,
            hasMore: record.events.some(event => event.seq > nextAfterSeq && event.seq <= snapshotSeq),
          },
        }
      },
      subscribe: async (
        request: SessionSubscribeRequest,
        observer: SessionEventObserver,
      ): Promise<SessionSubscribeResult> => {
        await record.appendQueue
        if (!this.sessionLive(record)) {
          return {
            status: 'unavailable',
            code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable',
          }
        }
        if (!await this.allowed(owner, 'sessions.subscribe', record.id)) {
          return { status: 'unavailable', code: 'permission-revoked' }
        }
        const afterSeq = request.afterSeq ?? -1
        if (
          !Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(request.pageSize ?? 100)
          || (request.pageSize ?? 100) < 1 || (request.pageSize ?? 100) > 500
        ) return { status: 'unavailable', code: 'unsupported' }
        // Register before capturing the watermark. Any later append is live,
        // while the pre-commit range is emitted once as replay.
        let resolveClosed: (value: SessionSubscriptionClosed) => void = () => {}
        const closed = new Promise<SessionSubscriptionClosed>(resolve => {
          resolveClosed = resolve
        })
        const subscriber: SessionSubscriber = {
          generation: ++this.nextSubscriptionGeneration,
          replayThrough: record.events.length - 1,
          owner: clone(owner),
          observer,
          lastSeq: afterSeq,
          resolveClosed,
          delivery: Promise.resolve(),
        }
        record.subscribers.add(subscriber)
        const replayThrough = subscriber.replayThrough
        const replay = record.events.filter(event => event.seq > afterSeq && event.seq <= replayThrough).map(clone)
        subscriber.lastSeq = replayThrough
        if (replay.length > 0) {
          await this.deliver(subscriber, {
            $schema: SUBSCRIPTION_SCHEMA,
            contract: 'cordisx.session-subscription-page/v1',
            schemaVersion: 1,
            sessionId: record.id,
            sessionGeneration: record.generation,
            subscriptionGeneration: subscriber.generation,
            replayThrough,
            phase: 'replay',
            events: replay,
          })
        }
        const subscription = Object.freeze({
          sessionId: record.id,
          sessionGeneration: record.generation,
          subscriptionGeneration: subscriber.generation,
          replayThrough,
          closed,
          unsubscribe: async () => this.closeSubscriber(record, subscriber, 'unsubscribed'),
        })
        return { status: 'subscribed', subscription } as SessionSubscribeResult
      },
    })
    return session as Session
  }
  protected abstract acquireUnavailable(
    operation: 'create' | 'resume',
    mutationId: string | undefined,
    code: 'runtime-unavailable' | 'host-unavailable' | 'unsupported' | 'session-unavailable',
  ): AgentAcquireResult

  protected abstract acquireConflict(
    operation: 'create' | 'resume',
    mutationId: string | undefined,
    code: 'mutation-conflict' | 'session-already-exists' | 'agent-already-live',
  ): AgentAcquireResult

  protected abstract current(record: AgentRecord): boolean

  protected abstract remember(
    key: string | undefined,
    fingerprint: string,
    result: AgentAcquireResult,
  ): AgentAcquireResult

  protected abstract newSession(
    id: string,
    setup: AgentSetup | undefined,
    definitions: readonly CordisXResolvedAgentDefinition[] | undefined,
    entityBinding?: EntitySessionDefinitionBinding,
    isSeeded?: boolean,
  ): Promise<SessionRecord | undefined>

  protected abstract updateSessionSetup(
    session: SessionRecord,
    setup: AgentSetup,
    definitions: readonly CordisXResolvedAgentDefinition[],
  ): Promise<boolean>

  protected abstract handle(owner: PluginOwnerIdentity, record: AgentRecord): AgentHandle

  protected abstract discard(
    messageId: string,
    status: AgentMessageDiscardResult['status'],
    code?: string,
  ): AgentMessageDiscardResult

  protected abstract allowed(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean>

  protected abstract mutation(
    operation: 'cancel' | 'dispose',
    mutationId: string | undefined,
    status: 'accepted' | 'denied' | 'unavailable',
    code?: string,
  ): AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'>

  protected abstract admission(
    messageId: string,
    status: 'accepted' | 'denied' | 'unavailable',
    code?: 'source-denied' | 'permission-denied' | 'agent-replaced' | 'host-unavailable',
  ): Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never

  protected abstract sameSource(owner: PluginOwnerIdentity, source: UserMessage['source']): boolean

  protected abstract sessionLive(record: SessionRecord): boolean

  protected abstract deliver(subscriber: SessionSubscriber, page: Parameters<SessionEventObserver>[0]): Promise<void>

  protected abstract closeSubscriber(
    record: SessionRecord,
    subscriber: SessionSubscriber,
    code: SessionSubscriptionCloseCode,
  ): SessionSubscriptionClosed
}
