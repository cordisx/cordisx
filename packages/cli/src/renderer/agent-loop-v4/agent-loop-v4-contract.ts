import type { Disposable } from '@deepseek-ai/cordis'
import type {
  AgentLoopAuthorizationOutcome,
  AgentLoopResult,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4'
import {
  CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
} from '../../agent-loop-contracts.js'
import type { CordisXResolvedAgentDefinition } from '../agent-loop.js'
import type { CordisXAgentLoopV4Scope } from '../provider-binding.js'

export type Command =
  | Parameters<BoundAgentLoopClient['createOrBind']>[0]
  | Parameters<BoundAgentLoopClient['send']>[0]
  | Parameters<BoundAgentLoopClient['decideApproval']>[0]
  | Parameters<BoundAgentLoopClient['requestMemberSelfIntroduction']>[0]
  | Parameters<BoundAgentLoopClient['cancelMemberSelfIntroduction']>[0]

export type CreateCommand = Parameters<BoundAgentLoopClient['createOrBind']>[0]

export type SendCommand = Parameters<BoundAgentLoopClient['send']>[0]

export type ApprovalCommand = Parameters<BoundAgentLoopClient['decideApproval']>[0]

export type IntroductionCommand = Parameters<BoundAgentLoopClient['requestMemberSelfIntroduction']>[0]

export type CancelIntroductionCommand = Parameters<BoundAgentLoopClient['cancelMemberSelfIntroduction']>[0]

export type Capability = AgentLoopAuthorizationOutcome['capability']

export interface InternalResult {
  readonly status?: unknown
  readonly code?: unknown
  readonly delivery?: unknown
  readonly locator?: {
    readonly task?: unknown
    readonly definition?: unknown
    readonly binding?: unknown
  }
  readonly detailsUrl?: unknown
  readonly turn?: unknown
  readonly messageId?: unknown
  readonly approvalId?: unknown
  readonly decision?: unknown
}

export interface InternalLifecycleEvent {
  readonly eventId?: unknown
  readonly sequence?: unknown
  readonly turnId?: unknown
  readonly type?: unknown
  readonly output?: unknown
  readonly failure?: unknown
  readonly approval?: unknown
  readonly causation?: unknown
  readonly introduction?: unknown
  readonly cancellation?: unknown
  readonly observedAt?: unknown
}

export interface InternalLifecycleResult {
  readonly status?: unknown
  readonly code?: unknown
  readonly nextAfterSequence?: unknown
  readonly events?: unknown
}

export interface PromptRegistration {
  readonly key: string
  readonly disposers: readonly Disposable<void>[]
  refCount: number
  disposed: boolean
}

/**
 * Host-owned identity presentation derived only from the accepted effective
 * definition.  Conversation Shell identity actions must use the same v4
 * definition catalog as the task that emitted the assistant event; falling
 * back to the legacy v2 broker silently drops identity for v4-only runs.
 */
export interface CordisXAgentDefinitionPresentation {
  readonly identity: Readonly<{ readonly agentId: string; readonly revision: string }>
  readonly name: string
  readonly introduction: string
}

export function definitionPresentationKey(identity: { readonly agentId: string; readonly revision: string }): string {
  return `${identity.agentId}\u0000${identity.revision}`
}

export function presentationForDefinition(
  definition: CordisXResolvedAgentDefinition,
): CordisXAgentDefinitionPresentation {
  const introduction = (definition.promptSections ?? [])
    .filter(section => section.kind === 'introduction')
    .map(section => section.text.trim())
    .filter(Boolean)
    .join('\n\n')
  return Object.freeze({
    identity: Object.freeze({ ...definition.identity }),
    name: definition.name ?? definition.identity.agentId,
    introduction,
  })
}

export interface AgentLoopV4Transport {
  readonly debugMock?: true
  createAgentLoopV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly definition: { readonly agentId: string; readonly revision: string }
      readonly model: { readonly providerId: string; readonly modelId: string }
      readonly cwd: string
      readonly developerInstructions?: string
      readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
    },
  ): Promise<unknown>
  bindAgentLoopV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly task: string
      readonly definition: { readonly agentId: string; readonly revision: string }
    },
  ): Promise<unknown>
  sendAgentLoopV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
      readonly message: string
    },
  ): Promise<unknown>
  decideAgentLoopApprovalV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
      readonly turn: string
      readonly approvalId: string
      readonly decision: 'approved' | 'denied' | 'cancelled'
    },
  ): Promise<unknown>
  requestAgentLoopIntroductionV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
      readonly participantId: string
      readonly memberId: string
      readonly runId: string
    },
  ): Promise<unknown>
  cancelAgentLoopIntroductionV4(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly command: unknown
      readonly operationId: string
      readonly requestOperationId: string
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
      readonly participantId: string
      readonly memberId: string
      readonly runId: string
    },
  ): Promise<unknown>
  readAgentLoopV4Lifecycle(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
      readonly afterSequence: number
    },
  ): Promise<unknown>
  resolveAgentLoopV4Session(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly task: string
      readonly binding: AgentLoopTaskBinding['binding']
      readonly definition: AgentLoopTaskBinding['definition']
    },
  ): Promise<unknown>
}

export function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function handle(value: unknown): string | undefined {
  return typeof value === 'string' && [...value].length >= 1 && [...value].length <= 512 ? value : undefined
}

export function derivedEventId(eventId: string, suffix: string): string {
  const candidate = `${eventId}:${suffix}`
  if ([...candidate].length <= 512) return candidate
  let digest = 0x811c9dc5
  for (const byte of new TextEncoder().encode(candidate)) digest = Math.imul(digest ^ byte, 0x01000193) >>> 0
  const tail = `:${suffix}:${digest.toString(16).padStart(8, '0')}`
  return `${[...eventId].slice(0, 512 - [...tail].length).join('')}${tail}`
}

export function shellSafeAssistantMessageId(turn: string): string {
  const bytes = new TextEncoder().encode(turn)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0
  }
  const digest = `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
  const prefix = 'cxloop-assistant-'
  const stem = turn.replace(/[^A-Za-z0-9._~-]/gu, '~').slice(0, 512 - prefix.length - digest.length - 1)
  return `${prefix}${stem}-${digest}`
}

export function delivery(value: unknown): 'executed' | 'replayed' | 'reconciled' | undefined {
  return value === 'executed' || value === 'replayed' || value === 'reconciled' ? value : undefined
}

export function scope(profileId: string, compositionGeneration: string, ownerKey: string): CordisXAgentLoopV4Scope {
  return Object.freeze({ profileId, compositionGeneration, ownerKey })
}

export function tupleKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts)
}

export function correlationKey(
  authorityScope: CordisXAgentLoopV4Scope,
  ...parts: readonly (string | number)[]
): string {
  return tupleKey(authorityScope.profileId, authorityScope.compositionGeneration, authorityScope.ownerKey, ...parts)
}

export function refusal<Kind extends AgentLoopResult['type']>(
  command: Extract<Command, { type: Kind }>,
  capability: Capability,
  state: 'denied' | 'unavailable',
  code: string,
): Extract<AgentLoopResult, { type: Kind }> {
  const allowedCode = command.type === 'create-or-bind'
    ? ['details-unavailable', 'operation-conflict', 'reconciliation-required', 'operation-expired', 'provider-replaced']
      .includes(code)
    : command.type === 'send'
    ? ['operation-conflict', 'reconciliation-required', 'operation-expired', 'provider-replaced'].includes(code)
    : command.type === 'approval-decision'
    ? [
      'reconciliation-required',
      'operation-expired',
      'provider-replaced',
      'binding-closed',
      'approval-expired',
      'approval-unavailable',
    ].includes(code)
    : [
      'reconciliation-required',
      'operation-expired',
      'provider-replaced',
      'binding-closed',
      'introduction-expired',
      'introduction-unavailable',
      'introduction-not-found',
    ].includes(code)
  return Object.freeze({
    $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
    contract: 'cordisx.agent-loop-result/v4',
    schemaVersion: 4,
    commandId: command.commandId,
    type: command.type,
    status: state,
    authorization: {
      capability,
      state,
      code: state === 'denied'
        ? (code === 'user-denied' ? 'user-denied' : 'policy-denied')
        : (['task-unavailable', 'unsupported'].includes(code) ? code : 'host-unavailable'),
    },
    ...(allowedCode
      ? { authorization: { capability, state: 'allowed', code: 'allowed' }, code }
      : {}),
  }) as Extract<AgentLoopResult, { type: Kind }>
}

export function authorizationFor<Selected extends Capability>(
  capability: Selected,
): Extract<AgentLoopAuthorizationOutcome, { state: 'allowed' }> & { capability: Selected } {
  return { capability, state: 'allowed', code: 'allowed' }
}

export function internalRefusal<Kind extends AgentLoopResult['type']>(
  command: Extract<Command, { type: Kind }>,
  capability: Capability,
  code: string,
): Extract<AgentLoopResult, { type: Kind }> {
  const isConflict = command.type === 'approval-decision'
    ? ['operation-conflict', 'binding-conflict', 'approval-conflict'].includes(code)
    : command.type === 'request-member-self-introduction' || command.type === 'cancel-member-self-introduction'
    ? [
      'operation-conflict',
      'binding-conflict',
      'member-conflict',
      'run-conflict',
      'introduction-conflict',
      'introduction-completed',
      'introduction-cancelled',
    ].includes(code)
    : false
  if (isConflict) {
    return Object.freeze({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'conflict',
      authorization: authorizationFor(capability),
      code,
    }) as Extract<AgentLoopResult, { type: Kind }>
  }
  return refusal(command, capability, 'unavailable', code)
}

export function bindingFor(command: CreateCommand, task: string, value: unknown): AgentLoopTaskBinding | undefined {
  const binding = record(value)
  const bindingId = handle(binding?.bindingId)
  const generation = binding?.generation
  if (
    bindingId === undefined
    || !Number.isInteger(generation) || (generation as number) < 1
  ) return undefined
  return Object.freeze({
    $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
    contract: 'cordisx.agent-loop-task-binding/v4',
    schemaVersion: 4,
    binding: { bindingId, generation: generation as number },
    definition: clone(command.definition),
    task,
    state: 'active',
  })
}
