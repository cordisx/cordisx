import type { AgentDefinition } from '@cordisx/protocol/agents/v1'
import type { ContentBlock, SessionEvent } from '@cordisx/protocol/sessions/v1'
import { CORDISX_AGENT_DEFINITION_SCHEMA_V1 } from '../agent-loop-contracts.js'
import type { CordisXAgentSessionProjection } from './agent-session-runtime.js'
import type { CordisXResolvedAgentDefinition } from './agent-loop.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  type PlaygroundMockAgentLoopSnapshot,
  type PlaygroundMockTaskTrace,
  type PlaygroundMockTraceLayer,
} from './playground-mock-agent-loop.js'

const clone = <Value>(value: Value): Value => structuredClone(value)

function stableIdentity(sessionId: string, sessionGeneration: number): AgentDefinition['identity'] {
  let hash = 2166136261
  for (const character of sessionId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return Object.freeze({ agentId: `playground.agent-session.${hash.toString(36)}`, revision: `session-${sessionGeneration}` })
}

function fallbackDefinition(session: CordisXAgentSessionProjection): AgentDefinition {
  const definition: AgentDefinition = {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: stableIdentity(session.sessionId, session.sessionGeneration),
    name: `Agent / Session ${session.sessionId}`,
    description: 'Recovered Playground Agent/Session authority.',
    inherit: {
      promptSections: 'none', rules: 'none', skills: 'none', tools: 'none',
      mcpServers: 'none', runtimeDefaults: 'none', avatar: 'none',
    },
    promptSections: [], rules: [], skills: [], tools: {}, mcpServers: {},
    runtimeDefaults: { adapterId: 'deterministic-agent-session' },
  }
  return Object.freeze(definition)
}

function resolvedDefinition(value: CordisXResolvedAgentDefinition): AgentDefinition {
  const definition: AgentDefinition = {
    $schema: value.$schema,
    contract: value.contract,
    schemaVersion: value.schemaVersion,
    identity: clone(value.identity),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.avatar === undefined ? {} : { avatar: clone(value.avatar) }),
    inherit: {
      promptSections: 'none', rules: 'none', skills: 'none', tools: 'none',
      mcpServers: 'none', runtimeDefaults: 'none', avatar: 'none',
    },
    ...(value.promptSections === undefined ? {} : { promptSections: clone(value.promptSections) }),
    ...(value.rules === undefined ? {} : { rules: clone(value.rules) }),
    ...(value.skills === undefined ? {} : { skills: clone(value.skills) }),
    ...(value.tools === undefined ? {} : { tools: clone(value.tools) }),
    ...(value.mcpServers === undefined ? {} : { mcpServers: clone(value.mcpServers) }),
    ...(value.runtimeDefaults === undefined ? {} : { runtimeDefaults: clone(value.runtimeDefaults) }),
  }
  return Object.freeze(definition)
}

function traceLayer(definition: AgentDefinition): PlaygroundMockTraceLayer {
  return Object.freeze({
    identity: clone(definition.identity),
    promptSections: clone(definition.promptSections),
    rules: clone(definition.rules),
    skills: clone(definition.skills),
    tools: clone(definition.tools),
    mcpServers: clone(definition.mcpServers),
    runtimeDefaults: clone(definition.runtimeDefaults),
  })
}

function textContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' || block.type === 'reasoning'
    ? [block.text]
    : block.type === 'tool-call'
      ? [`${block.name}(${block.arguments})`]
      : block.type === 'tool-result'
        ? [textContent(block.content)]
        : [`[image: ${block.alt ?? block.ref}]`]).filter(Boolean).join('\n')
}

function eventType(event: SessionEvent): PlaygroundMockTaskTrace['events'][number]['type'] {
  if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'approval/decided') return 'semantic.message'
  if (event.type === 'approval/asked') return 'approval.required'
  if (event.type === 'tool/call') return 'tool.call'
  if (event.type === 'tool/result') return 'tool.result'
  if (event.type === 'turn/start') return 'execution.started'
  if (event.type === 'turn/end') return event.data.reason.kind === 'completed' ? 'execution.completed' : 'execution.failed'
  return 'session.event'
}

function compact(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function eventDetail(event: SessionEvent, toolNames: ReadonlyMap<string, string>): string {
  switch (event.type) {
    case 'user/message': return textContent(event.data.content) || `User message ${event.data.id}`
    case 'assistant/message': return textContent(event.data.message.content) || `Assistant message ${event.data.message.id}`
    case 'assistant/chunk': return `Assistant stream chunk: ${event.data.chunk.type}`
    case 'tool/call': {
      const argumentsPreview = compact(event.data.arguments)
      return `Tool use · ${event.data.name} · ${event.data.callId}${argumentsPreview === '' ? '' : ` · ${argumentsPreview}`}`
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const toolName = toolNames.get(callId) ?? 'unknown tool'
      const result = compact(textContent(event.data.message.content))
      const error = event.data.error === undefined ? undefined : `${event.data.error.name}/${event.data.error.code}`
      return `${error === undefined ? 'Tool result' : 'Tool error'} · ${toolName} · ${callId}${error === undefined ? '' : ` · ${error}`}${result === '' ? '' : ` · ${result}`}`
    }
    case 'approval/asked': return `Approval requested: ${event.data.toolName}${event.data.reason === undefined ? '' : ` — ${event.data.reason}`}`
    case 'approval/decided': return `Approval ${event.data.id}: ${event.data.outcome}`
    case 'turn/start': return `Turn ${event.data.turn} started.`
    case 'turn/end': return `Turn ${event.data.turn} ended: ${event.data.reason.kind}.`
    case 'step/start': return `Turn ${event.data.turn}, step ${event.data.step} started.`
    case 'step/end': return `Turn ${event.data.turn}, step ${event.data.step} ended.`
    case 'request/header': return `Request header: ${event.data.reason}.`
    case 'request/context': return `Request context: ${event.data.provider}/${event.data.model}.`
    case 'agent/inbox/spliced': return `Agent inbox ${event.data.target} changed.`
    case 'session/end-seed': return 'Session seed ended.'
    case 'playground/scenario': return event.data.phase === 'failed' || event.data.phase === 'cancelled'
      ? `Scenario ${event.data.code} · step ${event.data.stepIndex}/${event.data.stepCount} · ${event.data.phase} · ${event.data.error?.message ?? 'no detail'}`
      : `Scenario ${event.data.code} · step ${event.data.stepIndex}/${event.data.stepCount} · ${event.data.phase}${event.data.stepType === undefined ? '' : ` · ${event.data.stepType}`}`
  }
  return `Session event: ${event.type}`
}

function eventTurn(event: SessionEvent): string | undefined {
  return 'turn' in event.data && typeof event.data.turn === 'number' ? String(event.data.turn) : undefined
}

function eventMessageId(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') return event.data.id
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message.id
  return undefined
}

function eventOperationId(event: SessionEvent): string | undefined {
  if (event.type === 'tool/call') return event.data.callId
  if (event.type === 'tool/result') return event.data.message.source.callId
  if (event.type === 'approval/asked' || event.type === 'approval/decided') return event.data.id
  return undefined
}

function projectEvent(event: SessionEvent, toolNames: ReadonlyMap<string, string>): PlaygroundMockTaskTrace['events'][number] {
  const operationId = eventOperationId(event)
  const turn = eventTurn(event)
  const messageId = eventMessageId(event)
  return Object.freeze({
    sequence: event.seq,
    type: eventType(event),
    detail: eventDetail(event, toolNames),
    sessionEvent: clone(event),
    ...(operationId === undefined ? {} : { operationId }),
    ...(turn === undefined ? {} : { turn }),
    ...(messageId === undefined ? {} : { messageId }),
  })
}

function status(session: CordisXAgentSessionProjection): PlaygroundMockTaskTrace['status'] {
  if (session.closed !== undefined) return session.closed === 'connection-replaced' ? 'closed' : 'error'
  if (session.agent?.status === 'running') return 'working'
  const pendingApprovals = new Set<string>()
  for (const event of session.events) {
    if (event.type === 'approval/asked') pendingApprovals.add(event.data.id)
    else if (event.type === 'approval/decided') pendingApprovals.delete(event.data.id)
  }
  if (pendingApprovals.size > 0) return 'approval'
  const scenario = [...session.events].reverse().find(event => event.type === 'playground/scenario')
  if (scenario?.type === 'playground/scenario') {
    if (scenario.data.phase === 'failed') return 'error'
    if (scenario.data.phase === 'cancelled') return 'closed'
    if (scenario.data.phase === 'started' || scenario.data.phase === 'step-started' || scenario.data.phase === 'step-completed') return 'working'
  }
  const terminal = [...session.events].reverse().find(event => event.type === 'turn/end')
  if (terminal?.type === 'turn/end') {
    if (terminal.data.reason.kind === 'completed') return 'completed'
    if (terminal.data.reason.kind === 'interrupted' || terminal.data.reason.kind === 'aborted') return 'closed'
    if (terminal.data.reason.kind === 'blocked') return 'approval'
    return 'error'
  }
  return session.events.length === 0 ? 'created' : 'working'
}

function projectTask(session: CordisXAgentSessionProjection): PlaygroundMockTaskTrace {
  const definitions = (session.agent?.definitions ?? session.setup?.definitions)?.map(resolvedDefinition) ?? []
  const fallback = fallbackDefinition(session)
  const target = session.agent?.definition ?? session.setup?.definition
  const selected = definitions.find(definition => definition.identity.agentId === target?.agentId
    && definition.identity.revision === target.revision) ?? definitions.at(-1) ?? fallback
  const catalog = definitions.length === 0 ? [fallback] : definitions
  const lastInput = [...session.events].reverse().find(event => event.type === 'user/message')
  const toolNames = new Map(session.events.flatMap(event => event.type === 'tool/call'
    ? [[event.data.callId, event.data.name] as const]
    : []))
  const scenario = [...session.events].reverse().find(event => event.type === 'playground/scenario')
  return Object.freeze({
    taskRef: session.sessionId,
    origin: 'agent-session',
    sessionId: session.sessionId,
    sessionGeneration: session.sessionGeneration,
    ...(session.agent === undefined ? {} : { agentGeneration: session.agent.generation }),
    ...(session.agent?.detail === undefined ? {} : { agentDetail: clone(session.agent.detail) }),
    debugTaskId: session.sessionId,
    detailsUrl: Object.freeze({
      url: `app://-/playground/simulator/tasks/${encodeURIComponent(session.sessionId)}`,
      target: 'host' as const,
    }),
    agentLabel: selected.name ?? selected.identity.agentId,
    active: session.closed === undefined && session.agent !== undefined,
    status: status(session),
    ...(scenario?.type === 'playground/scenario' ? { scenario: clone(scenario.data) } : {}),
    identity: clone(selected.identity),
    catalog: Object.freeze(catalog.map(clone)),
    layers: Object.freeze(catalog.map(traceLayer)),
    effective: traceLayer(selected),
    ...(lastInput?.type === 'user/message' ? { input: textContent(lastInput.data.content) } : {}),
    events: Object.freeze(session.events.map(event => projectEvent(event, toolNames))),
  })
}

/**
 * Projects native Playground task UI directly from the Session authority. The
 * result is disposable display state; restart recovery comes only from the
 * Host-owned Session authority store supplied to the authority.
 */
export function projectPlaygroundAgentSessions(
  sessions: readonly CordisXAgentSessionProjection[],
): PlaygroundMockAgentLoopSnapshot | undefined {
  if (sessions.length === 0) return undefined
  const tasks = new Map<string, PlaygroundMockTaskTrace>()
  for (const session of sessions) tasks.set(session.sessionId, projectTask(session))
  return Object.freeze({ namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, label: 'Mock / Simulator', tasks: Object.freeze([...tasks.values()]) })
}
