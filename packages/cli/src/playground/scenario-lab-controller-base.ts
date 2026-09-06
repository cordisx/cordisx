import type {
  AgentDefinition,
  AgentLoopCommandV4,
  AgentLoopTaskBindingV4,
  BoundAgentLoopClientV4,
} from '../agent-loop-contracts.js'
import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v3'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { SessionEvent } from '@cordisx/protocol/sessions/v1'
import { CORDISX_AGENT_DEFINITION_SCHEMA_V1, CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4 } from '../agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV4 } from '../renderer/agent-loop-v4.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
  type PlaygroundMockTaskTrace,
} from '../renderer/playground-mock-agent-loop.js'
import {
  type AgentConversationApproval,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
  createAgentConversationModel,
} from '../renderer/host-ui/conversation/model.js'
import type {
  PlaygroundRoomSimulationBinding,
  PlaygroundRoomSimulationDelegationTarget,
  PlaygroundRoomSimulationEvent,
  PlaygroundRoomSimulationForwardingClient,
  PlaygroundRoomSimulationOperationReceipt,
  PlaygroundRoomSimulationResult,
  PlaygroundRoomSimulationSnapshot,
} from '../renderer/playground-room-simulation-bridge.js'

import {
  agent,
  aliases,
  approvalCommand,
  createCommand,
  createPlaygroundScenarioLabRuntime,
  eventCorrelations,
  inherit,
  labelFor,
  type Listener,
  nextScenarioOperationOrdinal,
  observeScenarioRoomOperationId,
  originalTrace,
  PLAYGROUND_SCENARIO_CATALOG,
  type PlaygroundEventInjectorSnapshot,
  type PlaygroundScenarioActivity,
  type PlaygroundScenarioCatalogEntry,
  type PlaygroundScenarioId,
  type PlaygroundScenarioLabRuntime,
  type PlaygroundScenarioLabRuntimeFactory,
  type PlaygroundScenarioLabSnapshot,
  type PlaygroundScenarioTaskContext,
  type PlaygroundTaskTraceDirection,
  type PlaygroundTaskTraceEntry,
  type PlaygroundTaskTracePresentation,
  SCENARIO_OPERATION_AUTHORITY,
  scenarioCommandId,
  type ScenarioContext,
  scenarioOperationOrdinals,
  type ScenarioStep,
  sendCommand,
  stableLocalTaskScope,
  standaloneScenarioTaskContext,
  stepsFor,
  traceDirection,
  tracePresentation,
} from './scenario-lab-model.js'

export abstract class PlaygroundScenarioLabControllerBase {
  protected runtime!: PlaygroundScenarioLabRuntime
  protected readonly listeners = new Set<Listener>()
  protected selectedScenarioId: PlaygroundScenarioId = 'continuous-sends'
  protected phase: PlaygroundScenarioLabSnapshot['phase'] = 'idle'
  protected cursor = 0
  protected activities: PlaygroundScenarioActivity[] = []
  protected bindings = new Map<string, AgentLoopTaskBindingV4>()
  protected definitions = new Map<string, AgentDefinition>()
  protected detailsUrls = new Map<string, AgentLoopTaskDetailsUrl>()
  protected conversationEntries: AgentConversationEntry[] = []
  protected conversationSequence = 0
  protected generation = 0
  protected running: Promise<void> | undefined
  protected error: string | undefined
  protected injectorPhase: PlaygroundEventInjectorSnapshot['phase'] = 'idle'
  protected simulatedTrace: PlaygroundTaskTraceEntry[] = []
  protected simulatedEventCursors = new Map<string, number>()
  protected pendingApproval: {
    readonly binding: PlaygroundRoomSimulationBinding
    readonly requestOperationId: string
    readonly turn: string
    readonly approvalId: string
  } | undefined
  protected latestInjectedSend: {
    readonly binding: AgentLoopTaskBindingV4
    readonly ordinal: number
    readonly turn: string
    readonly messageId: string
  } | undefined
  protected sourceTask!: PlaygroundScenarioTaskContext
  protected delay!: () => Promise<void>
  protected runtimeFactory!: PlaygroundScenarioLabRuntimeFactory
  protected roomBridgeState: PlaygroundEventInjectorSnapshot['roomBridge'] = {
    state: 'checking',
    delegationTargets: Object.freeze([]),
  }
  protected roomBridgeSubscription: (() => void) | undefined
  protected roomBridgeBinding: PlaygroundRoomSimulationBinding | undefined
  protected roomBridgeConnection = 0
  protected readonly roomBridgeOperationIds = new Set<string>()
  protected readonly roomBridgeEventFingerprints = new Set<string>()

  dispose(): void {
    this.generation += 1
    this.disconnectRoomBridge()
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.listeners.clear()
  }

  protected replaceRuntime(): void {
    this.runtime = this.runtimeFactory()
  }

  protected disposableGeneration(): string {
    return `${this.sourceTask.debugTaskId}:debug:${this.generation + 1}`
  }

  protected appendSimulatedTrace(input: Omit<PlaygroundTaskTraceEntry, 'id' | 'source' | 'generation'>): void {
    this.simulatedTrace = [
      ...this.simulatedTrace,
      Object.freeze({
        ...input,
        id: `simulated-${this.generation + 1}-${this.simulatedTrace.length + 1}`,
        source: 'simulated' as const,
        generation: this.disposableGeneration(),
      }),
    ]
    this.publish()
  }

  protected captureRuntimeTrace(taskRef: string, timestamp: string): void {
    const task = this.runtime.host.snapshot().tasks.find(candidate => candidate.taskRef === taskRef)
    if (task === undefined) return
    const cursor = this.simulatedEventCursors.get(taskRef) ?? 0
    for (const event of task.events.slice(cursor)) {
      this.appendSimulatedTrace({
        direction: traceDirection(event, 'simulated'),
        type: event.type,
        summary: event.detail,
        timestamp,
        payload: Object.freeze({
          event,
          ...(event.type === 'input.accepted' && task.input !== undefined ? { input: task.input } : {}),
          ...((event.type === 'execution.completed' || event.type === 'execution.failed')
              && task.execution !== undefined
            ? { execution: task.execution }
            : {}),
        }),
        correlations: eventCorrelations(event),
      })
    }
    this.simulatedEventCursors.set(taskRef, task.events.length)
  }

  protected async ensureInjectorBinding(): Promise<AgentLoopTaskBindingV4> {
    const existing = this.bindings.get('a')
    if (existing !== undefined) return existing
    await this.create(this.generation, this.runtime, this.bindings, 'a', agent('a'), 'event-injector')
    const binding = this.bindings.get('a')
    if (binding === undefined) throw new Error('The disposable AgentLoop binding was not created')
    this.captureRuntimeTrace(binding.task, new Date().toISOString())
    return binding
  }

  protected async performInjection(
    type: string,
    payload: unknown,
    operation: () => Promise<void>,
    request?: {
      readonly direction: PlaygroundTaskTraceDirection
      readonly summary: string
      readonly correlations?: PlaygroundTaskTraceEntry['correlations']
    },
  ): Promise<void> {
    if (this.injectorPhase === 'injecting') return
    this.injectorPhase = 'injecting'
    this.error = undefined
    this.appendSimulatedTrace({
      direction: request?.direction ?? 'injector-to-agent-host',
      type: `${type}.request`,
      summary: request?.summary ?? `Inject ${type} into the disposable task generation.`,
      timestamp: new Date().toISOString(),
      payload,
      correlations: request?.correlations ?? {},
    })
    try {
      await operation()
      this.injectorPhase = 'idle'
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.error = message
      this.injectorPhase = 'failed'
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: `${type}.failed`,
        summary: message,
        timestamp: new Date().toISOString(),
        payload: { error: message },
        correlations: {},
      })
    }
    this.publish()
  }

  protected async injectIsolatedFailure(text: string): Promise<void> {
    const normalized = text.trim()
    if (normalized === '') return
    const visibleText = normalized.replace(/\n?\[(?:approval|cli-fail)\]\s*$/iu, '').trim()
    await this.performInjection('typed-failure', { kind: 'typed-failure', text: visibleText }, async () => {
      const binding = await this.ensureInjectorBinding()
      const ordinal = this.nextInjectionOrdinal()
      await this.send(this.generation, this.runtime, this.bindings, 'a', ordinal, normalized, 'event-injector')
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      const sent = this.latestInjectedSend
      if (sent === undefined || sent.ordinal !== ordinal) {
        throw new Error('The disposable send result was not correlated')
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'typed-failure.observed',
        summary: 'The isolated failure probe completed through AgentLoop v4.',
        timestamp: new Date().toISOString(),
        payload: { turn: sent.turn, messageId: sent.messageId, taskRef: binding.task },
        correlations: { turn: sent.turn, messageId: sent.messageId },
      })
    })
  }

  protected async emitRoomAgentReply(text: string): Promise<void> {
    const normalized = text.trim()
    const binding = this.roomBridgeBinding
    if (normalized === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`agent-reply:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-reply', { text: normalized, binding }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.emitAgentReply(binding, operationId, { text: normalized })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent reply emission')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') {
        throw new Error(this.receiptFailure('Agent reply emission', receipt))
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-egress.accepted',
        summary: 'Chatroom accepted the bound Agent reply for the associated Room.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: binding.memberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Emit a reply from the bound Agent into the associated Playground Room.',
      correlations: { operationId, runId: binding.runId, memberId: binding.memberId },
    })
  }

  protected async emitRoomAgentApprovalRequest(reason: string): Promise<void> {
    const normalized = reason.trim()
    const binding = this.roomBridgeBinding
    if (normalized === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`permission:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-approval-request', { reason: normalized, binding }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.emitAgentApprovalRequest(binding, operationId, { reason: normalized })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent approval request')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') {
        throw new Error(this.receiptFailure('Agent approval request', receipt))
      }
      if (receipt.approvalId !== undefined) {
        this.pendingApproval = {
          binding,
          requestOperationId: operationId,
          turn: receipt.turnId ?? receipt.approvalId,
          approvalId: receipt.approvalId,
        }
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-approval.request.accepted',
        summary: 'Chatroom accepted the bound Agent approval request for the associated Room.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: binding.memberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Emit an approval request from the bound Agent into the associated Playground Room.',
      correlations: { operationId, runId: binding.runId, memberId: binding.memberId },
    })
  }

  protected async emitRoomTaskDelegation(memberId: string, task: string): Promise<void> {
    const normalizedMemberId = memberId.trim()
    const normalizedTask = task.trim()
    const binding = this.roomBridgeBinding
    if (normalizedMemberId === '' || normalizedTask === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`delegation:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-task-delegation', {
      memberId: normalizedMemberId,
      task: normalizedTask,
      binding,
    }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.delegateTask(binding, operationId, {
        memberId: normalizedMemberId,
        task: normalizedTask,
      })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent task delegation')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') {
        throw new Error(this.receiptFailure('Agent task delegation', receipt))
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-task-delegation.accepted',
        summary: 'Chatroom created a new target Agent session and accepted the delegated task.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: normalizedMemberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Delegate a task from the bound Agent to another Room entity in a new session.',
      correlations: { operationId, memberId: normalizedMemberId },
    })
  }

  protected roomBridgeOperationId(suffix: string): string {
    return scenarioCommandId(this.commandScope(), `room:${this.generation + 1}:${suffix}`)
  }

  protected nextInjectionOrdinal(): number {
    return nextScenarioOperationOrdinal(this.commandScope())
  }

  protected roomBridgeClient(): PlaygroundRoomSimulationForwardingClient | undefined {
    if (typeof window === 'undefined') return undefined
    return (window as Window & {
      readonly __cordisxRuntime?: {
        readonly playgroundRoomSimulationBridge?: PlaygroundRoomSimulationForwardingClient
      }
    }).__cordisxRuntime?.playgroundRoomSimulationBridge
  }

  protected connectRoomBridge(): void {
    this.disconnectRoomBridge()
    const connection = this.roomBridgeConnection
    const client = this.roomBridgeClient()
    if (client === undefined) {
      this.roomBridgeState = {
        state: 'unavailable',
        delegationTargets: Object.freeze([]),
        message: '当前 Playground 未安装 Room simulation bridge。',
      }
      return
    }
    this.roomBridgeState = { state: 'checking', delegationTargets: Object.freeze([]) }
    const resolveBinding = this.sourceTask.simulationBinding !== undefined
      ? Promise.resolve({
        status: 'available' as const,
        ownerGeneration: this.sourceTask.simulationBinding.ownerGeneration,
        value: this.sourceTask.simulationBinding,
      })
      : this.sourceTask.sessionId === undefined
      ? Promise.resolve({
        status: 'unavailable' as const,
        code: 'invalid-binding',
        message: '当前 task 没有关联可用的 Agent Session。',
      })
      : client.resolveSession(this.sourceTask.sessionId)
    void resolveBinding.then(resolved => {
      if (connection !== this.roomBridgeConnection) return
      if (resolved.status === 'unavailable') {
        this.markRoomBridgeUnavailable(`${resolved.code}: ${resolved.message}`)
        return
      }
      const binding = resolved.value
      this.roomBridgeBinding = binding
      this.roomBridgeSubscription = client.subscribe(binding, result => {
        if (connection !== this.roomBridgeConnection) return
        this.consumeRoomBridgeEvent(result)
      })
      return Promise.all([client.inspect(binding), client.snapshot(binding)]).then(([result, snapshot]) => {
        if (connection !== this.roomBridgeConnection) return
        if (result.status === 'unavailable') {
          this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
          return
        }
        if (snapshot.status === 'unavailable') {
          this.markRoomBridgeUnavailable(`${snapshot.code}: ${snapshot.message}`)
          return
        }
        if (result.value.lifecycle !== 'active') {
          this.markRoomBridgeUnavailable(result.value.reason ?? `关联 Room 当前状态为 ${result.value.lifecycle}。`)
          return
        }
        this.observeRoomBridgeSnapshotOperationIds(snapshot.value)
        this.roomBridgeState = {
          state: 'available',
          delegationTargets: Object.freeze([...result.value.delegationTargets]),
        }
        this.publish()
      })
    }).catch(cause => {
      if (connection === this.roomBridgeConnection) {
        this.markRoomBridgeUnavailable(cause instanceof Error ? cause.message : String(cause))
      }
    })
  }

  protected disconnectRoomBridge(): void {
    this.roomBridgeConnection += 1
    this.roomBridgeSubscription?.()
    this.roomBridgeSubscription = undefined
    this.roomBridgeBinding = undefined
  }

  protected markRoomBridgeUnavailable(message: string): void {
    this.roomBridgeState = { state: 'unavailable', delegationTargets: Object.freeze([]), message }
    this.publish()
  }

  protected async requireRoomBridge(
    binding: PlaygroundRoomSimulationBinding,
  ): Promise<PlaygroundRoomSimulationForwardingClient> {
    const client = this.roomBridgeClient()
    if (client === undefined) throw new Error('The Playground Room simulation bridge is unavailable.')
    const inspection = await client.inspect(binding)
    if (inspection.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${inspection.code}: ${inspection.message}`)
      throw new Error(`${inspection.code}: ${inspection.message}`)
    }
    if (inspection.value.lifecycle !== 'active') {
      const message = inspection.value.reason ?? `The associated Room is ${inspection.value.lifecycle}.`
      this.markRoomBridgeUnavailable(message)
      throw new Error(message)
    }
    this.roomBridgeState = {
      state: 'available',
      delegationTargets: Object.freeze([...inspection.value.delegationTargets]),
    }
    return client
  }

  protected requireRoomBridgeReceipt(
    result: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>,
    action: string,
  ): PlaygroundRoomSimulationOperationReceipt {
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      throw new Error(`${action}: ${result.code}: ${result.message}`)
    }
    return result.value
  }

  protected receiptFailure(action: string, receipt: PlaygroundRoomSimulationOperationReceipt): string {
    const code = typeof receipt.detail?.code === 'string' ? `/${receipt.detail.code}` : ''
    return `${action}: ${receipt.phase}${code}`
  }

  protected async refreshRoomBridgeSnapshot(
    client: PlaygroundRoomSimulationForwardingClient,
    binding: PlaygroundRoomSimulationBinding,
  ): Promise<void> {
    const result = await client.snapshot(binding)
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      return
    }
    this.consumeRoomBridgeSnapshot(result.value)
  }

  protected consumeRoomBridgeSnapshot(snapshot: PlaygroundRoomSimulationSnapshot): void {
    this.observeRoomBridgeSnapshotOperationIds(snapshot)
    for (const event of snapshot.events) {
      this.consumeRoomBridgeEvent({ status: 'available', ownerGeneration: event.binding.ownerGeneration, value: event })
    }
  }

  protected observeRoomBridgeSnapshotOperationIds(snapshot: PlaygroundRoomSimulationSnapshot): void {
    for (const event of snapshot.events) this.observeRoomBridgeEventOperationIds(event)
  }

  protected observeRoomBridgeEventOperationIds(event: PlaygroundRoomSimulationEvent): void {
    const scope = this.commandScope()
    observeScenarioRoomOperationId(scope, event.operationId)
    observeScenarioRoomOperationId(
      scope,
      typeof event.detail?.requestOperationId === 'string'
        ? event.detail.requestOperationId
        : undefined,
    )
  }

  protected consumeRoomBridgeEvent(result: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>): void {
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      return
    }
    this.roomBridgeState = { ...this.roomBridgeState, state: 'available' }
    const event = result.value
    this.observeRoomBridgeEventOperationIds(event)
    const requestOperationId = typeof event.detail?.requestOperationId === 'string'
      ? event.detail.requestOperationId
      : undefined
    const isTrackedOperation = event.operationId !== undefined && this.roomBridgeOperationIds.has(event.operationId)
    const isTrackedRequest = requestOperationId !== undefined && this.roomBridgeOperationIds.has(requestOperationId)
    if (event.operationId !== undefined && !isTrackedOperation && !isTrackedRequest) return
    if (
      event.operationId === undefined && !isTrackedRequest
      && (event.kind !== 'room.run.lifecycle' || this.roomBridgeOperationIds.size === 0)
    ) return
    const fingerprint = event.kind === 'room.agent-task-delegation.projected'
      ? `${event.kind}\u0000${event.operationId ?? ''}`
      : `${event.kind}\u0000${event.operationId ?? ''}\u0000${JSON.stringify(event.detail ?? {})}`
    if (this.roomBridgeEventFingerprints.has(fingerprint)) return
    this.roomBridgeEventFingerprints.add(fingerprint)
    const approvalId = typeof event.detail?.approvalId === 'string' ? event.detail.approvalId : undefined
    const turn = typeof event.detail?.turnId === 'string' ? event.detail.turnId : undefined
    if (
      (event.kind === 'room.agent-approval.pending' || event.kind === 'room.permission.pending')
      && approvalId !== undefined && event.operationId !== undefined
    ) {
      this.pendingApproval = {
        binding: event.binding,
        requestOperationId: event.operationId,
        turn: turn ?? approvalId,
        approvalId,
      }
    } else if (
      (event.kind === 'room.agent-approval.terminal' || event.kind === 'room.permission.terminal'
        || event.kind === 'room.permission-decision.terminal')
      && approvalId !== undefined && this.pendingApproval?.approvalId === approvalId
    ) {
      this.pendingApproval = undefined
    }
    this.appendSimulatedTrace({
      direction: this.roomBridgeEventDirection(event),
      type: event.kind,
      summary: this.roomBridgeEventSummary(event),
      timestamp: event.occurredAt ?? new Date().toISOString(),
      payload: event,
      correlations: {
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(turn === undefined ? {} : { turn }),
        ...(typeof event.detail?.messageId === 'string' ? { messageId: event.detail.messageId } : {}),
        memberId: event.binding.memberId,
        runId: event.binding.runId,
      },
    })
  }

  protected roomBridgeEventDirection(event: PlaygroundRoomSimulationEvent): PlaygroundTaskTraceDirection {
    if (event.kind === 'room.message.projected') return 'simulator-to-chatroom'
    if (
      event.kind === 'room.agent-message.projected'
      || event.kind.startsWith('room.agent-message.targeted.')
      || event.kind.startsWith('room.agent-egress.')
      || event.kind.startsWith('room.agent-task-delegation.')
      || event.kind.startsWith('room.agent-approval.')
      || event.kind === 'room.permission.pending' || event.kind === 'room.permission.terminal'
    ) {
      return 'agent-host-to-chatroom'
    }
    if (event.kind.startsWith('room.permission-decision.')) return 'simulator-to-chatroom'
    return 'host-lifecycle'
  }

  protected roomBridgeEventSummary(event: PlaygroundRoomSimulationEvent): string {
    const detail = event.detail ?? {}
    if (event.kind === 'room.message.projected') {
      return 'The simulated input is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-message.projected') {
      return 'The Agent response is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-message.targeted.projected') {
      return 'The addressed Agent message is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-message.targeted.accepted') {
      return `Chatroom delivered the message only to ${String(detail.targetMemberId ?? 'the mentioned entity')}.`
    }
    if (event.kind === 'room.agent-egress.projected') {
      return 'The bound Agent reply is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-egress.delivery.accepted') return 'Chatroom accepted the bound Agent reply delivery.'
    if (event.kind === 'room.agent-egress.ack.terminal') {
      return `The Agent reply acknowledgement reached ${String(detail.state ?? 'a terminal state')}.`
    }
    if (event.kind === 'room.agent-task-delegation.projected') {
      return 'The delegated task is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-task-delegation.accepted') {
      return `Chatroom accepted the delegated task for ${String(detail.targetMemberId ?? 'the target entity')}.`
    }
    if (event.kind === 'room.agent-approval.projected') {
      return 'The bound Agent approval card is visible in the associated Room timeline.'
    }
    if (event.kind === 'room.agent-approval.pending') {
      return 'The bound Agent approval request is pending in the associated Room.'
    }
    if (event.kind === 'room.agent-approval.decision.accepted') {
      return `Chatroom accepted the ${String(detail.decision ?? 'updated')} decision for the Agent approval request.`
    }
    if (event.kind === 'room.agent-approval.terminal') {
      return `The Agent approval request reached ${String(detail.state ?? detail.decision ?? 'a terminal state')}.`
    }
    if (event.kind === 'room.permission.pending') return 'Chatroom projected a pending permission request.'
    if (event.kind === 'room.permission.terminal') {
      return `The Room permission request reached ${String(detail.state ?? 'a terminal state')}.`
    }
    if (event.kind === 'room.delivery.accepted') return 'Chatroom accepted the Room delivery.'
    if (event.kind === 'room.delivery.failed') {
      return `The Room delivery failed${typeof detail.failureCode === 'string' ? `: ${detail.failureCode}` : '.'}`
    }
    if (event.kind === 'room.ack.terminal') {
      return `The Room acknowledgement reached ${String(detail.state ?? 'a terminal state')}.`
    }
    if (event.kind.startsWith('room.permission-decision.')) {
      return `The permission decision is ${String(detail.state ?? detail.decision ?? 'updated')}.`
    }
    if (event.kind === 'room.run.lifecycle') {
      return `Run ${String(detail.status ?? 'state')} · ${String(detail.presence ?? 'presence unavailable')}`
    }
    return event.kind
  }

  protected abstract create(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    definition: AgentDefinition,
    flowId?: string,
  ): Promise<void>
  protected abstract send(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    ordinal: number,
    text: string,
    flowId?: string,
  ): Promise<void>
  protected abstract commandScope(): string
  protected abstract publish(): void
}
