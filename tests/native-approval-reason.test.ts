import { afterEach, expect, test, vi } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { ApprovalOutcome } from '@cordisx/protocol/sessions/v1'
import { nativeApprovalReason } from '../packages/cli/src/renderer/native-approval-reason.js'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { HostAgentTaskApprovalRegistry } from '../packages/cli/src/renderer/agent-task-approvals.js'
import {
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS,
  CodexDesktopAgentSessionTransport,
} from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'

afterEach(() => vi.unstubAllGlobals())

test('native approval descriptions preserve supplied facts and bound plain text', () => {
  expect(nativeApprovalReason({ reason: 'Run explicit CLI', command: 'ignored' }, 'codex.commandExecution'))
    .toBe('Run explicit CLI')
  expect(nativeApprovalReason({ command: 'cli\u0000 status', cwd: '/task' }, 'codex.commandExecution'))
    .toContain('Command: cli  status\nWorking directory: /task')
  expect(nativeApprovalReason({}, 'codex.commandExecution')).not.toContain('Command:')
  expect(nativeApprovalReason({ reason: 'x'.repeat(11000) }, 'codex.commandExecution')).toHaveLength(4000)
})

test.each([null, undefined])(
  'native reason %s reaches pending root human authority and explicit deny',
  async reason => {
    const view = new EventTarget()
    const emit = (data: unknown): void => {
      const event = new Event('message', { cancelable: true })
      Object.defineProperties(event, { source: { value: null }, data: { value: data } })
      view.dispatchEvent(event)
    }
    vi.stubGlobal('window', view)
    vi.stubGlobal('location', { href: 'app://-/index.html' })
    vi.stubGlobal('codexWindowType', 'electron')
    const responses: unknown[] = []
    let replied!: () => void
    const reply = new Promise<void>(resolve => {
      replied = resolve
    })
    vi.stubGlobal('electronBridge', {
      getSentryInitOptions: () => CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS.find(pin => pin.buildNumber === '8109'),
      sendMessageFromView: async (envelope: { type: string; request: { id: string } }) => {
        if (envelope.type === 'mcp-response') {
          responses.push(envelope)
          replied()
          return
        }
        queueMicrotask(() =>
          emit({
            type: 'mcp-response',
            hostId: 'local',
            message: { id: envelope.request.id, result: { thread: { id: 'native-root', cwd: '/task' } } },
          })
        )
      },
    })
    const transport = await CodexDesktopAgentSessionTransport.connect({
      saveBinding: async () => {},
      resolveBinding: async () => undefined,
    })
    if (transport === undefined) throw new Error('Missing transport')
    const runtime = new CordisXAgentSessionRuntime({ driver: transport, authorize: async () => true })
    const owner = { pluginId: 'owner', generation: 1 }
    const registry = new HostAgentTaskApprovalRegistry(runtime, owner, () => true, () => true)
    const definition: AgentSetup['definitions'][number] = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
      contract: 'cordisx.agent-definition/v1',
      schemaVersion: 1,
      identity: { agentId: 'root', revision: 'r1' },
      inherit: {
        promptSections: 'none',
        rules: 'none',
        skills: 'none',
        tools: 'none',
        mcpServers: 'none',
        runtimeDefaults: 'none',
      },
    }
    let entered!: () => void
    const pending = new Promise<void>(resolve => {
      entered = resolve
    })
    let deny!: (outcome: ApprovalOutcome) => void
    registry.register({ commandId: 'report' }, {
      resolveRequest: question => ({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
        contract: 'cordisx.approval-request-routing-result/v1',
        schemaVersion: 1,
        routingId: question.routingId,
        registration: question.registration,
        status: 'accepted',
        code: 'routed',
        requester: question.requester,
        authority: question.requester,
      }),
      answerAuthority: question => {
        expect(question.reason.text).toContain('Command: cli status')
        expect(question.reason.text).toContain('Working directory: /task')
        entered()
        return new Promise<ApprovalOutcome>(resolve => {
          deny = resolve
        })
      },
    })
    try {
      const created = await runtime.create(owner, {
        sessionId: 'root',
        options: { model: 'gpt-test' },
        setup: { definition: definition.identity, definitions: [definition] },
      })
      if (created.status !== 'accepted') throw new Error('Missing root')
      await registry.capture('report')!.install(created.handle.agent, {
        operationId: 'op',
        definition: definition.identity,
        context: { kind: 'directory', cwd: '/task' },
        text: 'Task',
        tool: { commandId: 'report', scope: {} },
      }, {
        operationId: 'op',
        sessionId: 'root',
        messageId: 'm',
        fingerprint: '{}',
        context: { cwd: '/task' },
        phase: 'approval-installing',
        bindingPolicy: 'required',
      })
      emit({
        type: 'mcp-request',
        hostId: 'local',
        request: {
          id: 81,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'native-root',
            itemId: 'exec',
            command: 'cli status',
            cwd: '/task',
            ...(reason === undefined ? {} : { reason }),
          },
        },
      })
      await pending
      expect(responses).toEqual([])
      deny('rejected')
      await reply
      expect(responses).toMatchObject([{ response: { id: 81, result: { decision: 'decline' } } }])
    } finally {
      registry.dispose()
      await runtime.dispose()
    }
  },
)
