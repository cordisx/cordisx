import type {
  AgentLoopCommand as AgentLoopCommandV3,
  AgentLoopEvent as AgentLoopEventV3,
  AgentLoopEventPage as AgentLoopEventPageV3,
  AgentLoopResult as AgentLoopResultV3,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV3,
  AgentLoopTaskBinding as AgentLoopTaskBindingV3,
  BoundAgentLoopClient as BoundAgentLoopClientV3,
} from '@cordisx/protocol/agent-loop/v3'
import type {
  AgentLoopCommand as AgentLoopCommandV4,
  AgentLoopEvent as AgentLoopEventV4,
  AgentLoopEventPage as AgentLoopEventPageV4,
  AgentLoopResult as AgentLoopResultV4,
  AgentLoopSubscribeRuntimeResult as AgentLoopSubscribeRuntimeResultV4,
  AgentLoopTaskBinding as AgentLoopTaskBindingV4,
  BoundAgentLoopClient as BoundAgentLoopClientV4,
} from '@cordisx/protocol/agent-loop/v4'
import {
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
  CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V3,
  CORDISX_AGENT_LOOP_EVENT_SCHEMA_V3,
  CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V3,
  CORDISX_AGENT_LOOP_RESULT_SCHEMA_V3,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V3,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
  CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V3,
} from '../agent-loop-contracts.js'

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

function bindingV4(binding: AgentLoopTaskBindingV3): AgentLoopTaskBindingV4 {
  return clone({
    ...binding,
    $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V4,
    contract: 'cordisx.agent-loop-task-binding/v4' as const,
    schemaVersion: 4 as const,
  })
}

function bindingV3(binding: AgentLoopTaskBindingV4): AgentLoopTaskBindingV3 {
  return clone({
    ...binding,
    $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V3,
    contract: 'cordisx.agent-loop-task-binding/v3' as const,
    schemaVersion: 3 as const,
  })
}

function commandV4(command: AgentLoopCommandV3): AgentLoopCommandV4 {
  const base = {
    ...command,
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4' as const,
    schemaVersion: 4 as const,
  }
  if (command.type === 'create-or-bind') return clone(base as AgentLoopCommandV4)
  if (command.type === 'approval-decision') {
    return clone({
      ...base,
      binding: bindingV4(command.binding),
      decision: command.decision === 'approve' ? 'approved' : command.decision === 'deny' ? 'denied' : 'cancelled',
    } as AgentLoopCommandV4)
  }
  return clone({ ...base, binding: bindingV4(command.binding) } as AgentLoopCommandV4)
}

function resultV3(result: AgentLoopResultV4): AgentLoopResultV3 {
  const output: Record<string, unknown> = {
    ...clone(result),
    $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V3,
    contract: 'cordisx.agent-loop-result/v3',
    schemaVersion: 3,
  }
  if ('binding' in result) output.binding = bindingV3(result.binding)
  if (result.type === 'approval-decision' && result.status === 'accepted') {
    output.decision = result.decision === 'approved' ? 'approve' : result.decision === 'denied' ? 'deny' : 'cancel'
  }
  delete output.causation
  if (output.code === 'binding-closed') {
    output.status = 'conflict'
    output.code = 'binding-conflict'
  }
  return clone(output as unknown as AgentLoopResultV3)
}

function eventV3(event: AgentLoopEventV4): AgentLoopEventV3 {
  return clone(
    {
      ...event,
      $schema: CORDISX_AGENT_LOOP_EVENT_SCHEMA_V3,
      contract: 'cordisx.agent-loop-event/v3' as const,
      schemaVersion: 3 as const,
    } as AgentLoopEventV3,
  )
}

function pageV3(page: AgentLoopEventPageV4): AgentLoopEventPageV3 {
  return clone({
    ...page,
    $schema: CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V3,
    contract: 'cordisx.agent-loop-event-page/v3' as const,
    schemaVersion: 3 as const,
    subscription: {
      ...page.subscription,
      $schema: CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V3,
      contract: 'cordisx.agent-loop-event-subscription/v3' as const,
      schemaVersion: 3 as const,
    },
    events: page.events.map(eventV3),
  } as AgentLoopEventPageV3)
}

function subscribeV3(result: AgentLoopSubscribeRuntimeResultV4): AgentLoopSubscribeRuntimeResultV3 {
  if (result.status !== 'accepted') return clone(result as AgentLoopSubscribeRuntimeResultV3)
  const source = result.handle
  return Object.freeze({
    status: 'accepted' as const,
    authorization: clone(result.authorization),
    handle: Object.freeze({
      subscription: clone({
        ...source.subscription,
        $schema: CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V3,
        contract: 'cordisx.agent-loop-event-subscription/v3' as const,
        schemaVersion: 3 as const,
      }),
      pages: Object.freeze({
        async *[Symbol.asyncIterator]() {
          for await (const page of source.pages) yield pageV3(page)
        },
      }),
      unsubscribe: () => source.unsubscribe(),
    }),
  })
}

/** Frozen v3 wire facade over the same launcher-owned v4 durable authority. */
export function adaptAgentLoopV3(client: BoundAgentLoopClientV4): BoundAgentLoopClientV3 {
  const adapted: BoundAgentLoopClientV3 = {
    $schema: CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V3,
    contract: 'cordisx.bound-agent-loop-client/v3' as const,
    schemaVersion: 3 as const,
    durableLedger: client.durableLedger,
    createOrBind: async command =>
      resultV3(
        await client.createOrBind(commandV4(command) as Extract<AgentLoopCommandV4, { type: 'create-or-bind' }>),
      ) as Awaited<ReturnType<BoundAgentLoopClientV3['createOrBind']>>,
    send: async command =>
      resultV3(await client.send(commandV4(command) as Extract<AgentLoopCommandV4, { type: 'send' }>)) as Awaited<
        ReturnType<BoundAgentLoopClientV3['send']>
      >,
    decideApproval: async command =>
      resultV3(
        await client.decideApproval(commandV4(command) as Extract<AgentLoopCommandV4, { type: 'approval-decision' }>),
      ) as Awaited<ReturnType<BoundAgentLoopClientV3['decideApproval']>>,
    requestMemberSelfIntroduction: async command =>
      resultV3(
        await client.requestMemberSelfIntroduction(
          commandV4(command) as Extract<AgentLoopCommandV4, { type: 'request-member-self-introduction' }>,
        ),
      ) as Awaited<ReturnType<BoundAgentLoopClientV3['requestMemberSelfIntroduction']>>,
    cancelMemberSelfIntroduction: async command =>
      resultV3(
        await client.cancelMemberSelfIntroduction(
          commandV4(command) as Extract<AgentLoopCommandV4, { type: 'cancel-member-self-introduction' }>,
        ),
      ) as Awaited<ReturnType<BoundAgentLoopClientV3['cancelMemberSelfIntroduction']>>,
    subscribe: async (binding, afterSequence) => subscribeV3(await client.subscribe(bindingV4(binding), afterSequence)),
    dispose: () => client.dispose(),
  }
  return Object.freeze(adapted)
}
