import type { ApprovalOutcome, JsonValue } from '@cordisx/protocol/sessions/v1'

export const PLAYGROUND_SESSION_SCENARIO_CATALOG_VERSION = 1 as const
export const PLAYGROUND_SESSION_SCENARIO_EVENT_TYPE = 'playground/scenario' as const

export type PlaygroundSessionScenarioActor = 'lead' | string

interface PlaygroundSessionScenarioStepBase {
  readonly actor?: PlaygroundSessionScenarioActor
}

export type PlaygroundSessionScenarioStep =
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'assistant-reply' | 'final-summary'
    readonly text: string
    readonly stream?: boolean
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'tool-call'
    readonly call: string
    readonly name: string
    readonly arguments?: JsonValue
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'tool-result'
    readonly call: string
    readonly content: string
    readonly error?: { readonly name: string; readonly code: string }
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'approval-request'
    readonly request: string
    readonly toolName: string
    readonly reason?: string
    readonly branches?: Readonly<Partial<Record<ApprovalOutcome, readonly PlaygroundSessionScenarioStep[]>>>
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'room-delegation'
    readonly as: string
    readonly memberId: string
    readonly targetAgentId: string
    readonly task: string
  })
  | {
    /** Host resolves this actor to the exact Session admitted by a prior delegation. */
    readonly type: 'activate-session-scope'
    readonly actor: PlaygroundSessionScenarioActor
  }
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'followup'
    readonly text: string
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'failure'
    readonly message: string
    readonly code: string
  })
  | (PlaygroundSessionScenarioStepBase & {
    readonly type: 'cancel'
    readonly reason: string
  })

export interface PlaygroundSessionScenarioDefinition {
  readonly entryAgentId: string
  readonly label?: string
  readonly steps: readonly PlaygroundSessionScenarioStep[]
}

export interface PlaygroundSessionScenarioCatalogV1 {
  readonly version: typeof PLAYGROUND_SESSION_SCENARIO_CATALOG_VERSION
  readonly revision: string
  readonly enabled: boolean
  readonly scenarios: Readonly<Record<string, PlaygroundSessionScenarioDefinition>>
}

export interface PlaygroundSessionScenarioEventData {
  readonly runId: string
  readonly sourceMessageId: string
  readonly catalogRevision: string
  readonly code: string
  readonly actor: string
  readonly phase: 'started' | 'step-started' | 'step-completed' | 'completed' | 'failed' | 'cancelled'
  readonly stepIndex: number
  readonly stepCount: number
  readonly stepType?: PlaygroundSessionScenarioStep['type']
  readonly error?: { readonly message: string; readonly code: string }
}

declare module '@cordisx/protocol/sessions/v1' {
  interface SessionEventDataMap {
    /** Host-private, ignorable progress fact emitted only by an explicit Playground catalog. */
    'playground/scenario': PlaygroundSessionScenarioEventData
  }
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u
const ACTOR = /^[a-z][a-z0-9._-]{0,31}$/u
const MAX_SCENARIOS = 64
const MAX_STEPS = 256
const MAX_BRANCH_DEPTH = 4
const MAX_TEXT = 16_384
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function boundedString(value: unknown, label: string, maximum = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function handle(value: unknown, label: string): string {
  const output = boundedString(value, label, 128)
  if (!HANDLE.test(output)) throw new Error(`${label} is invalid`)
  return output
}

function actor(value: unknown, label: string): string {
  const output = boundedString(value, label, 32)
  if (!ACTOR.test(output)) throw new Error(`${label} is invalid`)
  return output
}

function json(value: unknown, label: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} must be lossless JSON`)
  if (seen.has(value)) throw new Error(`${label} is circular`)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be plain JSON`)
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item, index) => json(item, `${label}[${index}]`, seen))
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains a reserved key`)
      }
      output[key] = json(item, `${label}.${key}`, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function optionalActor(value: Record<string, unknown>, label: string): { readonly actor?: string } {
  return value.actor === undefined ? {} : { actor: actor(value.actor, `${label}.actor`) }
}

function parseSteps(
  value: unknown,
  label: string,
  budget: { count: number },
  depth = 0,
): readonly PlaygroundSessionScenarioStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  if (depth > MAX_BRANCH_DEPTH) throw new Error(`${label} exceeds the branch depth limit`)
  const steps = value.map((candidate, index): PlaygroundSessionScenarioStep => {
    budget.count += 1
    if (budget.count > MAX_STEPS) throw new Error(`${label} exceeds the ${MAX_STEPS}-step limit`)
    const stepLabel = `${label}[${index}]`
    const item = object(candidate, stepLabel)
    const type = item.type
    const withActor = optionalActor(item, stepLabel)
    if (type === 'assistant-reply' || type === 'final-summary') {
      exactKeys(item, ['type', 'actor', 'text', 'stream'], stepLabel)
      if (item.stream !== undefined && typeof item.stream !== 'boolean') {
        throw new Error(`${stepLabel}.stream must be a boolean`)
      }
      return Object.freeze({
        type,
        ...withActor,
        text: boundedString(item.text, `${stepLabel}.text`),
        ...(item.stream === undefined ? {} : { stream: item.stream }),
      })
    }
    if (type === 'tool-call') {
      exactKeys(item, ['type', 'actor', 'call', 'name', 'arguments'], stepLabel)
      return Object.freeze({
        type,
        ...withActor,
        call: handle(item.call, `${stepLabel}.call`),
        name: handle(item.name, `${stepLabel}.name`),
        ...(item.arguments === undefined ? {} : { arguments: json(item.arguments, `${stepLabel}.arguments`) }),
      })
    }
    if (type === 'tool-result') {
      exactKeys(item, ['type', 'actor', 'call', 'content', 'error'], stepLabel)
      let error: { readonly name: string; readonly code: string } | undefined
      if (item.error !== undefined) {
        const input = object(item.error, `${stepLabel}.error`)
        exactKeys(input, ['name', 'code'], `${stepLabel}.error`)
        error = Object.freeze({
          name: handle(input.name, `${stepLabel}.error.name`),
          code: handle(input.code, `${stepLabel}.error.code`),
        })
      }
      return Object.freeze({
        type,
        ...withActor,
        call: handle(item.call, `${stepLabel}.call`),
        content: boundedString(item.content, `${stepLabel}.content`),
        ...(error === undefined ? {} : { error }),
      })
    }
    if (type === 'approval-request') {
      exactKeys(item, ['type', 'actor', 'request', 'toolName', 'reason', 'branches'], stepLabel)
      let branches: Partial<Record<ApprovalOutcome, readonly PlaygroundSessionScenarioStep[]>> | undefined
      if (item.branches !== undefined) {
        const input = object(item.branches, `${stepLabel}.branches`)
        exactKeys(input, OUTCOMES, `${stepLabel}.branches`)
        branches = Object.create(null) as Partial<Record<ApprovalOutcome, readonly PlaygroundSessionScenarioStep[]>>
        for (const outcome of OUTCOMES) {
          if (input[outcome] !== undefined) {
            branches[outcome] = parseSteps(input[outcome], `${stepLabel}.branches.${outcome}`, budget, depth + 1)
          }
        }
      }
      return Object.freeze({
        type,
        ...withActor,
        request: handle(item.request, `${stepLabel}.request`),
        toolName: handle(item.toolName, `${stepLabel}.toolName`),
        ...(item.reason === undefined ? {} : { reason: boundedString(item.reason, `${stepLabel}.reason`) }),
        ...(branches === undefined ? {} : { branches: Object.freeze(branches) }),
      })
    }
    if (type === 'room-delegation') {
      exactKeys(item, ['type', 'actor', 'as', 'memberId', 'targetAgentId', 'task'], stepLabel)
      const alias = actor(item.as, `${stepLabel}.as`)
      if (alias === 'lead') throw new Error(`${stepLabel}.as cannot replace the lead actor`)
      return Object.freeze({
        type,
        ...withActor,
        as: alias,
        memberId: handle(item.memberId, `${stepLabel}.memberId`),
        targetAgentId: handle(item.targetAgentId, `${stepLabel}.targetAgentId`),
        task: boundedString(item.task, `${stepLabel}.task`),
      })
    }
    if (type === 'activate-session-scope') {
      exactKeys(item, ['type', 'actor'], stepLabel)
      if (item.actor === undefined) throw new Error(`${stepLabel}.actor is required`)
      return Object.freeze({ type, actor: actor(item.actor, `${stepLabel}.actor`) })
    }
    if (type === 'followup') {
      exactKeys(item, ['type', 'actor', 'text'], stepLabel)
      return Object.freeze({ type, ...withActor, text: boundedString(item.text, `${stepLabel}.text`) })
    }
    if (type === 'failure') {
      exactKeys(item, ['type', 'actor', 'message', 'code'], stepLabel)
      return Object.freeze({
        type,
        ...withActor,
        message: boundedString(item.message, `${stepLabel}.message`),
        code: handle(item.code, `${stepLabel}.code`),
      })
    }
    if (type === 'cancel') {
      exactKeys(item, ['type', 'actor', 'reason'], stepLabel)
      return Object.freeze({ type, ...withActor, reason: boundedString(item.reason, `${stepLabel}.reason`, 512) })
    }
    throw new Error(`${stepLabel}.type is unsupported`)
  })
  return Object.freeze(steps)
}

/** Strict Host-only parser for an explicit Playground fixture catalog. */
export function parsePlaygroundSessionScenarioCatalog(value: unknown): PlaygroundSessionScenarioCatalogV1 | undefined {
  if (value === undefined) return undefined
  const root = object(value, 'playground.sessionScenarios')
  exactKeys(root, ['version', 'revision', 'enabled', 'scenarios'], 'playground.sessionScenarios')
  if (root.version !== PLAYGROUND_SESSION_SCENARIO_CATALOG_VERSION) {
    throw new Error('playground.sessionScenarios.version must be 1')
  }
  if (typeof root.enabled !== 'boolean') throw new Error('playground.sessionScenarios.enabled must be a boolean')
  const revision = handle(root.revision, 'playground.sessionScenarios.revision')
  const input = object(root.scenarios, 'playground.sessionScenarios.scenarios')
  const entries = Object.entries(input)
  if (entries.length > MAX_SCENARIOS) {
    throw new Error(`playground.sessionScenarios.scenarios exceeds the ${MAX_SCENARIOS}-scenario limit`)
  }
  const scenarios: Record<string, PlaygroundSessionScenarioDefinition> = Object.create(null) as Record<
    string,
    PlaygroundSessionScenarioDefinition
  >
  for (const [code, candidate] of entries) {
    if (!CODE.test(code)) {
      throw new Error(`playground.sessionScenarios.scenarios code ${JSON.stringify(code)} is invalid`)
    }
    const label = `playground.sessionScenarios.scenarios.${code}`
    const item = object(candidate, label)
    exactKeys(item, ['entryAgentId', 'label', 'steps'], label)
    const budget = { count: 0 }
    scenarios[code] = Object.freeze({
      entryAgentId: handle(item.entryAgentId, `${label}.entryAgentId`),
      ...(item.label === undefined ? {} : { label: boundedString(item.label, `${label}.label`, 128) }),
      steps: parseSteps(item.steps, `${label}.steps`, budget),
    })
  }
  return Object.freeze({ version: 1, revision, enabled: root.enabled, scenarios: Object.freeze(scenarios) })
}
