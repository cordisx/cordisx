import type { Disposable } from '@deepseek-ai/cordis'
import type {
  AgentLoopApprovalDecisionResult,
  AgentLoopAuthorizationOutcome,
  AgentLoopCancelMemberSelfIntroductionResult,
  AgentLoopCreateOrBindResult,
  AgentLoopEvent,
  AgentLoopEventPage,
  AgentLoopRequestMemberSelfIntroductionResult,
  AgentLoopResult,
  AgentLoopSendResult,
  AgentLoopSubscribeRuntimeResult,
  AgentLoopSubscription,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4'
import {
  CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V4,
  CORDISX_AGENT_LOOP_EVENT_SCHEMA_V4,
  CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V4,
  CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
  CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V4,
} from '../agent-loop-contracts.js'
import {
  renderAgentDeveloperInstructions,
  resolveAgentDefinition,
  type CordisXAgentLoopHost,
  type CordisXBoundAgentLoopClientOptions,
} from './agent-loop.js'
import type { CordisXAgentLoopV4Scope } from './provider-binding.js'
import { validateAgentLoopTaskDetailsUrl } from './host-ui/AgentTaskDetailsNavigator.js'

type Command = Parameters<BoundAgentLoopClient['createOrBind']>[0]
  | Parameters<BoundAgentLoopClient['send']>[0]
  | Parameters<BoundAgentLoopClient['decideApproval']>[0]
  | Parameters<BoundAgentLoopClient['requestMemberSelfIntroduction']>[0]
  | Parameters<BoundAgentLoopClient['cancelMemberSelfIntroduction']>[0]
type CreateCommand = Parameters<BoundAgentLoopClient['createOrBind']>[0]
type SendCommand = Parameters<BoundAgentLoopClient['send']>[0]
type ApprovalCommand = Parameters<BoundAgentLoopClient['decideApproval']>[0]
type IntroductionCommand = Parameters<BoundAgentLoopClient['requestMemberSelfIntroduction']>[0]
type CancelIntroductionCommand = Parameters<BoundAgentLoopClient['cancelMemberSelfIntroduction']>[0]
type Capability = AgentLoopAuthorizationOutcome['capability']

interface InternalResult {
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

interface InternalLifecycleEvent {
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

interface InternalLifecycleResult {
  readonly status?: unknown
  readonly code?: unknown
  readonly nextAfterSequence?: unknown
  readonly events?: unknown
}

interface PromptRegistration {
  readonly key: string
  readonly disposers: readonly Disposable<void>[]
  refCount: number
  disposed: boolean
}

export interface AgentLoopV4Transport {
  readonly debugMock?: true
  createAgentLoopV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly definition: { readonly agentId: string; readonly revision: string }; readonly model: { readonly providerId: string; readonly modelId: string }; readonly cwd: string; readonly developerInstructions?: string; readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' }): Promise<unknown>
  bindAgentLoopV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly definition: { readonly agentId: string; readonly revision: string } }): Promise<unknown>
  sendAgentLoopV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: AgentLoopTaskBinding['binding']; readonly definition: AgentLoopTaskBinding['definition']; readonly message: string }): Promise<unknown>
  decideAgentLoopApprovalV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: AgentLoopTaskBinding['binding']; readonly definition: AgentLoopTaskBinding['definition']; readonly turn: string; readonly approvalId: string; readonly decision: 'approved' | 'denied' | 'cancelled' }): Promise<unknown>
  requestAgentLoopIntroductionV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: AgentLoopTaskBinding['binding']; readonly definition: AgentLoopTaskBinding['definition']; readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<unknown>
  cancelAgentLoopIntroductionV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly requestOperationId: string; readonly task: string; readonly binding: AgentLoopTaskBinding['binding']; readonly definition: AgentLoopTaskBinding['definition']; readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<unknown>
  readAgentLoopV4Lifecycle(input: { readonly scope: CordisXAgentLoopV4Scope; readonly task: string; readonly binding: AgentLoopTaskBinding['binding']; readonly definition: AgentLoopTaskBinding['definition']; readonly afterSequence: number }): Promise<unknown>
}

function clone<Value>(value: Value): Value { return structuredClone(value) }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function delivery(value: unknown): 'executed' | 'replayed' | 'reconciled' | undefined {
  return value === 'executed' || value === 'replayed' || value === 'reconciled' ? value : undefined
}
function scope(profileId: string, compositionGeneration: string, ownerKey: string): CordisXAgentLoopV4Scope { return Object.freeze({ profileId, compositionGeneration, ownerKey }) }

function refusal<Kind extends AgentLoopResult['type']>(
  command: Extract<Command, { type: Kind }>,
  capability: Capability,
  state: 'denied' | 'unavailable',
  code: string,
): Extract<AgentLoopResult, { type: Kind }> {
  const allowedCode = command.type === 'create-or-bind'
    ? ['details-unavailable', 'operation-conflict', 'reconciliation-required', 'operation-expired', 'provider-replaced'].includes(code)
    : command.type === 'send'
      ? ['operation-conflict', 'reconciliation-required', 'operation-expired', 'provider-replaced'].includes(code)
      : command.type === 'approval-decision'
        ? ['reconciliation-required', 'operation-expired', 'provider-replaced', 'binding-closed', 'approval-expired', 'approval-unavailable'].includes(code)
        : ['reconciliation-required', 'operation-expired', 'provider-replaced', 'binding-closed', 'introduction-expired', 'introduction-unavailable', 'introduction-not-found'].includes(code)
  return Object.freeze({
    $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
    contract: 'cordisx.agent-loop-result/v4',
    schemaVersion: 4,
    commandId: command.commandId,
    type: command.type,
    status: state,
    authorization: { capability, state, code: state === 'denied' ? (code === 'user-denied' ? 'user-denied' : 'policy-denied') : (['task-unavailable', 'unsupported'].includes(code) ? code : 'host-unavailable') },
    ...(allowedCode
      ? { authorization: { capability, state: 'allowed', code: 'allowed' }, code }
      : {}),
  }) as Extract<AgentLoopResult, { type: Kind }>
}

function authorizationFor<Selected extends Capability>(capability: Selected): Extract<AgentLoopAuthorizationOutcome, { state: 'allowed' }> & { capability: Selected } {
  return { capability, state: 'allowed', code: 'allowed' }
}

function internalRefusal<Kind extends AgentLoopResult['type']>(
  command: Extract<Command, { type: Kind }>,
  capability: Capability,
  code: string,
): Extract<AgentLoopResult, { type: Kind }> {
  const isConflict = command.type === 'approval-decision'
    ? ['operation-conflict', 'binding-conflict', 'approval-conflict'].includes(code)
    : command.type === 'request-member-self-introduction' || command.type === 'cancel-member-self-introduction'
      ? ['operation-conflict', 'binding-conflict', 'member-conflict', 'run-conflict', 'introduction-conflict', 'introduction-completed', 'introduction-cancelled'].includes(code)
      : false
  if (isConflict) {
    return Object.freeze({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4,
      contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
      commandId: command.commandId, type: command.type, status: 'conflict',
      authorization: authorizationFor(capability), code,
    }) as Extract<AgentLoopResult, { type: Kind }>
  }
  return refusal(command, capability, 'unavailable', code)
}

function bindingFor(command: CreateCommand, task: string, value: unknown): AgentLoopTaskBinding | undefined {
  const binding = record(value)
  if (typeof binding?.bindingId !== 'string' || binding.bindingId === ''
    || !Number.isInteger(binding.generation) || (binding.generation as number) < 1) return undefined
  return Object.freeze({
    $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
    contract: 'cordisx.agent-loop-task-binding/v4',
    schemaVersion: 4,
    binding: { bindingId: binding.bindingId, generation: binding.generation as number },
    definition: clone(command.definition),
    task,
    state: 'active',
  })
}

/** Renderer adapter for the launcher-owned durable v4 authority. */
export class CordisXAgentLoopBrokerV4 {
  private disposed = false
  private nextSubscription = 1
  private readonly introductions = new Map<string, { operationId: string; participantId: string; memberId: string; runId: string }>()
  private readonly approvals = new Map<string, string>()
  private readonly cancellations = new Map<string, string>()
  private readonly promptRegistrations = new Map<string, PromptRegistration>()
  private readonly lifecycleMutations = new Map<string, number>()
  private readonly publicEventSnapshots = new Map<string, readonly AgentLoopEvent[]>()

  constructor(
    private readonly transport: AgentLoopV4Transport | undefined,
    private readonly prepareHost: CordisXAgentLoopHost,
    private readonly profileId: string,
    private readonly compositionGeneration: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  bind(options: CordisXBoundAgentLoopClientOptions): BoundAgentLoopClient {
    let disposed = false
    const subscriptions = new Set<AgentLoopSubscription>()
    const clientPrompts = new Map<string, PromptRegistration>()
    const live = () => !disposed && !this.disposed && options.active()
    const authorityScope = scope(this.profileId, this.compositionGeneration, options.ownerKey)
    const mutationKey = (binding: AgentLoopTaskBinding) => `${authorityScope.profileId}\0${authorityScope.ownerKey}\0${binding.task}\0${binding.binding.bindingId}\0${binding.binding.generation}`
    const mutateLifecycle = async <Value>(binding: AgentLoopTaskBinding, operation: () => Promise<Value>): Promise<Value> => {
      const key = mutationKey(binding)
      this.lifecycleMutations.set(key, (this.lifecycleMutations.get(key) ?? 0) + 1)
      try {
        return await operation()
      } finally {
        const remaining = (this.lifecycleMutations.get(key) ?? 1) - 1
        if (remaining === 0) this.lifecycleMutations.delete(key)
        else this.lifecycleMutations.set(key, remaining)
      }
    }
    const disposePrompt = (registration: PromptRegistration): void => {
      if (registration.disposed) return
      registration.refCount -= 1
      if (registration.refCount > 0) return
      registration.disposed = true
      this.promptRegistrations.delete(registration.key)
      for (const disposer of registration.disposers) disposer()
    }
    const registerPrompt = (task: string, definition: Parameters<NonNullable<typeof options.registerPrompt>>[1]): void => {
      const key = JSON.stringify([authorityScope.profileId, authorityScope.ownerKey, task, definition.identity.agentId, definition.identity.revision])
      const previous = clientPrompts.get(task)
      if (previous?.key === key) return
      if (previous !== undefined) disposePrompt(previous)
      const shared = this.promptRegistrations.get(key)
      const registration: PromptRegistration = shared ?? { key, disposers: options.registerPrompt?.(task, definition) ?? [], refCount: 0, disposed: false }
      registration.refCount += 1
      clientPrompts.set(task, registration)
      this.promptRegistrations.set(key, registration)
    }
    const authorize = async (capability: Capability, binding?: AgentLoopTaskBinding): Promise<AgentLoopAuthorizationOutcome> => {
      const request = { capability, ...(binding === undefined ? {} : { task: binding.task }) }
      if (options.authorizeV4 !== undefined) return await options.authorizeV4(request)
      if (capability === 'turns.introduce' || capability === 'approvals.decide') {
        const legacy = await options.authorize({ ...request, capability: 'turns.submit' })
        return { ...legacy, capability }
      }
      return await options.authorize(request as Parameters<typeof options.authorize>[0])
    }

    const client: BoundAgentLoopClient = Object.freeze({
      $schema: CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V4,
      contract: 'cordisx.bound-agent-loop-client/v4',
      schemaVersion: 4,
      durableLedger: Object.freeze({
        operationId: 'commandId', scope: 'owner-provider', providerAffinity: 'generation-fenced', survivesClientDispose: true,
        payloadMatch: 'structural-exact', retention: Object.freeze({ active: 'logical-task-lifetime', recoveryDays: 30 }),
      }),
      createOrBind: async (command: CreateCommand): Promise<AgentLoopCreateOrBindResult> => {
        const capability = command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read'
        if (!live() || this.transport === undefined) return refusal(command, capability, 'unavailable', 'host-unavailable')
        let definition
        try { definition = resolveAgentDefinition(command as never) } catch { return refusal(command, capability, 'unavailable', 'unsupported') }
        const allowed = await authorize(capability)
        if (allowed.state !== 'allowed') return refusal(command, capability, allowed.state, allowed.code)
        let internal: InternalResult
        if (command.target.mode === 'create') {
          const prepared = await this.prepareHost.prepare(definition)
          if (!prepared.ok) return refusal(command, capability, 'unavailable', 'host-unavailable')
          const model = prepared.value.model ?? (this.transport.debugMock === true ? { providerId: 'debug:agent-loop/mock/v1', modelId: 'deterministic' } : undefined)
          const cwd = prepared.value.cwd ?? (this.transport.debugMock === true ? '/playground' : undefined)
          if (model === undefined || cwd === undefined) return refusal(command, capability, 'unavailable', 'host-unavailable')
          internal = await this.transport.createAgentLoopV4({
            scope: authorityScope,
            command,
            operationId: command.commandId,
            definition: command.definition,
            model,
            cwd,
            ...(renderAgentDeveloperInstructions(definition) === undefined ? {} : { developerInstructions: renderAgentDeveloperInstructions(definition)! }),
            ...(definition.runtimeDefaults?.effort === undefined ? {} : { effort: definition.runtimeDefaults.effort }),
          }) as InternalResult
        } else {
          internal = await this.transport.bindAgentLoopV4({ scope: authorityScope, command, operationId: command.commandId, task: command.target.task, definition: command.definition }) as InternalResult
        }
        if (internal.status !== 'accepted') return refusal(command, capability, 'unavailable', string(internal.code) ?? 'host-unavailable')
        const task = string(internal.locator?.task)
        let detailsUrl
        try { detailsUrl = validateAgentLoopTaskDetailsUrl(clone(internal.detailsUrl) as never) } catch { return refusal(command, capability, 'unavailable', 'details-unavailable') }
        const disposition = delivery(internal.delivery)
        if (task === undefined) return refusal(command, capability, 'unavailable', 'reconciliation-required')
        if (disposition === undefined) return refusal(command, capability, 'unavailable', 'reconciliation-required')
        const binding = bindingFor(command, task, internal.locator?.binding)
        if (binding === undefined) return refusal(command, capability, 'unavailable', 'reconciliation-required')
        registerPrompt(task, definition)
        return Object.freeze({
          $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4, contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
          commandId: command.commandId, type: 'create-or-bind', status: 'accepted', authorization: authorizationFor(capability), binding,
          detailsUrl, delivery: { disposition },
        })
      },
      send: async (command: SendCommand): Promise<AgentLoopSendResult> => {
        if (!live() || this.transport === undefined) return refusal(command, 'turns.submit', 'unavailable', 'host-unavailable')
        const allowed = await authorize('turns.submit', command.binding)
        if (allowed.state !== 'allowed') return refusal(command, 'turns.submit', allowed.state, allowed.code)
        if (command.binding.state !== 'active') return refusal(command, 'turns.submit', 'unavailable', 'binding-closed')
        if (command.content.some(part => part.kind !== 'text')) return refusal(command, 'turns.submit', 'unavailable', 'unsupported')
        const message = command.content.map(part => part.kind === 'text' ? part.text : '').join('\n').trim()
        if (message === '') return refusal(command, 'turns.submit', 'unavailable', 'unsupported')
        const internal = await this.transport.sendAgentLoopV4({ scope: authorityScope, command, operationId: command.commandId, task: command.binding.task, binding: command.binding.binding, definition: command.binding.definition, message }) as InternalResult
        if (internal.status !== 'accepted') return internalRefusal(command, 'turns.submit', string(internal.code) ?? 'host-unavailable')
        const turn = string(internal.turn); const messageId = string(internal.messageId)
        const disposition = delivery(internal.delivery)
        if (turn === undefined || messageId === undefined || disposition === undefined) return refusal(command, 'turns.submit', 'unavailable', 'reconciliation-required')
        return Object.freeze({ $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4, contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4, commandId: command.commandId, type: 'send', status: 'accepted', authorization: authorizationFor('turns.submit'), binding: command.binding, messageId, turn, delivery: { disposition } })
      },
      decideApproval: async (command: ApprovalCommand): Promise<AgentLoopApprovalDecisionResult> => {
        if (!live() || this.transport === undefined) return refusal(command, 'approvals.decide', 'unavailable', 'host-unavailable')
        const allowed = await authorize('approvals.decide', command.binding)
        if (allowed.state !== 'allowed') return refusal(command, 'approvals.decide', allowed.state, allowed.code)
        const internal = await mutateLifecycle(command.binding, async () => await this.transport!.decideAgentLoopApprovalV4({ scope: authorityScope, command, operationId: command.commandId, task: command.binding.task, binding: command.binding.binding, definition: command.binding.definition, turn: command.turn, approvalId: command.approvalId, decision: command.decision }) as InternalResult)
        if (internal.status !== 'accepted') return internalRefusal(command, 'approvals.decide', string(internal.code) ?? 'approval-unavailable')
        const disposition = delivery(internal.delivery)
        if (disposition === undefined) return refusal(command, 'approvals.decide', 'unavailable', 'reconciliation-required')
        this.approvals.set(`${command.binding.task}\0${command.turn}\0${command.approvalId}`, command.commandId)
        return Object.freeze({ $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4, contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4, commandId: command.commandId, type: 'approval-decision', status: 'accepted', authorization: authorizationFor('approvals.decide'), binding: command.binding, turn: command.turn, approvalId: command.approvalId, decision: command.decision, causation: { operationId: command.commandId }, delivery: { disposition } })
      },
      requestMemberSelfIntroduction: async (command: IntroductionCommand): Promise<AgentLoopRequestMemberSelfIntroductionResult> => {
        if (!live() || this.transport === undefined) return refusal(command, 'turns.introduce', 'unavailable', 'host-unavailable')
        const allowed = await authorize('turns.introduce', command.binding)
        if (allowed.state !== 'allowed') return refusal(command, 'turns.introduce', allowed.state, allowed.code)
        const internal = await mutateLifecycle(command.binding, async () => await this.transport!.requestAgentLoopIntroductionV4({ scope: authorityScope, command, operationId: command.commandId, task: command.binding.task, binding: command.binding.binding, definition: command.binding.definition, participantId: command.participantId, memberId: command.memberId, runId: command.runId }) as InternalResult)
        if (internal.status !== 'accepted') return internalRefusal(command, 'turns.introduce', string(internal.code) ?? 'introduction-unavailable')
        const turn = string(internal.turn); const messageId = string(internal.messageId)
        const disposition = delivery(internal.delivery)
        if (turn === undefined || messageId === undefined || disposition === undefined) return refusal(command, 'turns.introduce', 'unavailable', 'reconciliation-required')
        this.introductions.set(`${command.binding.task}\0${turn}`, { operationId: command.commandId, participantId: command.participantId, memberId: command.memberId, runId: command.runId })
        return Object.freeze({ $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4, contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4, commandId: command.commandId, type: command.type, status: 'accepted', authorization: authorizationFor('turns.introduce'), binding: command.binding, participantId: command.participantId, memberId: command.memberId, runId: command.runId, turn, messageId, causation: { operationId: command.commandId }, delivery: { disposition } })
      },
      cancelMemberSelfIntroduction: async (command: CancelIntroductionCommand): Promise<AgentLoopCancelMemberSelfIntroductionResult> => {
        if (!live() || this.transport === undefined) return refusal(command, 'turns.introduce', 'unavailable', 'host-unavailable')
        const allowed = await authorize('turns.introduce', command.binding)
        if (allowed.state !== 'allowed') return refusal(command, 'turns.introduce', allowed.state, allowed.code)
        const internal = await mutateLifecycle(command.binding, async () => await this.transport!.cancelAgentLoopIntroductionV4({
          scope: authorityScope,
          command,
          operationId: command.commandId,
          requestOperationId: command.requestOperationId,
          task: command.binding.task,
          binding: command.binding.binding,
          definition: command.binding.definition,
          participantId: command.participantId,
          memberId: command.memberId,
          runId: command.runId,
        }) as InternalResult)
        if (internal.status !== 'accepted') return internalRefusal(command, 'turns.introduce', string(internal.code) ?? 'introduction-unavailable')
        const turn = string(internal.turn); const messageId = string(internal.messageId)
        const disposition = delivery(internal.delivery)
        if (turn === undefined || messageId === undefined || disposition === undefined) return refusal(command, 'turns.introduce', 'unavailable', 'reconciliation-required')
        this.cancellations.set(`${command.binding.task}\0${turn}`, command.commandId)
        return Object.freeze({ $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4, contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4, commandId: command.commandId, type: command.type, status: 'accepted', authorization: authorizationFor('turns.introduce'), binding: command.binding, participantId: command.participantId, memberId: command.memberId, runId: command.runId, requestOperationId: command.requestOperationId, turn, messageId, causation: { operationId: command.commandId }, delivery: { disposition } })
      },
      subscribe: async (binding: AgentLoopTaskBinding, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResult> => {
        if (!live() || this.transport === undefined) return { status: 'unavailable', authorization: { capability: 'tasks.content.read', state: 'unavailable', code: 'host-unavailable' } }
        const allowed = await authorize('tasks.content.read', binding)
        if (allowed.state !== 'allowed') return { status: allowed.state, authorization: allowed } as AgentLoopSubscribeRuntimeResult
        const snapshot = await this.publicEvents(authorityScope, binding, mutationKey(binding))
        if (snapshot === undefined) return { status: 'unavailable', authorization: { capability: 'tasks.content.read', state: 'unavailable', code: 'task-unavailable' } }
        const subscriptionId = `cxloop-v4-subscription:${this.nextSubscription++}`
        let active = true
        const descriptor = Object.freeze({ $schema: CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V4, contract: 'cordisx.agent-loop-event-subscription/v4' as const, schemaVersion: 4 as const, subscriptionId, binding: binding.binding, afterSequence, snapshotSequence: snapshot.length })
        const handle: AgentLoopSubscription = Object.freeze({
          subscription: descriptor,
          pages: this.pages(authorityScope, binding, descriptor, () => active && live(), mutationKey(binding)),
          unsubscribe: () => { active = false },
        })
        subscriptions.add(handle)
        return { status: 'accepted', authorization: authorizationFor('tasks.content.read'), handle }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const subscription of subscriptions) subscription.unsubscribe()
        subscriptions.clear()
        for (const registration of clientPrompts.values()) disposePrompt(registration)
        clientPrompts.clear()
      },
    })
    return client
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const registration of this.promptRegistrations.values()) {
      registration.disposed = true
      for (const disposer of registration.disposers) disposer()
    }
    this.promptRegistrations.clear()
  }

  private async *pages(
    authorityScope: CordisXAgentLoopV4Scope,
    binding: AgentLoopTaskBinding,
    descriptor: AgentLoopSubscription['subscription'],
    active: () => boolean,
    snapshotKey: string,
  ): AsyncIterable<AgentLoopEventPage> {
    let cursor = descriptor.afterSequence
    while (active()) {
      const all = await this.publicEvents(authorityScope, binding, snapshotKey)
      if (all === undefined) return
      const replaying = cursor < descriptor.snapshotSequence
      const events = all.filter(event => event.sequence > cursor
        && (!replaying || event.sequence <= descriptor.snapshotSequence)).slice(0, 256)
      if (events.length > 0) {
        const next = events.at(-1)!.sequence
        const page: AgentLoopEventPage = Object.freeze({
          $schema: CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V4,
          contract: 'cordisx.agent-loop-event-page/v4', schemaVersion: 4,
          subscription: descriptor, afterSequence: cursor,
          phase: replaying ? 'replay' : 'live',
          events, nextAfterSequence: next, hasMore: all.length > next,
        })
        cursor = next
        yield page
        if (all.length > cursor) continue
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  private async publicEvents(authorityScope: CordisXAgentLoopV4Scope, binding: AgentLoopTaskBinding, snapshotKey: string): Promise<readonly AgentLoopEvent[] | undefined> {
    if ((this.lifecycleMutations.get(snapshotKey) ?? 0) > 0) return this.publicEventSnapshots.get(snapshotKey) ?? []
    const result = await this.transport!.readAgentLoopV4Lifecycle({ scope: authorityScope, task: binding.task, binding: binding.binding, definition: binding.definition, afterSequence: 0 }) as InternalLifecycleResult
    if (result.status !== 'accepted' || !Array.isArray(result.events)) return undefined
    const snapshot = result.events
      .flatMap(value => this.projectLifecycle(binding, value as InternalLifecycleEvent))
      .map((event, index) => Object.freeze({ ...event, sequence: index + 1 }))
    this.publicEventSnapshots.set(snapshotKey, snapshot)
    return snapshot
  }

  private projectLifecycle(binding: AgentLoopTaskBinding, input: InternalLifecycleEvent): readonly AgentLoopEvent[] {
    const sequence = typeof input.sequence === 'number' ? input.sequence : undefined
    const turn = string(input.turnId)
    if (sequence === undefined || turn === undefined) return []
    const base = { $schema: CORDISX_AGENT_LOOP_EVENT_SCHEMA_V4, contract: 'cordisx.agent-loop-event/v4' as const, schemaVersion: 4 as const, eventId: string(input.eventId) ?? `cxloop-event:${sequence}`, binding: binding.binding, sequence, occurredAt: string(input.observedAt) ?? '1970-01-01T00:00:00.000Z', turn }
    const durableIntroduction = record(input.introduction)
    const rememberedIntroduction = this.introductions.get(`${binding.task}\0${turn}`)
    const introductionOperationId = string(durableIntroduction?.operationId) ?? rememberedIntroduction?.operationId
    if (input.type === 'turn.started') return [{
      ...base, type: 'lifecycle',
      ...(introductionOperationId === undefined ? {} : { causation: { operationId: introductionOperationId } }),
      lifecycle: { phase: 'turn.started' },
    }]
    if (input.type === 'turn.failed') {
      const cancellationOperationId = string(record(input.cancellation)?.operationId)
      if (cancellationOperationId !== undefined) return [{ ...base, type: 'lifecycle', causation: { operationId: cancellationOperationId }, lifecycle: { phase: 'turn.cancelled' } }]
      const failure = record(input.failure)
      return [{
        ...base, type: 'lifecycle',
        ...(introductionOperationId === undefined ? {} : { causation: { operationId: introductionOperationId } }),
        lifecycle: { phase: 'turn.failed', failure: { code: string(failure?.code) ?? 'TURN_FAILED', retryable: failure?.retryable === true } },
      }]
    }
    if (input.type === 'turn.cancelled') {
      const operationId = string(record(input.cancellation)?.operationId)
      return operationId === undefined ? [] : [{ ...base, type: 'lifecycle', causation: { operationId }, lifecycle: { phase: 'turn.cancelled' } }]
    }
    if (input.type === 'turn.completed') {
      const introduction = durableIntroduction === undefined ? rememberedIntroduction : {
        operationId: string(durableIntroduction.operationId),
        participantId: string(durableIntroduction.participantId),
        memberId: string(durableIntroduction.memberId),
        runId: string(durableIntroduction.runId),
      }
      const validIntroduction = introduction !== undefined
        && introduction.operationId !== undefined && introduction.participantId !== undefined
        && introduction.memberId !== undefined && introduction.runId !== undefined
        ? introduction as { operationId: string; participantId: string; memberId: string; runId: string }
        : undefined
      const output = Array.isArray(input.output) ? input.output.flatMap(value => {
        const item = record(value); const text = string(item?.text)
        return text === undefined ? [] : [{ kind: 'text' as const, text }]
      }) : []
      const durableCancellation = string(record(input.cancellation)?.operationId)
      const cancelled = durableCancellation ?? this.cancellations.get(`${binding.task}\0${turn}`)
      const message = output.length === 0 || cancelled !== undefined ? [] : [{
        ...base,
        eventId: `${base.eventId}:message`,
        type: 'message' as const,
        ...(validIntroduction === undefined ? {} : { causation: { operationId: validIntroduction.operationId } }),
        message: validIntroduction === undefined
          ? { messageId: `cxloop-assistant:${turn}`, role: 'assistant' as const, purpose: 'conversation' as const, content: output as [typeof output[number], ...typeof output] }
          : { messageId: `cxloop-introduction:${validIntroduction.operationId}`, role: 'assistant' as const, purpose: 'member-self-introduction' as const, content: output as [typeof output[number], ...typeof output] },
      } as AgentLoopEvent]
      return [...message, cancelled === undefined
        ? { ...base, type: 'lifecycle', lifecycle: { phase: 'turn.completed' } } as AgentLoopEvent
        : { ...base, eventId: `${base.eventId}:lifecycle`, type: 'lifecycle', causation: { operationId: cancelled }, lifecycle: { phase: 'turn.cancelled' } } as AgentLoopEvent]
    }
    const approval = record(input.approval); const approvalId = string(approval?.approvalId)
    if ((input.type === 'approval.required' || input.type === 'approval.resolved') && approvalId !== undefined) {
      const kind = ['file-change', 'external-action', 'other'].includes(String(approval?.kind)) ? approval!.kind as 'file-change' | 'external-action' | 'other' : 'command'
      if (input.type === 'approval.required') return [{ ...base, type: 'approval', approval: { approvalId, kind, state: 'pending' } }]
      const outcome = approval?.outcome
      const operationId = string(record(input.causation)?.operationId) ?? this.approvals.get(`${binding.task}\0${turn}\0${approvalId}`)
      return operationId === undefined || outcome === 'expired'
        ? [{ ...base, type: 'approval', approval: { approvalId, kind, state: 'resolved', outcome: 'expired' } }]
        : [{ ...base, type: 'approval', causation: { operationId }, approval: { approvalId, kind, state: 'resolved', outcome: outcome === 'denied' || outcome === 'cancelled' ? outcome : 'approved' } }]
    }
    return []
  }
}
