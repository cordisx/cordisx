import type {
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV1,
  AgentLoopSendResult as AgentLoopSendResultV1,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV1,
  AgentLoopTaskBinding as AgentLoopTaskBindingV1,
  BoundAgentLoopClient as BoundAgentLoopClientV1,
} from '@cordisx/protocol/agent-loop/v1'
import type {
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV2,
  AgentLoopSendResult as AgentLoopSendResultV2,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV2,
  AgentLoopTaskBinding as AgentLoopTaskBindingV2,
  BoundAgentLoopClient as BoundAgentLoopClientV2,
} from '@cordisx/protocol/agent-loop/v2'
import type { Context } from '@deepseek-ai/cordis'

export const CORDISX_AGENT_DEFINITION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v1.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v1.schema.json' as const

export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v2.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v2.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v2.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v2.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v2.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v2.schema.json' as const

export type {
  AgentDefinition,
  AgentDefinitionIdentity,
  AgentFilter,
  AgentInheritanceMode,
  AgentLoopAuthorizationOutcome,
  AgentLoopBindingIdentity,
  AgentLoopCommand,
  AgentLoopContentPart,
  AgentLoopCreateOrBindResult,
  AgentLoopEvent,
  AgentLoopEventPage,
  AgentLoopEventSubscription,
  AgentLoopResult,
  AgentLoopSendResult,
  AgentLoopSubscribeRuntimeResult,
  AgentLoopSubscription,
  AgentLoopTaskBinding,
  AgentObjectInheritanceMode,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v1'

export type {
  AgentLoopCommand as AgentLoopCommandV2,
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV2,
  AgentLoopDelivery,
  AgentLoopDeliveryDisposition,
  AgentLoopEvent as AgentLoopEventV2,
  AgentLoopEventPage as AgentLoopEventPageV2,
  AgentLoopEventSubscription as AgentLoopEventSubscriptionV2,
  AgentLoopOperationId,
  AgentLoopOperationUnavailableCode,
  AgentLoopResult as AgentLoopResultV2,
  AgentLoopSendResult as AgentLoopSendResultV2,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV2,
  AgentLoopSubscription as AgentLoopSubscriptionV2,
  AgentLoopTaskBinding as AgentLoopTaskBindingV2,
  AgentLoopTaskDetailsUrl,
  BoundAgentLoopClient as BoundAgentLoopClientV2,
} from '@cordisx/protocol/agent-loop/v2'

/**
 * One injected service accepts both byte-preserved v1 commands and durable v2
 * commands. The overloads keep installed consumers assignable to the exact
 * Protocol client for the version they import.
 */
export interface CompatibleBoundAgentLoopClient {
  readonly $schema: BoundAgentLoopClientV1['$schema'] & BoundAgentLoopClientV2['$schema']
  readonly contract: BoundAgentLoopClientV1['contract'] & BoundAgentLoopClientV2['contract']
  readonly schemaVersion: BoundAgentLoopClientV1['schemaVersion'] & BoundAgentLoopClientV2['schemaVersion']
  readonly durableLedger: BoundAgentLoopClientV2['durableLedger']
  createOrBind(command: Parameters<BoundAgentLoopClientV1['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV1>
  createOrBind(command: Parameters<BoundAgentLoopClientV2['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV2>
  send(command: Parameters<BoundAgentLoopClientV1['send']>[0]): Promise<AgentLoopSendResultV1>
  send(command: Parameters<BoundAgentLoopClientV2['send']>[0]): Promise<AgentLoopSendResultV2>
  subscribe(binding: AgentLoopTaskBindingV1, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV1>
  subscribe(binding: AgentLoopTaskBindingV2, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV2>
  dispose(): void
}

declare module '@deepseek-ai/cordis' { interface Context { readonly agentLoop: CompatibleBoundAgentLoopClient } }
export type AgentLoopContext = Context
