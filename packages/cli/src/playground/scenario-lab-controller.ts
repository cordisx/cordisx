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

import { PlaygroundScenarioLabControllerBase } from './scenario-lab-controller-base.js'

export class PlaygroundScenarioLabController extends PlaygroundScenarioLabControllerBase {
  constructor(sourceTask: PlaygroundScenarioTaskContext)
  constructor(delay?: () => Promise<void>, runtimeFactory?: PlaygroundScenarioLabRuntimeFactory)
  constructor(
    sourceTaskOrDelay: PlaygroundScenarioTaskContext | (() => Promise<void>) = () =>
      new Promise(resolve => setTimeout(resolve, 160)),
    runtimeFactory: PlaygroundScenarioLabRuntimeFactory = createPlaygroundScenarioLabRuntime,
  ) {
    super()
    this.sourceTask = typeof sourceTaskOrDelay === 'function' ? standaloneScenarioTaskContext() : sourceTaskOrDelay
    this.delay = typeof sourceTaskOrDelay === 'function'
      ? sourceTaskOrDelay
      : () => new Promise(resolve => setTimeout(resolve, 160))
    this.runtimeFactory = runtimeFactory
    this.replaceRuntime()
    this.connectRoomBridge()
  }

  readonly subscribe = (listener: Listener): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PlaygroundScenarioLabSnapshot => {
    return Object.freeze({
      owner: 'host-playground-scenario-lab',
      sourceTask: this.sourceTask,
      disposableGeneration: this.disposableGeneration(),
      selectedScenarioId: this.selectedScenarioId,
      phase: this.phase,
      cursor: this.cursor,
      stepCount: stepsFor(this.selectedScenarioId).length,
      activities: Object.freeze([...this.activities]),
      trace: Object.freeze([...originalTrace(this.sourceTask), ...this.simulatedTrace]),
      injector: Object.freeze({
        phase: this.injectorPhase,
        eventCount: this.simulatedTrace.length,
        roomBridge: Object.freeze({ ...this.roomBridgeState }),
        ...(this.pendingApproval === undefined ? {} : {
          pendingApproval: Object.freeze({
            turn: this.pendingApproval.turn,
            approvalId: this.pendingApproval.approvalId,
          }),
        }),
      }),
      tasks: this.runtime.host.snapshot().tasks,
      conversation: this.conversation(),
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  select(id: PlaygroundScenarioId): void {
    if (this.selectedScenarioId === id) return
    this.selectedScenarioId = id
    this.reset()
  }

  next(): Promise<void> {
    if (this.phase === 'running') return this.running ?? Promise.resolve()
    return this.executeNext('paused')
  }

  run(): Promise<void> {
    if (this.running !== undefined) return this.running
    const generation = this.generation
    this.phase = 'running'
    this.publish()
    this.running = (async () => {
      while (
        generation === this.generation && this.phase === 'running'
        && this.cursor < stepsFor(this.selectedScenarioId).length
      ) {
        await this.executeNext('running')
        if (
          generation === this.generation && this.phase === 'running'
          && this.cursor < stepsFor(this.selectedScenarioId).length
        ) await this.delay()
      }
    })().finally(() => {
      if (generation !== this.generation) return
      this.running = undefined
      if (this.cursor >= stepsFor(this.selectedScenarioId).length && this.phase !== 'failed') this.phase = 'completed'
      this.publish()
    })
    return this.running
  }

  pause(): void {
    if (this.phase !== 'running') return
    this.phase = 'paused'
    this.publish()
  }

  injectAgentReply(text: string): Promise<void> {
    return this.emitRoomAgentReply(text)
  }

  injectAgentApprovalRequest(reason: string): Promise<void> {
    return this.emitRoomAgentApprovalRequest(reason)
  }

  injectTaskDelegation(memberId: string, task: string): Promise<void> {
    return this.emitRoomTaskDelegation(memberId, task)
  }

  injectFailure(message: string): Promise<void> {
    return this.injectIsolatedFailure(`${message}\n[cli-fail]`)
  }

  injectMemberSelfIntroduction(input: {
    readonly participantId: string
    readonly memberId: string
    readonly runId: string
  }): Promise<void> {
    return this.injectIntroductionEvent(input)
  }

  resolvePendingApproval(decision: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    return this.resolveInjectorApproval(decision)
  }

  reset(): void {
    this.generation += 1
    this.disconnectRoomBridge()
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.cursor = 0
    this.activities = []
    this.bindings = new Map()
    this.definitions = new Map()
    this.detailsUrls = new Map()
    this.conversationEntries = []
    this.conversationSequence = 0
    this.injectorPhase = 'idle'
    this.simulatedTrace = []
    this.simulatedEventCursors = new Map()
    this.roomBridgeOperationIds.clear()
    this.roomBridgeEventFingerprints.clear()
    this.pendingApproval = undefined
    this.latestInjectedSend = undefined
    this.error = undefined
    this.phase = 'idle'
    this.running = undefined
    this.replaceRuntime()
    this.connectRoomBridge()
    this.publish()
  }

  private async injectIntroductionEvent(
    input: { readonly participantId: string; readonly memberId: string; readonly runId: string },
  ): Promise<void> {
    if (input.participantId.trim() === '' || input.memberId.trim() === '' || input.runId.trim() === '') return
    await this.performInjection('member-self-introduction', input, async () => {
      const binding = await this.ensureInjectorBinding()
      const commandId = scenarioCommandId(
        this.commandScope(),
        `event-injector:introduction:${this.nextInjectionOrdinal()}`,
      )
      const result = await this.runtime.client.requestMemberSelfIntroduction({
        $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
        contract: 'cordisx.agent-loop-command/v4',
        schemaVersion: 4,
        commandId,
        type: 'request-member-self-introduction',
        binding,
        participantId: input.participantId,
        memberId: input.memberId,
        runId: input.runId,
        intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
      })
      if (result.status !== 'accepted') {
        throw new Error(`member-self-introduction: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
      }
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      await this.delay()
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'member-self-introduction.accepted',
        summary: 'The structured member self-introduction completed through AgentLoop v4.',
        timestamp: new Date().toISOString(),
        payload: result,
        correlations: { operationId: commandId, turn: result.turn, messageId: result.messageId, ...input },
      })
    })
  }

  private async resolveInjectorApproval(decision: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    const pending = this.pendingApproval
    if (pending === undefined) return
    const operationId = this.roomBridgeOperationId(`permission-decision:${this.nextInjectionOrdinal()}:${decision}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection(
      'permission-decision',
      { approvalId: pending.approvalId, turn: pending.turn, decision },
      async () => {
        const client = await this.requireRoomBridge(pending.binding)
        const result = await client.decidePermission(
          pending.binding,
          operationId,
          pending.approvalId,
          decision === 'approved' ? 'allow' : decision === 'denied' ? 'deny' : 'cancel',
        )
        const receipt = this.requireRoomBridgeReceipt(result, 'permission decision')
        if (receipt.phase === 'rejected' || receipt.phase === 'failed') {
          throw new Error(
            this.receiptFailure('permission decision', receipt),
          )
        }
        this.pendingApproval = undefined
        this.appendSimulatedTrace({
          direction: 'simulator-to-chatroom',
          type: 'permission-decision.accepted',
          summary: `Chatroom accepted the ${decision} permission decision.`,
          timestamp: new Date().toISOString(),
          payload: receipt,
          correlations: {
            operationId,
            turn: receipt.turnId ?? pending.turn,
            runId: receipt.runId ?? pending.binding.runId,
          },
        })
        await this.refreshRoomBridgeSnapshot(client, pending.binding)
      },
      {
        direction: 'simulator-to-chatroom',
        summary: 'Send a decision to the pending Chatroom permission request.',
        correlations: { operationId, turn: pending.turn, runId: pending.binding.runId },
      },
    )
  }

  private async executeNext(resumePhase: 'running' | 'paused'): Promise<void> {
    const step = stepsFor(this.selectedScenarioId)[this.cursor]
    if (step === undefined) {
      this.phase = 'completed'
      this.publish()
      return
    }
    const generation = this.generation
    const runtime = this.runtime
    const bindings = this.bindings
    this.append('operation', step.id)
    try {
      await step.execute({
        client: runtime.client,
        bindings,
        append: (kind, message) => {
          if (this.current(generation, runtime, bindings)) this.append(kind, message)
        },
        create: (alias, definition) => this.create(generation, runtime, bindings, alias, definition),
        send: (alias, ordinal, text) => this.send(generation, runtime, bindings, alias, ordinal, text),
        decide: (alias, ordinal, decision) => this.decide(generation, runtime, bindings, alias, ordinal, decision),
      })
      if (!this.current(generation, runtime, bindings)) return
      this.cursor += 1
      this.phase = this.cursor >= stepsFor(this.selectedScenarioId).length ? 'completed' : resumePhase
      this.publish()
    } catch (cause) {
      if (!this.current(generation, runtime, bindings)) return
      this.error = cause instanceof Error ? cause.message : String(cause)
      this.phase = 'failed'
      this.append('result', `failed: ${this.error}`)
    }
  }

  protected async create(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    definition: AgentDefinition,
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const sourceDefinition = alias === 'a'
      ? this.sourceTask.catalog.find(candidate =>
        candidate.identity.agentId === this.sourceTask.identity.agentId
        && candidate.identity.revision === this.sourceTask.identity.revision
      )
      : undefined
    const selectedDefinition = sourceDefinition ?? definition
    const definitions = sourceDefinition === undefined ? [selectedDefinition] : this.sourceTask.catalog
    const result = await runtime.client.createOrBind(createCommand(
      flowId,
      this.commandScope(),
      alias,
      selectedDefinition,
      definitions,
    ))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') {
      throw new Error(`create ${alias}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    }
    bindings.set(alias, result.binding)
    this.definitions.set(alias, selectedDefinition)
    // A disposable generation is inspected in the source task workbench. Its
    // shell must not navigate to the isolated runtime's coincidentally numbered
    // mock task URL.
    this.detailsUrls.set(alias, this.commandScope() === '' ? result.detailsUrl : this.sourceTask.detailsUrl)
    this.append('result', `create ${alias}: ${result.delivery.disposition}`)
  }

  protected async send(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    ordinal: number,
    text: string,
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const binding = bindings.get(alias)
    if (binding === undefined) throw new Error(`binding ${alias} is unavailable`)
    const operationId = scenarioCommandId(this.commandScope(), `${flowId}:send:${alias}:${ordinal}`)
    this.appendConversationMessage({
      itemId: `user-${alias}-${ordinal}`,
      messageId: `user-message-${alias}-${ordinal}`,
      authorId: 'scenario-human',
      body: [text],
      deliveryState: 'pending',
      runState: 'running',
      ariaLive: 'off',
      actions: [],
      reactions: [{
        reactionId: `reaction-${alias}-${ordinal}`,
        actorParticipantId: `scenario-agent-${alias}`,
        value: { kind: 'emoji', emoji: '✓' },
        state: 'pending',
      }],
      semantic: { purpose: 'conversation', causation: { operationId } },
    })
    const result = await runtime.client.send(sendCommand(flowId, this.commandScope(), alias, ordinal, binding, text))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') {
      this.updateUserDelivery(alias, ordinal, 'failed')
      throw new Error(`send ${alias}/${ordinal}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    }
    if (flowId === 'event-injector') {
      this.latestInjectedSend = {
        binding,
        ordinal,
        turn: result.turn,
        messageId: result.messageId,
      }
    }
    this.updateUserDelivery(alias, ordinal, 'delivered')
    const definition = this.definitions.get(alias)
    const task = runtime.host.snapshot().tasks.find(candidate =>
      definition !== undefined
      && candidate.identity.agentId === definition.identity.agentId
      && candidate.identity.revision === definition.identity.revision
    )
    const output = task?.execution?.result.status === 'ok'
      ? task.execution.result.stdout ?? 'Completed successfully.'
      : task?.execution?.result.error?.message ?? 'The deterministic scenario operation failed.'
    this.appendConversationMessage({
      itemId: `agent-${alias}-${ordinal}`,
      messageId: result.messageId,
      authorId: `scenario-agent-${alias}`,
      body: [output],
      deliveryState: 'delivered',
      runState: task?.status === 'error' ? 'failed' : 'idle',
      ariaLive: 'polite',
      actions: [],
      source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
    })
    if (/\[approval\]/iu.test(text)) this.appendApproval(alias, ordinal, binding, result.turn)
    this.append('result', `send ${alias}/${ordinal}: ${result.delivery.disposition}`)
  }

  private async decide(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    ordinal: number,
    decision: 'approved' | 'denied' | 'cancelled',
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const binding = bindings.get(alias)
    if (binding === undefined) throw new Error(`binding ${alias} is unavailable`)
    const result = await runtime.client.decideApproval(approvalCommand(
      flowId,
      this.commandScope(),
      alias,
      ordinal,
      binding,
      decision,
    ))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') {
      throw new Error(`approval ${alias}/${ordinal}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    }
    this.resolveApproval(alias, ordinal, result.decision)
    this.append('result', `approval ${alias}/${ordinal}: ${result.decision}/${result.delivery.disposition}`)
  }

  private current(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
  ): boolean {
    return generation === this.generation && runtime === this.runtime && bindings === this.bindings
  }

  protected commandScope(): string {
    if (this.sourceTask.debugTaskId === 'Standalone Scenario Task') return ''
    return stableLocalTaskScope(this.sourceTask.taskRef)
  }

  private append(kind: PlaygroundScenarioActivity['kind'], message: string): void {
    this.activities = [...this.activities, { sequence: this.activities.length + 1, kind, message }]
    this.publish()
  }

  private appendConversationMessage(
    input: Omit<AgentConversationMessage, 'kind' | 'sequence' | 'timestamp'>,
  ): void {
    const sequence = ++this.conversationSequence
    this.conversationEntries = [...this.conversationEntries, {
      ...input,
      kind: 'message',
      sequence,
      timestamp: new Date(Date.UTC(2026, 7, 31, 0, 0, sequence)).toISOString(),
    }]
    this.publish()
  }

  private updateUserDelivery(alias: string, ordinal: number, deliveryState: 'delivered' | 'failed'): void {
    const itemId = `user-${alias}-${ordinal}`
    this.conversationEntries = this.conversationEntries.map(entry => {
      if (entry.kind !== 'message' || entry.itemId !== itemId) return entry
      const reactions = entry.reactions?.map(reaction => ({
        ...reaction,
        state: deliveryState === 'failed' ? 'failed' as const : 'completed' as const,
      }))
      return {
        ...entry,
        deliveryState,
        runState: deliveryState === 'failed' ? 'failed' : 'idle',
        ...(reactions === undefined ? {} : { reactions }),
      }
    })
    this.publish()
  }

  private appendApproval(alias: string, ordinal: number, binding: AgentLoopTaskBindingV4, turn: string): void {
    const sequence = ++this.conversationSequence
    const item: AgentConversationApproval = {
      kind: 'approval',
      itemId: `approval-${alias}-${ordinal}`,
      sequence,
      participantId: `scenario-agent-${alias}`,
      memberId: `scenario-member-${alias}`,
      runId: `scenario-run-${alias}`,
      binding: binding.binding,
      turn,
      approvalId: `simulated-approval-${turn}`,
      approvalKind: 'command',
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: `scenario.approval.${alias}.${ordinal}.approve` } },
        { decision: 'deny', command: { id: `scenario.approval.${alias}.${ordinal}.deny` } },
        { decision: 'cancel', command: { id: `scenario.approval.${alias}.${ordinal}.cancel` } },
      ],
      rationale: `Agent ${alias.toUpperCase()} requests deterministic command approval ${ordinal}.`,
    }
    this.conversationEntries = [...this.conversationEntries, item]
    this.publish()
  }

  private resolveApproval(alias: string, ordinal: number, decision: 'approved' | 'denied' | 'cancelled'): void {
    const itemId = `approval-${alias}-${ordinal}`
    this.conversationEntries = this.conversationEntries.map(entry =>
      entry.kind === 'approval' && entry.itemId === itemId
        ? { ...entry, state: decision, actions: [] }
        : entry
    )
    this.publish()
  }

  private conversation(): AgentConversationModel {
    const selected = this.selectedScenarioId
    const scope = this.commandScope()
    const participatingAliases = aliases.filter(alias => this.definitions.has(alias))
    const participants = [
      { id: 'scenario-human', role: 'human' as const, name: 'You' },
      ...participatingAliases.map(alias => {
        const definition = this.definitions.get(alias)!
        return {
          id: `scenario-agent-${alias}`,
          role: 'agent' as const,
          name: definition.name ?? labelFor(alias),
          agentIdentity: definition.identity,
          avatar: createGeneratedAgentAvatarRef({
            namespace: 'agent-definition',
            agentId: definition.identity.agentId,
          }),
        }
      }),
    ]
    const activeRuns = participatingAliases.flatMap(alias => {
      const detailsUrl = this.detailsUrls.get(alias)
      return detailsUrl === undefined ? [] : [{
        participantId: `scenario-agent-${alias}`,
        memberId: `scenario-member-${alias}`,
        runId: `scenario-run-${alias}`,
        lifecycle: { phase: 'active' as const },
        detailsUrl,
      }]
    })
    return createAgentConversationModel({
      ownerId: scope === '' ? 'host-playground-scenario-lab' : `host-playground-simulator-task-${scope}`,
      shell: 'agent-desktop',
      binding: {
        bindingId: scope === '' ? 'scenario-shell' : `scenario-shell-${scope}`,
        ownerGeneration: `scenario-generation-${this.generation}`,
      },
      generation: `scenario-snapshot-${this.generation}`,
      snapshotSequence: this.conversationSequence,
      selection: {
        kind: 'room',
        roomId: scope === '' ? `scenario-${selected}` : `scenario-${scope}-${selected}`,
        title: scope === ''
          ? PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === selected)!.title.en
          : `${this.sourceTask.agentLabel} · ${
            PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === selected)!.title.en
          }`,
        description: {
          state: 'present',
          text: scope === ''
            ? 'Developer-only disposable Conversation Shell preview.'
            : `Disposable generation for ${this.sourceTask.debugTaskId}; the source task snapshot is unchanged.`,
        },
        multiParticipant: participants.length > 1,
        participantPresentation: participants.length > 1 ? 'host-initials' : 'none',
        participants,
        activeRuns,
      },
      entries: this.conversationEntries,
      composer: {
        availability: 'unavailable',
        placeholder: 'Use Run or Next to drive this disposable scenario.',
        disabled: true,
        disabledReason: 'Scenario controls own this deterministic preview.',
        shortcutPolicy: 'enter',
        submit: { id: 'scenario.submit' },
      },
      headerActions: [],
    })
  }

  protected publish(): void {
    for (const listener of this.listeners) listener()
  }
}
