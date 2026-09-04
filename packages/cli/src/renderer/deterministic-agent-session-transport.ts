import type { AgentOptions, AgentSetup } from '@cordisx/protocol/agents/v1'
import type { AgentCancelCause, ApprovalOutcome, MessageId, SessionEvent, UserMessage } from '@cordisx/protocol/sessions/v1'
import type {
  CordisXDriverApprovalRequest,
  CordisXDriverAgentStatus,
  CordisXDriverMessageClaimed,
  CordisXDriverSessionEvent,
  CordisXPrivateAgentDriver,
  CordisXPersistedSession,
} from './agent-session-runtime.js'
import type { PlaygroundRoomSimulationForwardingClient } from './playground-room-simulation-bridge.js'
import type {
  PlaygroundScenarioSessionScopeClient,
  PlaygroundScenarioSessionScopeHandle,
} from './playground-scenario-session-scope.js'
import {
  PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE,
  type PlaygroundSessionScenarioCatalogV1,
  type PlaygroundSessionScenarioDefinition,
  type PlaygroundSessionScenarioEventData,
  type PlaygroundSessionScenarioStep,
} from '../playground/session-scenario-catalog.js'

const clone = <Value>(value: Value): Value => structuredClone(value)

interface PlaygroundRun {
  readonly turn: number
  readonly message: UserMessage
  cancelled: boolean
}

interface PlaygroundSessionState {
  nextTurn: number
  active?: PlaygroundRun
  queue: UserMessage[]
  setup?: AgentSetup
}

interface ScenarioActorRun {
  readonly actor: string
  readonly sessionId: string
  readonly run: PlaygroundRun
  started: boolean
  ended: boolean
}

interface ScenarioRun {
  readonly runId: string
  readonly sourceMessageId: string
  readonly code: string
  readonly catalogRevision: string
  readonly actors: Map<string, ScenarioActorRun>
  readonly toolCalls: Map<string, { readonly actor: string; readonly callId: string; readonly name: string }>
  scopeActivation?: PlaygroundScenarioSessionScopeHandle
  stepIndex: number
  stepCount: number
  currentStep?: PlaygroundSessionScenarioStep
}

interface PendingDelegation {
  readonly scenario: ScenarioRun
  readonly actor: string
  readonly targetAgentId: string
  readonly task: string
  readonly resolve: (actor: ScenarioActorRun) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

class DeclaredScenarioFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

class DeclaredScenarioCancellation extends Error {}

export interface DeterministicAgentSessionTransportOptions {
  readonly recoveredSessions?: readonly CordisXPersistedSession[]
  readonly scenarioCatalog?: PlaygroundSessionScenarioCatalogV1
  readonly roomBridge?: PlaygroundRoomSimulationForwardingClient
  readonly scenarioSessionScope?: PlaygroundScenarioSessionScopeClient
  readonly delegationTimeoutMs?: number
}

const scenarioModelPrefix = 'playground-scenario/v1'
const textOf = (message: UserMessage): string => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const scenarioCodeOf = (message: UserMessage): string | undefined => message.content.length === 1 && message.content[0]?.type === 'text'
  ? message.content[0].text
  : undefined

function sessionAgentId(setup: AgentSetup | undefined): string | undefined {
  return setup?.definition.agentId
}

function recoveredScenarioEvents(session: CordisXPersistedSession): readonly Extract<SessionEvent, { readonly type: typeof PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE }>[] {
  return session.events.filter((event): event is Extract<SessionEvent, { readonly type: typeof PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE }> => (
    event.type === PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE && event.ignorable === true
  ))
}

/**
 * Explicit development-only deterministic transport. It has no network, Codex
 * provider, App Server, preload bridge, or persistence. The enclosing Host
 * Session authority appends every emitted event and owns replay/live delivery.
 */
export class DeterministicAgentSessionTransport implements CordisXPrivateAgentDriver {
  private readonly sessions = new Map<string, PlaygroundSessionState>()
  private readonly replacements = new Set<() => void>()
  private readonly eventListeners = new Set<(event: CordisXDriverSessionEvent) => void | Promise<void>>()
  private readonly approvalListeners = new Set<(request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>>()
  private readonly statusListeners = new Set<(event: CordisXDriverAgentStatus) => void>()
  private readonly claimedListeners = new Set<(event: CordisXDriverMessageClaimed) => void>()
  private readonly scenarioCatalog: PlaygroundSessionScenarioCatalogV1 | undefined
  private readonly roomBridge: PlaygroundRoomSimulationForwardingClient | undefined
  private readonly scenarioSessionScope: PlaygroundScenarioSessionScopeClient | undefined
  private readonly delegationTimeoutMs: number
  private readonly seenScenarioRuns = new Set<string>()
  private readonly interruptedScenarioRuns = new Map<string, PlaygroundSessionScenarioEventData>()
  private readonly pendingDelegations = new Set<PendingDelegation>()
  private readonly scenarioRuns = new Set<ScenarioRun>()
  private disposed = false

  constructor(input: readonly CordisXPersistedSession[] | DeterministicAgentSessionTransportOptions = []) {
    const options: DeterministicAgentSessionTransportOptions = Array.isArray(input)
      ? { recoveredSessions: input as readonly CordisXPersistedSession[] }
      : input as DeterministicAgentSessionTransportOptions
    const recoveredSessions = options.recoveredSessions ?? []
    this.scenarioCatalog = options.scenarioCatalog?.enabled === true ? clone(options.scenarioCatalog) : undefined
    this.roomBridge = options.roomBridge
    this.scenarioSessionScope = options.scenarioSessionScope
    this.delegationTimeoutMs = options.delegationTimeoutMs ?? 10_000
    for (const session of recoveredSessions) {
      const nextTurn = session.events.reduce((highest, event) => {
        const turn = 'turn' in event.data && typeof event.data.turn === 'number' ? event.data.turn : 0
        return Math.max(highest, turn)
      }, 0)
      this.sessions.set(session.id, { nextTurn, queue: [], ...(session.setup === undefined ? {} : { setup: clone(session.setup) }) })
      const facts = recoveredScenarioEvents(session)
      for (const fact of facts) this.seenScenarioRuns.add(fact.data.runId)
      const latestByRun = new Map<string, PlaygroundSessionScenarioEventData>()
      for (const fact of facts) latestByRun.set(fact.data.runId, fact.data)
      for (const fact of latestByRun.values()) if (fact.actor === 'lead'
        && fact.phase !== 'completed' && fact.phase !== 'failed' && fact.phase !== 'cancelled') {
        this.interruptedScenarioRuns.set(session.id, clone(fact))
      }
    }
  }

  async create(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentSetup }): Promise<{ readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } }> {
    if (this.disposed || this.sessions.has(input.sessionId)) throw new Error('Playground Agent Session creation is unavailable')
    this.sessions.set(input.sessionId, { nextTurn: 0, queue: [], ...(input.setup === undefined ? {} : { setup: clone(input.setup) }) })
    return { status: 'accepted', detail: { kind: 'host', ref: `deterministic-agent-session:${input.sessionId}` } }
  }

  async resume(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentSetup }): Promise<{ readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } } | { readonly status: 'unavailable'; readonly code: 'unsupported' }> {
    if (this.disposed) return { status: 'unavailable', code: 'unsupported' }
    const existing = this.sessions.get(input.sessionId)
    if (existing === undefined) this.sessions.set(input.sessionId, { nextTurn: 0, queue: [], ...(input.setup === undefined ? {} : { setup: clone(input.setup) }) })
    else if (input.setup !== undefined) existing.setup = clone(input.setup)
    const interrupted = this.interruptedScenarioRuns.get(input.sessionId)
    if (interrupted !== undefined) {
      this.interruptedScenarioRuns.delete(input.sessionId)
      setTimeout(() => { void this.closeInterruptedScenario(input.sessionId, interrupted) }, 0)
    }
    return { status: 'accepted', detail: { kind: 'host', ref: `deterministic-agent-session:${input.sessionId}` } }
  }

  async submit(input: { readonly sessionId: string; readonly message: UserMessage }): Promise<'accepted' | 'replayed' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'unavailable'
    const delegated = session.active === undefined ? this.pendingDelegation(session, input.sessionId, input.message) : undefined
    if (delegated !== undefined) {
      const run: PlaygroundRun = {
        turn: ++session.nextTurn, message: clone(input.message), cancelled: false,
      }
      session.active = run
      const actorRun: ScenarioActorRun = { actor: delegated.actor, sessionId: input.sessionId, run, started: false, ended: false }
      delegated.scenario.actors.set(delegated.actor, actorRun)
      clearTimeout(delegated.timer)
      this.pendingDelegations.delete(delegated)
      this.emitStatus({ sessionId: input.sessionId, status: 'running' })
      setTimeout(() => this.emitClaimed({ sessionId: input.sessionId, messageId: input.message.id, turn: run.turn }), 0)
      delegated.resolve(actorRun)
      return 'accepted'
    }
    const scenario = this.scenarioFor(session, input.message)
    const runId = scenario === undefined ? undefined : await this.scenarioRunId(input.message.id, scenario.code)
    // Check the durable operation identity before queueing behind an active
    // turn. Otherwise a duplicate can enter the inbox after the first copy was
    // claimed, then remain pending forever when the queued driver submission
    // eventually discovers the completed run.
    if (runId !== undefined && this.seenScenarioRuns.has(runId)) return 'replayed'
    if (session.active !== undefined) {
      session.queue.push(clone(input.message))
      return 'accepted'
    }
    const run: PlaygroundRun = {
      turn: ++session.nextTurn, message: clone(input.message), cancelled: false,
    }
    session.active = run
    this.emitStatus({ sessionId: input.sessionId, status: 'running' })
    setTimeout(() => this.emitClaimed({ sessionId: input.sessionId, messageId: input.message.id, turn: run.turn }), 0)
    const text = textOf(input.message)
    // Defer past the admission continuation so the Host appends the user
    // message before any fixture turn/assistant fact is observed.
    if (scenario !== undefined && runId !== undefined) {
      this.seenScenarioRuns.add(runId)
      setTimeout(() => { void this.executeScenario(input.sessionId, run, runId, scenario.code, scenario.definition) }, 0)
    } else if (!text.includes('[pending]')) setTimeout(() => { void this.complete(input.sessionId, run, input.message) }, 0)
    return 'accepted'
  }

  async discard(input: { readonly sessionId: string; readonly messageId: MessageId }): Promise<'accepted' | 'not-found' | 'already-claimed'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'not-found'
    const index = session.queue.findIndex(message => message.id === input.messageId)
    if (session.active?.message.id === input.messageId) return 'already-claimed'
    if (index < 0) return 'not-found'
    session.queue.splice(index, 1)
    return 'accepted'
  }

  async cancel(input: { readonly sessionId: string; readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    const active = session?.active
    if (this.disposed || session === undefined || active === undefined) return 'unavailable'
    active.cancelled = true
    for (const scenario of this.scenarioRuns) {
      if ([...scenario.actors.values()].some(actor => actor.sessionId === input.sessionId)) scenario.scopeActivation?.close()
    }
    this.emit({ sessionId: input.sessionId, type: 'turn/end', data: { turn: active.turn, reason: { kind: 'interrupted' } } })
    delete session.active
    if (!input.keepInbox) session.queue.splice(0)
    this.emitStatus({ sessionId: input.sessionId, status: 'idle' })
    return 'accepted'
  }

  onSessionEvent(listener: (event: CordisXDriverSessionEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onApprovalRequest(listener: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  onAgentStatus(listener: (event: CordisXDriverAgentStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onMessageClaimed(listener: (event: CordisXDriverMessageClaimed) => void): () => void {
    this.claimedListeners.add(listener)
    return () => this.claimedListeners.delete(listener)
  }

  onReplacement(listener: () => void): () => void { this.replacements.add(listener); return () => this.replacements.delete(listener) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pendingDelegations) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Playground Session scenario transport was disposed'))
    }
    this.pendingDelegations.clear()
    for (const scenario of this.scenarioRuns) scenario.scopeActivation?.close()
    this.scenarioRuns.clear()
    this.sessions.clear(); this.replacements.clear(); this.eventListeners.clear(); this.approvalListeners.clear(); this.statusListeners.clear(); this.claimedListeners.clear()
  }

  private async complete(sessionId: string, run: PlaygroundRun, message: UserMessage): Promise<void> {
    if (this.disposed || run.cancelled || this.sessions.get(sessionId)?.active !== run) return
    const text = textOf(message)
    this.emit({ sessionId, type: 'turn/start', data: { turn: run.turn } })
    this.emit({ sessionId, type: 'step/start', data: { turn: run.turn, step: 1 } })
    let approval: ApprovalOutcome | undefined
    if (text.includes('[approval]')) approval = await this.ask({ sessionId, toolName: 'playground.fixture', reason: 'deterministic fixture approval' })
    if (this.disposed || run.cancelled || this.sessions.get(sessionId)?.active !== run) return
    if (text.includes('[tool]')) {
      const callId = `playground-tool:${sessionId}:${run.turn}`
      this.emit({ sessionId, type: 'tool/call', data: { turn: run.turn, step: 1, callId, name: 'playground.fixture.echo', arguments: JSON.stringify({ fixture: true, text }) } })
      this.emit({ sessionId, type: 'tool/result', data: {
        turn: run.turn, step: 1,
        message: { id: `playground-tool-result:${sessionId}:${run.turn}`, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'deterministic playground tool result' }] }], source: { kind: 'tool', callId } },
        meta: { fixture: 'deterministic-agent-session', deterministic: true },
      } })
    }
    const response = approval === undefined
      ? `Playground Agent/Session fixture reply: ${text || 'empty message'}`
      : `Playground Agent/Session fixture approval: ${approval}`
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'text-delta', index: 0, text: response } } })
    const block = { type: 'text' as const, text: response }
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'block-end', index: 0, block } } })
    this.emit({ sessionId, type: 'assistant/message', data: {
      turn: run.turn, step: 1,
      message: { id: `deterministic-assistant.${sessionId}.${run.turn}`, role: 'assistant', content: [block], source: { kind: 'model', provider: 'deterministic-agent-session', model: 'deterministic-v1', replayState: { fixture: true } } },
    } })
    this.emit({ sessionId, type: 'step/end', data: { turn: run.turn, step: 1 } })
    this.emit({ sessionId, type: 'turn/end', data: { turn: run.turn, reason: { kind: 'completed' } } })
    const session = this.sessions.get(sessionId)
    if (session?.active === run) delete session.active
    const next = session?.queue.shift()
    if (next === undefined) this.emitStatus({ sessionId, status: 'idle' })
    else void this.submit({ sessionId, message: next })
  }

  private scenarioFor(session: PlaygroundSessionState, message: UserMessage): { readonly code: string; readonly definition: PlaygroundSessionScenarioDefinition } | undefined {
    const catalog = this.scenarioCatalog
    if (catalog === undefined) return undefined
    const code = scenarioCodeOf(message)
    if (code === undefined) return undefined
    const definition = Object.hasOwn(catalog.scenarios, code) ? catalog.scenarios[code] : undefined
    if (definition === undefined || sessionAgentId(session.setup) !== definition.entryAgentId) return undefined
    return { code, definition }
  }

  private async scenarioRunId(messageId: string, code: string): Promise<string> {
    const input = new TextEncoder().encode(`cordisx.playground-session-scenario.v1\0${messageId}\0${this.scenarioCatalog?.revision ?? ''}\0${code}`)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
    const token = [...new Uint8Array(digest)].slice(0, 18).map(byte => byte.toString(16).padStart(2, '0')).join('')
    return `playground-scenario.${token}`
  }

  private pendingDelegation(session: PlaygroundSessionState, sessionId: string, message: UserMessage): PendingDelegation | undefined {
    const agentId = sessionAgentId(session.setup)
    const text = textOf(message)
    return [...this.pendingDelegations].find(pending => pending.targetAgentId === agentId
      && pending.task === text
      && !pending.scenario.actors.has(pending.actor)
      && [...pending.scenario.actors.values()].every(actor => actor.sessionId !== sessionId))
  }

  private async closeInterruptedScenario(sessionId: string, fact: PlaygroundSessionScenarioEventData): Promise<void> {
    if (this.disposed || !this.sessions.has(sessionId)) return
    await this.emitScenario(sessionId, {
      ...fact,
      phase: 'failed',
      error: {
        code: 'scenario-runtime-replaced',
        message: `Runtime generation was replaced during step ${fact.stepIndex}/${fact.stepCount}; send ${fact.code} again to retry safely.`,
      },
    })
    this.emitStatus({ sessionId, status: 'idle' })
  }

  private async executeScenario(
    leadSessionId: string,
    leadRun: PlaygroundRun,
    runId: string,
    code: string,
    definition: PlaygroundSessionScenarioDefinition,
  ): Promise<void> {
    const catalogRevision = this.scenarioCatalog?.revision
    if (catalogRevision === undefined) return
    const scenario: ScenarioRun = {
      runId, sourceMessageId: leadRun.message.id, code, catalogRevision,
      actors: new Map([['lead', { actor: 'lead', sessionId: leadSessionId, run: leadRun, started: false, ended: false }]]),
      toolCalls: new Map(), stepIndex: 0, stepCount: definition.steps.length,
    }
    this.scenarioRuns.add(scenario)
    await this.emitScenario(leadSessionId, this.scenarioFact(scenario, 'lead', 'started', 0))
    const queue = [...definition.steps]
    try {
      while (queue.length > 0) {
        const step = queue.shift()!
        scenario.stepIndex += 1
        scenario.stepCount = scenario.stepIndex + queue.length
        scenario.currentStep = step
        const actorName = step.actor ?? 'lead'
        if (scenario.scopeActivation !== undefined && !scenario.scopeActivation.active()) {
          throw new DeclaredScenarioFailure('scenario-session-scope-closed', 'The exact scenario Session scope was fenced before the next step.')
        }
        const actor = scenario.actors.get(actorName)
        if (actor === undefined) throw new Error(`Scenario actor ${actorName} is unavailable at step ${scenario.stepIndex}`)
        if (actor.run.cancelled) throw new DeclaredScenarioCancellation(`Scenario actor ${actorName} was cancelled`)
        await this.startScenarioActor(actor)
        await this.emitDurable({ sessionId: actor.sessionId, type: 'step/start', data: { turn: actor.run.turn, step: scenario.stepIndex } })
        await this.emitScenario(actor.sessionId, this.scenarioFact(scenario, actorName, 'step-started', scenario.stepIndex, step.type))
        const branch = await this.executeScenarioStep(scenario, actor, step)
        await this.emitScenario(actor.sessionId, this.scenarioFact(scenario, actorName, 'step-completed', scenario.stepIndex, step.type))
        await this.emitDurable({ sessionId: actor.sessionId, type: 'step/end', data: { turn: actor.run.turn, step: scenario.stepIndex } })
        if (branch.length > 0) {
          queue.unshift(...branch)
          scenario.stepCount += branch.length
        }
      }
      await this.emitScenario(leadSessionId, this.scenarioFact(scenario, 'lead', 'completed', scenario.stepIndex))
      await this.finishScenarioActors(scenario, { kind: 'completed' })
    } catch (error) {
      const cancelled = error instanceof DeclaredScenarioCancellation
      const failure = error instanceof DeclaredScenarioFailure
        ? { code: error.code, message: error.message }
        : { code: cancelled ? 'scenario-cancelled' : 'scenario-step-failed', message: error instanceof Error ? error.message : String(error) }
      await this.emitScenario(leadSessionId, {
        ...this.scenarioFact(scenario, 'lead', cancelled ? 'cancelled' : 'failed', scenario.stepIndex, scenario.currentStep?.type),
        error: failure,
      })
      await this.finishScenarioActors(scenario, cancelled
        ? { kind: 'aborted', reason: { kind: 'hook', reason: failure.message } }
        : { kind: 'error', error: { message: failure.message, code: failure.code, requestId: scenario.runId } })
    } finally {
      for (const pending of [...this.pendingDelegations]) if (pending.scenario === scenario) {
        clearTimeout(pending.timer)
        this.pendingDelegations.delete(pending)
      }
      for (const actor of scenario.actors.values()) this.releaseScenarioActor(actor)
      scenario.scopeActivation?.close()
      this.scenarioSessionScope?.release({
        sourceMessageId: scenario.sourceMessageId,
        sourceSessionId: leadSessionId,
        runId: scenario.runId,
      })
      this.scenarioRuns.delete(scenario)
    }
  }

  private async executeScenarioStep(
    scenario: ScenarioRun,
    actor: ScenarioActorRun,
    step: PlaygroundSessionScenarioStep,
  ): Promise<readonly PlaygroundSessionScenarioStep[]> {
    if (step.type === 'assistant-reply' || step.type === 'final-summary') {
      await this.emitScenarioAssistant(scenario, actor, step.text, step.stream !== false, step.type)
      return []
    }
    if (step.type === 'tool-call') {
      const key = `${actor.actor}\0${step.call}`
      if (scenario.toolCalls.has(key)) throw new Error(`Scenario tool call ${step.call} is duplicated for actor ${actor.actor}`)
      const callId = `${scenario.runId}.tool.${scenario.stepIndex}.${step.call}`
      scenario.toolCalls.set(key, { actor: actor.actor, callId, name: step.name })
      await this.emitDurable({
        sessionId: actor.sessionId, type: 'tool/call',
        data: { turn: actor.run.turn, step: scenario.stepIndex, callId, name: step.name, arguments: JSON.stringify(step.arguments ?? {}) },
      })
      return []
    }
    if (step.type === 'tool-result') {
      const call = scenario.toolCalls.get(`${actor.actor}\0${step.call}`)
      if (call === undefined) throw new Error(`Scenario tool result ${step.call} has no matching call for actor ${actor.actor}`)
      await this.emitDurable({ sessionId: actor.sessionId, type: 'tool/result', data: {
        turn: actor.run.turn, step: scenario.stepIndex,
        message: {
          id: `${scenario.runId}.tool-result.${scenario.stepIndex}.${step.call}`, role: 'user',
          content: [{ type: 'tool-result', toolCallId: call.callId, content: [{ type: 'text', text: step.content }], ...(step.error === undefined ? {} : { isError: true }) }],
          source: { kind: 'tool', callId: call.callId },
        },
        ...(step.error === undefined ? {} : { error: step.error }),
        meta: { source: 'playground-session-scenario', runId: scenario.runId, catalogRevision: scenario.catalogRevision, code: scenario.code, stepIndex: scenario.stepIndex },
      } })
      return []
    }
    if (step.type === 'approval-request') {
      const callId = `${scenario.runId}.approval.${scenario.stepIndex}.${step.request}`
      const outcome = await this.ask({
        sessionId: actor.sessionId, toolName: step.toolName, callId,
        ...(step.reason === undefined ? {} : { reason: step.reason }),
      })
      return step.branches?.[outcome] ?? []
    }
    if (step.type === 'room-delegation') {
      await this.delegateScenarioActor(scenario, actor, step)
      return []
    }
    if (step.type === 'activate-session-scope') {
      const client = this.scenarioSessionScope
      if (client === undefined) throw new DeclaredScenarioFailure(
        'scenario-session-scope-unavailable',
        'Playground scenario Session scope activation is unavailable.',
      )
      const lead = scenario.actors.get('lead')
      if (lead === undefined) throw new DeclaredScenarioFailure(
        'scenario-source-session-unavailable',
        'The scenario Lead Session is unavailable.',
      )
      const activated = await client.activate({
        runId: scenario.runId,
        sourceMessageId: scenario.sourceMessageId,
        sourceSessionId: lead.sessionId,
        targetSessionId: actor.sessionId,
      })
      if (activated.status !== 'available') throw new DeclaredScenarioFailure(
        `scenario-session-scope-${activated.code}`,
        activated.message,
      )
      scenario.scopeActivation?.close()
      scenario.scopeActivation = activated.handle
      return []
    }
    if (step.type === 'followup') {
      const inserted: UserMessage = {
        id: `${scenario.runId}.followup.${scenario.stepIndex}`, role: 'user', content: [{ type: 'text', text: step.text }],
        source: {
          kind: 'plugin', pluginId: 'host.playground-session-scenario', generation: 1, form: 'instructions',
          summary: `Scenario ${scenario.code} followup`, correlation: { namespace: 'cordisx.playground-session-scenario/v1', id: scenario.runId },
        },
      }
      await this.emitDurable({ sessionId: actor.sessionId, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [inserted] } })
      return []
    }
    if (step.type === 'failure') throw new DeclaredScenarioFailure(step.code, step.message)
    if (step.type === 'cancel') throw new DeclaredScenarioCancellation(step.reason)
    throw new Error(`Scenario step ${(step as PlaygroundSessionScenarioStep).type} is unsupported`)
  }

  private async delegateScenarioActor(
    scenario: ScenarioRun,
    actor: ScenarioActorRun,
    step: Extract<PlaygroundSessionScenarioStep, { readonly type: 'room-delegation' }>,
  ): Promise<void> {
    if (scenario.actors.has(step.as)) throw new Error(`Scenario actor ${step.as} is already bound`)
    const bridge = this.roomBridge
    if (bridge === undefined) throw new Error('Playground Room simulation bridge is unavailable')
    const resolved = await bridge.resolveSession(actor.sessionId)
    if (resolved.status !== 'available') throw new Error(`Room binding resolution failed: ${resolved.code} — ${resolved.message}`)
    const inspected = await bridge.inspect(resolved.value)
    if (inspected.status !== 'available') throw new Error(`Room inspection failed: ${inspected.code} — ${inspected.message}`)
    if (!inspected.value.delegationTargets.some(target => target.memberId === step.memberId)) {
      throw new Error(`Room delegation target ${step.memberId} is unavailable`)
    }
    const operationId = `${scenario.runId}.delegate.${scenario.stepIndex}.${step.as}`
    const callId = `${scenario.runId}.room-delegation.${scenario.stepIndex}.${step.as}`
    await this.emitDurable({ sessionId: actor.sessionId, type: 'tool/call', data: {
      turn: actor.run.turn, step: scenario.stepIndex, callId, name: 'playground.room.delegate',
      arguments: JSON.stringify({ memberId: step.memberId, targetAgentId: step.targetAgentId, task: step.task, operationId }),
    } })
    if ([...this.pendingDelegations].some(pending => pending.targetAgentId === step.targetAgentId && pending.task === step.task)) {
      throw new Error(`Concurrent Room delegation for ${step.targetAgentId} and the same task is ambiguous`)
    }
    let pending!: PendingDelegation
    const claimed = new Promise<ScenarioActorRun>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDelegations.delete(pending)
        reject(new Error(`Delegated Agent Session ${step.as} was not admitted within ${this.delegationTimeoutMs}ms`))
      }, this.delegationTimeoutMs)
      pending = { scenario, actor: step.as, targetAgentId: step.targetAgentId, task: step.task, resolve, reject, timer }
      this.pendingDelegations.add(pending)
    })
    void claimed.catch(() => undefined)
    let delegated: Awaited<ReturnType<PlaygroundRoomSimulationForwardingClient['delegateTask']>>
    try {
      delegated = await bridge.delegateTask(resolved.value, operationId, { memberId: step.memberId, task: step.task })
      if (delegated.status !== 'available') throw new Error(`Room delegation failed: ${delegated.code} — ${delegated.message}`)
      if (delegated.value.phase === 'failed' || delegated.value.phase === 'rejected') {
        throw new Error(`Room delegation ${operationId} ${delegated.value.phase}`)
      }
    } catch (error) {
      clearTimeout(pending.timer)
      this.pendingDelegations.delete(pending)
      throw error
    }
    const delegatedActor = await claimed
    await this.emitDurable({ sessionId: actor.sessionId, type: 'tool/result', data: {
      turn: actor.run.turn, step: scenario.stepIndex,
      message: {
        id: `${scenario.runId}.room-delegation-result.${scenario.stepIndex}`, role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `Delegated to ${step.memberId} as ${step.as} (${delegatedActor.sessionId}).` }] }],
        source: { kind: 'tool', callId },
      },
      meta: { source: 'playground-session-scenario', runId: scenario.runId, operationId, targetSessionId: delegatedActor.sessionId, replayed: delegated.value.replayed === true },
    } })
  }

  private async startScenarioActor(actor: ScenarioActorRun): Promise<void> {
    if (actor.started) return
    actor.started = true
    await this.emitDurable({ sessionId: actor.sessionId, type: 'turn/start', data: { turn: actor.run.turn } })
  }

  private async emitScenarioAssistant(
    scenario: ScenarioRun,
    actor: ScenarioActorRun,
    text: string,
    stream: boolean,
    kind: 'assistant-reply' | 'final-summary',
  ): Promise<void> {
    const block = { type: 'text' as const, text }
    if (stream) {
      await this.emitDurable({ sessionId: actor.sessionId, type: 'assistant/chunk', data: { turn: actor.run.turn, step: scenario.stepIndex, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
      await this.emitDurable({ sessionId: actor.sessionId, type: 'assistant/chunk', data: { turn: actor.run.turn, step: scenario.stepIndex, chunk: { type: 'text-delta', index: 0, text } } })
      await this.emitDurable({ sessionId: actor.sessionId, type: 'assistant/chunk', data: { turn: actor.run.turn, step: scenario.stepIndex, chunk: { type: 'block-end', index: 0, block } } })
    }
    await this.emitDurable({ sessionId: actor.sessionId, type: 'assistant/message', data: {
      turn: actor.run.turn, step: scenario.stepIndex,
      message: {
        id: `${scenario.runId}.assistant.${scenario.stepIndex}.${actor.actor}`, role: 'assistant', content: [block],
        source: {
          kind: 'model', provider: 'deterministic-agent-session', model: scenarioModelPrefix,
          replayState: { source: 'playground-session-scenario', runId: scenario.runId, catalogRevision: scenario.catalogRevision, code: scenario.code, stepIndex: scenario.stepIndex, kind },
        },
      },
    } })
  }

  private scenarioFact(
    scenario: ScenarioRun,
    actor: string,
    phase: PlaygroundSessionScenarioEventData['phase'],
    stepIndex: number,
    stepType?: PlaygroundSessionScenarioStep['type'],
  ): PlaygroundSessionScenarioEventData {
    return {
      runId: scenario.runId, sourceMessageId: scenario.sourceMessageId,
      catalogRevision: scenario.catalogRevision, code: scenario.code, actor, phase,
      stepIndex, stepCount: scenario.stepCount,
      ...(stepType === undefined ? {} : { stepType }),
    }
  }

  private async emitScenario(sessionId: string, data: PlaygroundSessionScenarioEventData): Promise<void> {
    await this.emitDurable({ sessionId, type: PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE, data, ignorable: true })
  }

  private async finishScenarioActors(
    scenario: ScenarioRun,
    reason: Extract<SessionEvent, { readonly type: 'turn/end' }>['data']['reason'],
  ): Promise<void> {
    for (const actor of scenario.actors.values()) {
      if (!actor.started) await this.startScenarioActor(actor)
      if (actor.ended) continue
      actor.ended = true
      await this.emitDurable({ sessionId: actor.sessionId, type: 'turn/end', data: { turn: actor.run.turn, reason } })
    }
  }

  private releaseScenarioActor(actor: ScenarioActorRun): void {
    const session = this.sessions.get(actor.sessionId)
    if (session?.active !== actor.run) return
    delete session.active
    const next = session.queue.shift()
    if (next === undefined) this.emitStatus({ sessionId: actor.sessionId, status: 'idle' })
    else void this.submit({ sessionId: actor.sessionId, message: next })
  }

  private async ask(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome> {
    for (const listener of this.approvalListeners) return await listener(clone(request))
    return 'unavailable'
  }

  private emit(event: CordisXDriverSessionEvent): void {
    for (const listener of [...this.eventListeners]) listener(clone(event))
  }

  private async emitDurable(event: CordisXDriverSessionEvent): Promise<void> {
    const deliveries = [...this.eventListeners].map(async listener => await listener(clone(event)))
    await Promise.all(deliveries)
  }

  private emitStatus(event: CordisXDriverAgentStatus): void {
    for (const listener of [...this.statusListeners]) listener(clone(event))
  }

  private emitClaimed(event: CordisXDriverMessageClaimed): void {
    if (this.disposed) return
    for (const listener of [...this.claimedListeners]) listener(clone(event))
  }
}
