import { describe, expect, it, vi } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { ApprovalAgentBinding } from '@cordisx/protocol/approval/v2'
import type { ApprovalRequestRoutingQuestion } from '@cordisx/protocol/approval/v3'
import type { AgentTaskApprovalHandlers } from '@cordisx/protocol/agent-task-binding/v1'
import type { ApprovalOutcome } from '@cordisx/protocol/sessions/v1'
import {
  CordisXAgentSessionRuntime,
  type CordisXDriverApprovalRequest,
  type CordisXPrivateAgentDriver,
} from '../packages/cli/src/renderer/agent-session-runtime.js'
import { HostAgentTaskApprovalRegistry } from '../packages/cli/src/renderer/agent-task-approvals.js'

const owner = { pluginId: 'owner', generation: 1 }
const definition: AgentSetup['definitions'][number] = {
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
  contract: 'cordisx.agent-definition/v1',
  schemaVersion: 1,
  identity: { agentId: 'leader', revision: 'r1' },
  inherit: {
    promptSections: 'none',
    rules: 'none',
    skills: 'none',
    tools: 'none',
    mcpServers: 'none',
    runtimeDefaults: 'none',
  },
}
const routed = (question: ApprovalRequestRoutingQuestion, authority: ApprovalAgentBinding) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json' as const,
  contract: 'cordisx.approval-request-routing-result/v1' as const,
  schemaVersion: 1 as const,
  routingId: question.routingId,
  registration: question.registration,
  status: 'accepted' as const,
  code: 'routed' as const,
  requester: question.requester,
  authority,
})
async function fixture() {
  let approve!: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>
  const driver: CordisXPrivateAgentDriver = {
    create: async () => ({ status: 'accepted' }),
    resume: async () => ({ status: 'accepted' }),
    submit: async () => 'accepted',
    discard: async () => 'accepted',
    cancel: async () => 'accepted',
    onReplacement: () => () => {},
    dispose: () => {},
    onApprovalRequest: callback => {
      approve = callback
      return () => {}
    },
  }
  const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
  const registry = new HostAgentTaskApprovalRegistry(runtime, owner, () => true, commandId => commandId === 'report')
  const create = async (sessionId: string) => {
    const result = await runtime.create(owner, {
      sessionId,
      setup: { definition: definition.identity, definitions: [definition] },
    })
    if (result.status !== 'accepted') throw new Error('fixture Agent did not create')
    return result.handle.agent
  }
  const install = async (sessionId: string) => {
    const agent = await create(sessionId)
    const request = {
      operationId: sessionId,
      definition: definition.identity,
      context: { kind: 'directory' as const, cwd: '/task' },
      text: 'Task',
      tool: { commandId: 'report', scope: { roomId: 'room', runId: sessionId } },
    }
    await registry.capture('report')!.install(agent, request, {
      operationId: sessionId,
      sessionId,
      messageId: 'm',
      fingerprint: '{}',
      context: { cwd: '/task' },
      phase: 'approval-installing',
      bindingPolicy: 'required',
    })
    return agent
  }
  return {
    runtime,
    registry,
    create,
    install,
    approve: (sessionId: string) =>
      approve({ sessionId, toolName: 'shell', callId: 'exec', reason: 'Run authenticated CLI' }),
  }
}

describe('task approval installation reuses the existing runtime authority', () => {
  it('routes root to its own human authority and child to Leader, preserving real allow/reject outcomes', async () => {
    const f = await fixture()
    let leader!: ApprovalAgentBinding
    let outcome: ApprovalOutcome = 'allowed-once'
    const answerAuthority = vi.fn(async (_question, binding) => {
      expect(binding).toEqual({ operationId: 'leader-session', toolScope: { roomId: 'room', runId: 'leader-session' } })
      expect(Object.isFrozen(binding.toolScope)).toBe(true)
      return outcome
    })
    const handlers: AgentTaskApprovalHandlers = {
      resolveRequest: (question, binding) => {
        if (binding.operationId === 'leader-session') leader = question.requester
        return routed(question, leader)
      },
      answerAuthority,
    }
    f.registry.register({ commandId: 'report' }, handlers)
    try {
      await f.install('leader-session')
      expect(answerAuthority).not.toHaveBeenCalled()
      expect(await f.approve('leader-session')).toBe('allowed-once')
      await f.install('child-session')
      outcome = 'rejected'
      expect(await f.approve('child-session')).toBe('rejected')
      expect(answerAuthority).toHaveBeenCalledTimes(2)
      const child = f.runtime.playgroundProjection().find(session => session.sessionId === 'child-session')!
      expect(child.events.find(event => event.type === 'approval/decided')).toMatchObject({
        data: { outcome: 'rejected' },
      })
    } finally {
      f.registry.dispose()
      await f.runtime.dispose()
    }
  })
  it('cleans partial installations and can install again without duplicate authority handles', async () => {
    const f = await fixture()
    const answer = vi.fn(async () => 'allowed-once' as const)
    f.registry.register({ commandId: 'report' }, {
      resolveRequest: question => routed(question, question.requester),
      answerAuthority: answer,
    })
    const spy = vi.spyOn(f.runtime, 'registerRequestResolver').mockResolvedValueOnce({
      status: 'unavailable',
      code: 'unsupported',
    })
    try {
      await expect(f.install('partial')).rejects.toThrow('resolver unavailable')
      expect(await f.approve('partial')).toBe('unavailable')
      expect(answer).not.toHaveBeenCalled()
      spy.mockRestore()
      const agent = await f.runtime.get(owner, 'partial')
      await f.registry.capture('report')!.install(agent!, {
        operationId: 'partial',
        definition: definition.identity,
        context: { kind: 'directory', cwd: '/task' },
        text: 'task',
        tool: { commandId: 'report', scope: {} },
      }, {
        operationId: 'partial',
        sessionId: 'partial',
        messageId: 'm',
        fingerprint: '{}',
        context: { cwd: '/task' },
        phase: 'approval-installing',
      })
      expect(await f.approve('partial')).toBe('allowed-once')
    } finally {
      f.registry.dispose()
      await f.runtime.dispose()
    }
  })
  it('aborts pending callbacks and rejects their late allowed outcome after unregister/replacement', async () => {
    const f = await fixture()
    let signal!: AbortSignal
    let resolve!: (outcome: ApprovalOutcome) => void
    let entered!: () => void
    const started = new Promise<void>(yes => {
      entered = yes
    })
    const unregister = f.registry.register({ commandId: 'report' }, {
      resolveRequest: question => routed(question, question.requester),
      answerAuthority: (_question, _binding, suppliedSignal) => {
        signal = suppliedSignal
        entered()
        return new Promise<ApprovalOutcome>(yes => {
          resolve = yes
        })
      },
    })
    try {
      await f.install('leader-session')
      const pending = f.approve('leader-session')
      await started
      unregister()
      expect(signal.aborted).toBe(true)
      resolve('allowed-once')
      expect(await pending).toBe('unavailable')
      expect(f.registry.capture('report')).toBeUndefined()
    } finally {
      f.registry.dispose()
      await f.runtime.dispose()
    }
  })
  it('aborts only the closed approval invocation while another question stays live', async () => {
    const f = await fixture()
    const signals = new Map<string, AbortSignal>()
    const resolves = new Map<string, (outcome: ApprovalOutcome) => void>()
    f.registry.register({ commandId: 'report' }, {
      resolveRequest: question => routed(question, question.requester),
      answerAuthority: (question, _binding, signal) => {
        signals.set(question.callId!, signal)
        return new Promise<ApprovalOutcome>(resolve => resolves.set(question.callId!, resolve))
      },
    })
    try {
      const agent = await f.install('leader-session')
      const first = new AbortController()
      const question = (callId: string, signal?: AbortSignal) =>
        f.runtime.requestApprovalV2(owner, {
          requester: { agent, definition: definition.identity },
          authority: { agent, definition: definition.identity },
          toolName: 'shell',
          callId,
          reason: { kind: 'plain-text', text: 'Explicit UI decision' },
          ...(signal === undefined ? {} : { signal }),
        })
      const a = question('a', first.signal), b = question('b')
      for (let i = 0; i < 30 && signals.size < 2; i++) await Promise.resolve()
      expect(signals.size).toBe(2)
      first.abort()
      expect(signals.get('a')!.aborted).toBe(true)
      expect(signals.get('b')!.aborted).toBe(false)
      expect((await a).outcome).toBe('cancelled')
      resolves.get('a')!('allowed-once')
      resolves.get('b')!('rejected')
      expect((await b).outcome).toBe('rejected')
      expect(signals.get('b')!.aborted).toBe(true)
    } finally {
      f.registry.dispose()
      await f.runtime.dispose()
    }
  })
  it('rejects undeclared commands without replacing an existing registration', async () => {
    const f = await fixture()
    const handlers = {
      resolveRequest: (question: ApprovalRequestRoutingQuestion) => routed(question, question.requester),
      answerAuthority: async () => 'rejected' as const,
    }
    try {
      expect(() => f.registry.register({ commandId: 'foreign' }, handlers)).toThrow('unavailable')
      f.registry.register({ commandId: 'report' }, handlers)
      expect(() => f.registry.register({ commandId: 'report' }, handlers)).toThrow('duplicate')
      expect(f.registry.capture('report')!.active()).toBe(true)
    } finally {
      f.registry.dispose()
      await f.runtime.dispose()
    }
  })
})
