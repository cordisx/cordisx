import { Service, type Context } from '@deepseek-ai/cordis'

export const PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE = 'playgroundRoomSimulationBridge' as const
export const PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT = 'cordisx.playground-room-simulation-binding/v1' as const

export interface PlaygroundRoomSimulationBinding {
  readonly contract: typeof PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT
  readonly roomId: string
  readonly runId: string
  readonly memberId: string
  readonly bindingId: string
  readonly ownerGeneration: string
  readonly generation: string
}

export interface PlaygroundRoomSimulationUnavailable {
  readonly status: 'unavailable'
  readonly code: 'service-unavailable' | 'owner-unavailable' | 'owner-replaced' | 'owner-retired' | 'invalid-binding' | 'owner-error' | string
  readonly message: string
  readonly ownerGeneration?: string
}

export interface PlaygroundRoomSimulationAvailable<Value> {
  readonly status: 'available'
  readonly ownerGeneration: string
  readonly value: Value
}

export type PlaygroundRoomSimulationResult<Value> =
  | PlaygroundRoomSimulationAvailable<Value>
  | PlaygroundRoomSimulationUnavailable

export interface PlaygroundRoomSimulationInspection {
  readonly binding: PlaygroundRoomSimulationBinding
  readonly lifecycle: 'active' | 'archived' | 'deleted' | 'retired' | 'unavailable'
  readonly revision: number
  readonly delegationTargets: readonly PlaygroundRoomSimulationDelegationTarget[]
  readonly reason?: string
}

export interface PlaygroundRoomSimulationDelegationTarget {
  readonly memberId: string
  readonly label: string
}

export interface PlaygroundRoomSimulationOperationReceipt {
  readonly operationId: string
  readonly phase: 'accepted' | 'pending' | 'completed' | 'failed' | 'rejected'
  readonly binding: PlaygroundRoomSimulationBinding
  readonly roomEntryId?: string
  readonly messageId?: string
  readonly approvalId?: string
  readonly turnId?: string
  readonly runId?: string
  readonly terminal?: 'completed' | 'failed' | 'denied' | 'cancelled'
  readonly replayed?: boolean
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface PlaygroundRoomSimulationSnapshot {
  readonly binding: PlaygroundRoomSimulationBinding
  readonly revision: number
  readonly events: readonly PlaygroundRoomSimulationEvent[]
}

export interface PlaygroundRoomSimulationEvent {
  readonly kind: string
  readonly binding: PlaygroundRoomSimulationBinding
  readonly revision: number
  readonly operationId?: string
  readonly occurredAt?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface PlaygroundRoomSimulationMessageInput {
  readonly text: string
}

export interface PlaygroundRoomSimulationAgentReplyInput {
  readonly text: string
  readonly correlation?: Readonly<{
    readonly turnId?: string
    readonly messageId?: string
    readonly inReplyToMessageId?: string
  }>
}

export interface PlaygroundRoomSimulationAgentApprovalRequest {
  readonly reason: string
}

export interface PlaygroundRoomSimulationTaskDelegationInput {
  readonly memberId: string
  readonly task: string
}

export interface PlaygroundRoomSimulationPermissionRequest {
  readonly title: string
  readonly rationale?: string
  readonly kind?: 'command' | 'file-change' | 'external-action' | 'other'
  readonly detail?: Readonly<Record<string, unknown>>
}

export type PlaygroundRoomSimulationPermissionDecision = 'allow' | 'deny' | 'cancel'

type MaybePromise<Value> = Value | Promise<Value>

export interface PlaygroundRoomSimulationOwner {
  readonly ownerGeneration: string
  inspect(binding: PlaygroundRoomSimulationBinding): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationInspection>>
  injectMessage(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationMessageInput,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  emitAgentReply(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentReplyInput,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  emitAgentApprovalRequest(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationAgentApprovalRequest,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  delegateTask(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationTaskDelegationInput,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  requestPermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationPermissionRequest,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  decidePermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    approvalId: string,
    decision: PlaygroundRoomSimulationPermissionDecision,
  ): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  snapshot(binding: PlaygroundRoomSimulationBinding): MaybePromise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationSnapshot>>
  subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void
}

export interface PlaygroundRoomSimulationBridgeStatus {
  readonly installed: true
  readonly revision: number
  readonly ownerState: 'available' | 'unavailable'
  readonly ownerGeneration?: string
}

export interface PlaygroundRoomSimulationForwardingClient {
  status(): PlaygroundRoomSimulationBridgeStatus
  inspect(binding: PlaygroundRoomSimulationBinding): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationInspection>>
  injectMessage(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationMessageInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  emitAgentReply(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentReplyInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  emitAgentApprovalRequest(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationAgentApprovalRequest,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  delegateTask(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationTaskDelegationInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  requestPermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationPermissionRequest,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  decidePermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    approvalId: string,
    decision: PlaygroundRoomSimulationPermissionDecision,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>
  snapshot(binding: PlaygroundRoomSimulationBinding): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationSnapshot>>
  subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void
}

export interface PlaygroundRoomSimulationBridgeService extends PlaygroundRoomSimulationForwardingClient {
  register(owner: PlaygroundRoomSimulationOwner): () => void
}

interface OwnerRegistration {
  readonly revision: number
  readonly owner: PlaygroundRoomSimulationOwner
  readonly subscriptions: Set<{
    readonly binding: PlaygroundRoomSimulationBinding
    readonly listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void
    disposeOwner?: () => void
    active: boolean
  }>
  active: boolean
}

function clone<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

function boundedHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export function isPlaygroundRoomSimulationBinding(value: unknown): value is PlaygroundRoomSimulationBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<PlaygroundRoomSimulationBinding>
  return Object.keys(input).sort().join(',') === 'bindingId,contract,generation,memberId,ownerGeneration,roomId,runId'
    && input.contract === PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT
    && boundedHandle(input.roomId)
    && boundedHandle(input.runId)
    && boundedHandle(input.memberId)
    && boundedHandle(input.bindingId)
    && boundedHandle(input.ownerGeneration)
    && boundedHandle(input.generation)
}

function unavailable(
  code: PlaygroundRoomSimulationUnavailable['code'],
  message: string,
  ownerGeneration?: string,
): PlaygroundRoomSimulationUnavailable {
  return Object.freeze({ status: 'unavailable', code, message, ...(ownerGeneration === undefined ? {} : { ownerGeneration }) })
}

function ownerError(ownerGeneration: string): PlaygroundRoomSimulationUnavailable {
  return unavailable('owner-error', 'The Playground Room simulation owner could not complete the structured request.', ownerGeneration)
}

export class PlaygroundRoomSimulationBridgeRegistry {
  private current?: OwnerRegistration
  private revision = 0
  private disposed = false

  readonly client: PlaygroundRoomSimulationForwardingClient = Object.freeze({
    status: () => this.status(),
    inspect: (binding: PlaygroundRoomSimulationBinding) => this.forward(binding, owner => owner.inspect(binding)),
    injectMessage: (binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationMessageInput) => (
      this.forward(binding, owner => owner.injectMessage(binding, operationId, clone(payload)))
    ),
    emitAgentReply: (binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationAgentReplyInput) => (
      this.forward(binding, owner => owner.emitAgentReply(binding, operationId, clone(payload)))
    ),
    emitAgentApprovalRequest: (binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationAgentApprovalRequest) => (
      this.forward(binding, owner => owner.emitAgentApprovalRequest(binding, operationId, clone(request)))
    ),
    delegateTask: (binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationTaskDelegationInput) => (
      this.forward(binding, owner => owner.delegateTask(binding, operationId, clone(request)))
    ),
    requestPermission: (binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationPermissionRequest) => (
      this.forward(binding, owner => owner.requestPermission(binding, operationId, clone(request)))
    ),
    decidePermission: (
      binding: PlaygroundRoomSimulationBinding,
      operationId: string,
      approvalId: string,
      decision: PlaygroundRoomSimulationPermissionDecision,
    ) => this.forward(binding, owner => owner.decidePermission(binding, operationId, approvalId, decision)),
    snapshot: (binding: PlaygroundRoomSimulationBinding) => this.forward(binding, owner => owner.snapshot(binding)),
    subscribe: (
      binding: PlaygroundRoomSimulationBinding,
      listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
    ) => this.subscribe(binding, listener),
  })

  status(): PlaygroundRoomSimulationBridgeStatus {
    const current = this.current
    return Object.freeze({
      installed: true,
      revision: this.revision,
      ownerState: current?.active === true ? 'available' : 'unavailable',
      ...(current?.active === true ? { ownerGeneration: current.owner.ownerGeneration } : {}),
    })
  }

  register(owner: PlaygroundRoomSimulationOwner): () => void {
    if (this.disposed) throw new Error('Playground Room simulation bridge is disposed')
    if (owner === null || typeof owner !== 'object' || !boundedHandle(owner.ownerGeneration)) {
      throw new TypeError('Playground Room simulation ownerGeneration is invalid')
    }
    if (['inspect', 'injectMessage', 'emitAgentReply', 'emitAgentApprovalRequest', 'delegateTask', 'requestPermission', 'decidePermission', 'snapshot', 'subscribe']
      .some(method => typeof owner[method as keyof PlaygroundRoomSimulationOwner] !== 'function')) {
      throw new TypeError('Playground Room simulation owner is incomplete')
    }
    this.retireCurrent('owner-replaced')
    const registration: OwnerRegistration = {
      revision: ++this.revision,
      owner,
      subscriptions: new Set(),
      active: true,
    }
    this.current = registration
    let live = true
    return () => {
      if (!live) return
      live = false
      if (this.current === registration) this.retireCurrent('owner-retired')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.retireCurrent('service-unavailable')
  }

  private async forward<Value>(
    binding: PlaygroundRoomSimulationBinding,
    call: (owner: PlaygroundRoomSimulationOwner) => MaybePromise<PlaygroundRoomSimulationResult<Value>>,
  ): Promise<PlaygroundRoomSimulationResult<Value>> {
    if (!isPlaygroundRoomSimulationBinding(binding)) return unavailable('invalid-binding', 'The Playground Room simulation binding is invalid.')
    const current = this.current
    if (this.disposed) return unavailable('service-unavailable', 'The Playground Room simulation bridge is disposed.')
    if (current?.active !== true) return unavailable('owner-unavailable', 'No Playground Chatroom owner is registered.')
    if (binding.ownerGeneration !== current.owner.ownerGeneration) {
      return unavailable('owner-retired', 'The Playground Chatroom owner generation is no longer current.', current.owner.ownerGeneration)
    }
    try {
      const result = await call(current.owner)
      if (!current.active || this.current !== current) {
        return unavailable('owner-retired', 'The Playground Chatroom owner retired before the request completed.', current.owner.ownerGeneration)
      }
      return clone(result)
    } catch {
      return ownerError(current.owner.ownerGeneration)
    }
  }

  private subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void {
    let live = true
    const emit = (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>): void => {
      if (!live) return
      try { listener(clone(event)) } catch { /* consumer errors do not cross the owner boundary */ }
    }
    if (!isPlaygroundRoomSimulationBinding(binding)) {
      queueMicrotask(() => emit(unavailable('invalid-binding', 'The Playground Room simulation binding is invalid.')))
      return () => { live = false }
    }
    const current = this.current
    if (this.disposed || current?.active !== true) {
      queueMicrotask(() => emit(unavailable(this.disposed ? 'service-unavailable' : 'owner-unavailable', this.disposed
        ? 'The Playground Room simulation bridge is disposed.'
        : 'No Playground Chatroom owner is registered.')))
      return () => { live = false }
    }
    if (binding.ownerGeneration !== current.owner.ownerGeneration) {
      queueMicrotask(() => emit(unavailable('owner-retired', 'The Playground Chatroom owner generation is no longer current.', current.owner.ownerGeneration)))
      return () => { live = false }
    }
    const subscription = { binding: clone(binding), listener: emit, active: true } as OwnerRegistration['subscriptions'] extends Set<infer Item> ? Item : never
    current.subscriptions.add(subscription)
    try {
      subscription.disposeOwner = current.owner.subscribe(clone(binding), event => {
        if (!subscription.active || !current.active || this.current !== current) return
        emit(event)
      })
    } catch {
      queueMicrotask(() => emit(ownerError(current.owner.ownerGeneration)))
    }
    return () => {
      if (!live) return
      live = false
      subscription.active = false
      current.subscriptions.delete(subscription)
      try { subscription.disposeOwner?.() } catch { /* disposal is best-effort */ }
    }
  }

  private retireCurrent(code: 'owner-replaced' | 'owner-retired' | 'service-unavailable'): void {
    const current = this.current
    if (current === undefined || !current.active) return
    current.active = false
    this.revision += 1
    if (this.current === current) this.current = undefined
    for (const subscription of current.subscriptions) {
      subscription.active = false
      try { subscription.disposeOwner?.() } catch { /* disposal is best-effort */ }
      queueMicrotask(() => subscription.listener(unavailable(
        code,
        code === 'owner-replaced'
          ? 'The Playground Chatroom owner was replaced.'
          : code === 'owner-retired'
            ? 'The Playground Chatroom owner retired.'
            : 'The Playground Room simulation bridge was disposed.',
        current.owner.ownerGeneration,
      )))
    }
    current.subscriptions.clear()
  }
}

export class CordisXPlaygroundRoomSimulationBridgeService extends Service implements PlaygroundRoomSimulationBridgeService {
  constructor(ctx: Context, private readonly registry: PlaygroundRoomSimulationBridgeRegistry) {
    super(ctx, PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE)
  }

  status(): PlaygroundRoomSimulationBridgeStatus { return this.registry.client.status() }
  inspect(binding: PlaygroundRoomSimulationBinding) { return this.registry.client.inspect(binding) }
  injectMessage(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationMessageInput) {
    return this.registry.client.injectMessage(binding, operationId, payload)
  }
  emitAgentReply(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationAgentReplyInput) {
    return this.registry.client.emitAgentReply(binding, operationId, payload)
  }
  emitAgentApprovalRequest(binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationAgentApprovalRequest) {
    return this.registry.client.emitAgentApprovalRequest(binding, operationId, request)
  }
  requestPermission(binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationPermissionRequest) {
    return this.registry.client.requestPermission(binding, operationId, request)
  }
  decidePermission(binding: PlaygroundRoomSimulationBinding, operationId: string, approvalId: string, decision: PlaygroundRoomSimulationPermissionDecision) {
    return this.registry.client.decidePermission(binding, operationId, approvalId, decision)
  }
  snapshot(binding: PlaygroundRoomSimulationBinding) { return this.registry.client.snapshot(binding) }
  subscribe(binding: PlaygroundRoomSimulationBinding, listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void) {
    return this.registry.client.subscribe(binding, listener)
  }

  register(owner: PlaygroundRoomSimulationOwner): () => void {
    const dispose = this.registry.register(owner)
    this.ctx.effect(() => dispose, `${PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE}.register(${JSON.stringify(owner.ownerGeneration)})`)
    return dispose
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly playgroundRoomSimulationBridge: PlaygroundRoomSimulationBridgeService
  }
}
