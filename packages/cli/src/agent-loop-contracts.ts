import type { BoundAgentLoopClient } from '@cordisx/protocol/agent-loop/v1'
import type { Context } from '@deepseek-ai/cordis'

export const CORDISX_AGENT_DEFINITION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v1.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v1.schema.json' as const

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

declare module '@deepseek-ai/cordis' { interface Context { readonly agentLoop: BoundAgentLoopClient } }
export type AgentLoopContext = Context
