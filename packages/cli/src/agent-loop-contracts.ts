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
import type {
  AgentLoopApprovalDecisionResult as AgentLoopApprovalDecisionResultV3,
  AgentLoopCancelMemberSelfIntroductionResult as AgentLoopCancelMemberSelfIntroductionResultV3,
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV3,
  AgentLoopRequestMemberSelfIntroductionResult as AgentLoopRequestMemberSelfIntroductionResultV3,
  AgentLoopSendResult as AgentLoopSendResultV3,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV3,
  AgentLoopTaskBinding as AgentLoopTaskBindingV3,
  BoundAgentLoopClient as BoundAgentLoopClientV3,
} from '@cordisx/protocol/agent-loop/v3'
import type {
  AgentLoopApprovalDecisionResult as AgentLoopApprovalDecisionResultV4,
  AgentLoopCancelMemberSelfIntroductionResult as AgentLoopCancelMemberSelfIntroductionResultV4,
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV4,
  AgentLoopRequestMemberSelfIntroductionResult as AgentLoopRequestMemberSelfIntroductionResultV4,
  AgentLoopSendResult as AgentLoopSendResultV4,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV4,
  AgentLoopTaskBinding as AgentLoopTaskBindingV4,
  BoundAgentLoopClient as BoundAgentLoopClientV4,
} from '@cordisx/protocol/agent-loop/v4'
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
export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v3.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v3.schema.json' as const
export const CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json' as const
export const CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v4.schema.json' as const
export const CORDISX_AGENT_LOOP_RESULT_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json' as const
export const CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v4.schema.json' as const
export const CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V4 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-bound-client.v4.schema.json' as const

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

export type {
  AgentLoopCommand as AgentLoopCommandV3,
  AgentLoopEvent as AgentLoopEventV3,
  AgentLoopEventPage as AgentLoopEventPageV3,
  AgentLoopResult as AgentLoopResultV3,
  AgentLoopTaskBinding as AgentLoopTaskBindingV3,
  BoundAgentLoopClient as BoundAgentLoopClientV3,
} from '@cordisx/protocol/agent-loop/v3'

export type {
  AgentLoopAuthorizationOutcome as AgentLoopAuthorizationOutcomeV4,
  AgentLoopApprovalDecision,
  AgentLoopApprovalDecisionResult,
  AgentLoopCancelMemberSelfIntroductionResult,
  AgentLoopCommand as AgentLoopCommandV4,
  AgentLoopCreateOrBindResult as AgentLoopCreateOrBindResultV4,
  AgentLoopEvent as AgentLoopEventV4,
  AgentLoopEventPage as AgentLoopEventPageV4,
  AgentLoopEventSubscription as AgentLoopEventSubscriptionV4,
  AgentLoopMemberSelfIntroductionIntent,
  AgentLoopOperationCausation,
  AgentLoopRequestMemberSelfIntroductionResult,
  AgentLoopResult as AgentLoopResultV4,
  AgentLoopSendResult as AgentLoopSendResultV4,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV4,
  AgentLoopSubscription as AgentLoopSubscriptionV4,
  AgentLoopTaskBinding as AgentLoopTaskBindingV4,
  BoundAgentLoopClient as BoundAgentLoopClientV4,
} from '@cordisx/protocol/agent-loop/v4'

/**
 * One injected service accepts both byte-preserved v1 commands and durable v2
 * commands. The overloads keep installed consumers assignable to the exact
 * Protocol client for the version they import.
 */
export interface CompatibleBoundAgentLoopClient {
  readonly $schema: BoundAgentLoopClientV1['$schema'] & BoundAgentLoopClientV2['$schema'] & BoundAgentLoopClientV3['$schema'] & BoundAgentLoopClientV4['$schema']
  readonly contract: BoundAgentLoopClientV1['contract'] & BoundAgentLoopClientV2['contract'] & BoundAgentLoopClientV3['contract'] & BoundAgentLoopClientV4['contract']
  readonly schemaVersion: BoundAgentLoopClientV1['schemaVersion'] & BoundAgentLoopClientV2['schemaVersion'] & BoundAgentLoopClientV3['schemaVersion'] & BoundAgentLoopClientV4['schemaVersion']
  readonly durableLedger: BoundAgentLoopClientV4['durableLedger']
  createOrBind(command: Parameters<BoundAgentLoopClientV1['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV1>
  createOrBind(command: Parameters<BoundAgentLoopClientV2['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV2>
  createOrBind(command: Parameters<BoundAgentLoopClientV3['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV3>
  createOrBind(command: Parameters<BoundAgentLoopClientV4['createOrBind']>[0]): Promise<AgentLoopCreateOrBindResultV4>
  send(command: Parameters<BoundAgentLoopClientV1['send']>[0]): Promise<AgentLoopSendResultV1>
  send(command: Parameters<BoundAgentLoopClientV2['send']>[0]): Promise<AgentLoopSendResultV2>
  send(command: Parameters<BoundAgentLoopClientV3['send']>[0]): Promise<AgentLoopSendResultV3>
  send(command: Parameters<BoundAgentLoopClientV4['send']>[0]): Promise<AgentLoopSendResultV4>
  subscribe(binding: AgentLoopTaskBindingV1, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV1>
  subscribe(binding: AgentLoopTaskBindingV2, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV2>
  subscribe(binding: AgentLoopTaskBindingV3, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV3>
  subscribe(binding: AgentLoopTaskBindingV4, afterSequence: number): Promise<AgentLoopSubscribeRuntimeResultV4>
  decideApproval(command: Parameters<BoundAgentLoopClientV4['decideApproval']>[0]): Promise<AgentLoopApprovalDecisionResultV4>
  decideApproval(command: Parameters<BoundAgentLoopClientV3['decideApproval']>[0]): Promise<AgentLoopApprovalDecisionResultV3>
  requestMemberSelfIntroduction(command: Parameters<BoundAgentLoopClientV4['requestMemberSelfIntroduction']>[0]): Promise<AgentLoopRequestMemberSelfIntroductionResultV4>
  requestMemberSelfIntroduction(command: Parameters<BoundAgentLoopClientV3['requestMemberSelfIntroduction']>[0]): Promise<AgentLoopRequestMemberSelfIntroductionResultV3>
  cancelMemberSelfIntroduction(command: Parameters<BoundAgentLoopClientV4['cancelMemberSelfIntroduction']>[0]): Promise<AgentLoopCancelMemberSelfIntroductionResultV4>
  cancelMemberSelfIntroduction(command: Parameters<BoundAgentLoopClientV3['cancelMemberSelfIntroduction']>[0]): Promise<AgentLoopCancelMemberSelfIntroductionResultV3>
  dispose(): void
}

declare module '@deepseek-ai/cordis' { interface Context { readonly agentLoop: CompatibleBoundAgentLoopClient } }
export type AgentLoopContext = Context
