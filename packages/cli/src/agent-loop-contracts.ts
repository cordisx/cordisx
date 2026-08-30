import type { Context } from '@deepseek-ai/cordis'

export const CORDISX_AGENT_DEFINITION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v1.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v1.schema.json' as const

export interface AgentDefinitionIdentity { readonly agentId: string; readonly revision: string }
export type AgentInheritanceMode = 'append' | 'prepend' | 'merge' | 'replace' | 'none'
export type AgentObjectInheritanceMode = 'merge' | 'replace' | 'none'
export interface AgentFilter { readonly include?: readonly string[]; readonly exclude?: readonly string[] }
export interface AgentDefinition {
  readonly $schema: typeof CORDISX_AGENT_DEFINITION_SCHEMA_V1
  readonly contract: 'cordisx.agent-definition/v1'
  readonly schemaVersion: 1
  readonly identity: AgentDefinitionIdentity
  readonly name?: string
  readonly description?: string
  readonly extends?: readonly AgentDefinitionIdentity[]
  readonly inherit: { readonly promptSections: AgentInheritanceMode; readonly rules: AgentInheritanceMode; readonly skills: AgentInheritanceMode; readonly tools: AgentObjectInheritanceMode; readonly mcpServers: AgentObjectInheritanceMode; readonly runtimeDefaults: AgentObjectInheritanceMode }
  readonly promptSections?: readonly { readonly sectionId: string; readonly kind: 'introduction' | 'personality' | 'role' | 'operations' | 'tools' | 'knowledge' | 'memory-policy' | 'memory' | 'other'; readonly text: string }[]
  readonly rules?: readonly string[]
  readonly skills?: readonly string[]
  readonly tools?: AgentFilter
  readonly mcpServers?: AgentFilter
  readonly runtimeDefaults?: { readonly adapterId?: string; readonly model?: { readonly providerId: string; readonly modelId: string }; readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' }
}

export type AgentLoopContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image-ref'; readonly ref: string; readonly mediaType: `image/${string}`; readonly alt?: string }
export interface AgentLoopBindingIdentity { readonly bindingId: string; readonly generation: number }
export interface AgentLoopTaskBinding {
  readonly $schema: typeof CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1
  readonly contract: 'cordisx.agent-loop-task-binding/v1'
  readonly schemaVersion: 1
  readonly binding: AgentLoopBindingIdentity
  readonly definition: AgentDefinitionIdentity
  readonly task: string
  readonly state: 'active' | 'closed'
}
interface CommandBase { readonly $schema: typeof CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1; readonly contract: 'cordisx.agent-loop-command/v1'; readonly schemaVersion: 1; readonly commandId: string }
export type AgentLoopCommand =
  | (CommandBase & { readonly type: 'create-or-bind'; readonly definition: AgentDefinitionIdentity; readonly definitions: readonly [AgentDefinition, ...AgentDefinition[]]; readonly target: { readonly mode: 'create' } | { readonly mode: 'bind'; readonly task: string } })
  | (CommandBase & { readonly type: 'send'; readonly binding: AgentLoopTaskBinding; readonly content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]] })
export type AgentLoopAuthorizationOutcome =
  | { readonly capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit'; readonly state: 'allowed'; readonly code: 'allowed' }
  | { readonly capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit'; readonly state: 'denied'; readonly code: 'user-denied' | 'policy-denied' }
  | { readonly capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit'; readonly state: 'unavailable'; readonly code: 'host-unavailable' | 'task-unavailable' | 'unsupported' }
interface ResultBase { readonly $schema: typeof CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1; readonly contract: 'cordisx.agent-loop-result/v1'; readonly schemaVersion: 1; readonly commandId: string }
export type AgentLoopResult =
  | (ResultBase & { readonly type: 'create-or-bind'; readonly status: 'accepted'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'allowed' }>; readonly binding: AgentLoopTaskBinding })
  | (ResultBase & { readonly type: 'create-or-bind'; readonly status: 'denied'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'denied' }> })
  | (ResultBase & { readonly type: 'create-or-bind'; readonly status: 'unavailable'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'unavailable' }> })
  | (ResultBase & { readonly type: 'send'; readonly status: 'accepted'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'allowed' }>; readonly binding: AgentLoopTaskBinding; readonly messageId: string })
  | (ResultBase & { readonly type: 'send'; readonly status: 'denied'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'denied' }> })
  | (ResultBase & { readonly type: 'send'; readonly status: 'unavailable'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'unavailable' }> })
export type AgentLoopCreateOrBindResult = Extract<AgentLoopResult, { type: 'create-or-bind' }>
export type AgentLoopSendResult = Extract<AgentLoopResult, { type: 'send' }>
interface EventBase { readonly $schema: typeof CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1; readonly contract: 'cordisx.agent-loop-event/v1'; readonly schemaVersion: 1; readonly eventId: string; readonly binding: AgentLoopBindingIdentity; readonly sequence: number; readonly occurredAt: string; readonly turn?: string }
export type AgentLoopEvent =
  | (EventBase & { readonly type: 'message'; readonly message: { readonly messageId: string; readonly role: 'user' | 'assistant'; readonly content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]] } })
  | (EventBase & { readonly type: 'approval'; readonly turn: string; readonly approval: { readonly approvalId: string; readonly kind: 'command' | 'file-change' | 'external-action' | 'other'; readonly state: 'pending' } | { readonly approvalId: string; readonly kind: 'command' | 'file-change' | 'external-action' | 'other'; readonly state: 'resolved'; readonly outcome: 'approved' | 'denied' | 'expired' | 'cancelled' } })
  | (EventBase & { readonly type: 'lifecycle'; readonly lifecycle: { readonly phase: 'binding.created' | 'binding.bound' | 'turn.started' | 'turn.completed' | 'binding.closed' } | { readonly phase: 'turn.failed'; readonly failure: { readonly code: string; readonly retryable: boolean } } })
export interface AgentLoopEventSubscription { readonly $schema: typeof CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1; readonly contract: 'cordisx.agent-loop-event-subscription/v1'; readonly schemaVersion: 1; readonly subscriptionId: string; readonly binding: AgentLoopBindingIdentity; readonly afterSequence: number; readonly snapshotSequence: number }
export interface AgentLoopEventPage { readonly $schema: typeof CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1; readonly contract: 'cordisx.agent-loop-event-page/v1'; readonly schemaVersion: 1; readonly subscription: AgentLoopEventSubscription; readonly afterSequence: number; readonly phase: 'replay' | 'live'; readonly events: readonly AgentLoopEvent[]; readonly nextAfterSequence: number; readonly hasMore: boolean }
export interface AgentLoopSubscription { readonly subscription: AgentLoopEventSubscription; readonly pages: AsyncIterable<AgentLoopEventPage>; unsubscribe(): void }
export type AgentLoopSubscribeRuntimeResult =
  | { readonly status: 'accepted'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'allowed' }> & { readonly capability: 'tasks.content.read' }; readonly handle: AgentLoopSubscription }
  | { readonly status: 'denied'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'denied' }> & { readonly capability: 'tasks.content.read' } }
  | { readonly status: 'unavailable'; readonly authorization: Extract<AgentLoopAuthorizationOutcome, { state: 'unavailable' }> & { readonly capability: 'tasks.content.read' } }
export interface BoundAgentLoopClient {
  readonly $schema: typeof CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1
  readonly contract: 'cordisx.bound-agent-loop-client/v1'
  readonly schemaVersion: 1
  createOrBind(command: Extract<AgentLoopCommand, { type: 'create-or-bind' }>): Promise<AgentLoopCreateOrBindResult>
  send(command: Extract<AgentLoopCommand, { type: 'send' }>): Promise<AgentLoopSendResult>
  subscribe(binding: AgentLoopTaskBinding, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResult>
  dispose(): void
}

declare module '@deepseek-ai/cordis' { interface Context { readonly agentLoop: BoundAgentLoopClient } }
export type AgentLoopContext = Context
