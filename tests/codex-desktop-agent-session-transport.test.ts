import { afterEach, describe, expect, it } from 'vitest'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import {
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN,
  CodexDesktopAgentSessionTransport,
} from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'

class TestWindow extends EventTarget {
  readonly location = { href: 'app://-/index.html' }
  message(data: unknown): Event {
    const event = new Event('message', { cancelable: true }) as Event & { data: unknown; source: unknown }
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: this },
    })
    this.dispatchEvent(event)
    return event
  }
}

const originals = new Map<string, PropertyDescriptor | undefined>()
function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  originals.clear()
})

const user = (id: string, value: string): UserMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: value }],
  source: { kind: 'user' },
})
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('Codex Desktop Agent/Session transport', () => {
  it('uses the existing bridge for commands, notifications, approvals, queueing, and first-terminal delivery', async () => {
    const view = new TestWindow()
    const sent: Record<string, unknown>[] = []
    let turnStarts = 0
    const bridge = {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN }),
      sendMessageFromView: async (value: unknown) => {
        const envelope = structuredClone(value) as Record<string, unknown>
        sent.push(envelope)
        if (envelope.type !== 'mcp-request') return
        const request = envelope.request as Record<string, unknown>
        const method = request.method as string
        const result = method === 'thread/start'
          ? { thread: { id: 'native-thread-1' } }
          : method === 'turn/start'
          ? { turn: { id: `native-turn-${++turnStarts}` } }
          : {}
        queueMicrotask(() =>
          view.message({
            type: 'mcp-response',
            hostId: 'local',
            message: { id: request.id, result },
          })
        )
      },
    }
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', bridge)

    const transport = await CodexDesktopAgentSessionTransport.connect()
    expect(transport).toBeDefined()
    if (transport === undefined) throw new Error('transport did not connect')
    const events: string[] = []
    const statuses: string[] = []
    const claims: string[] = []
    transport.onSessionEvent(event => events.push(event.type))
    transport.onAgentStatus(event => statuses.push(event.status))
    transport.onMessageClaimed(event => claims.push(event.messageId))
    transport.onApprovalRequest(async request => request.callId === 'tool-approval' ? 'allowed-once' : 'unavailable')

    expect(await transport.create({ sessionId: 'session-1', options: { model: 'gpt-test' } })).toMatchObject({
      status: 'accepted',
      detail: { kind: 'host', ref: 'codex-thread:native-thread-1' },
    })
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-1', 'first'),
        target: 'next-turn',
        wakeup: true,
      }),
    ).toBe('accepted')
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/started',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-1', status: 'inProgress' } },
      },
    })
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-2', 'queued'),
        target: 'next-turn',
        wakeup: true,
      }),
    ).toBe('accepted')
    expect(turnStarts).toBe(1)
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-3', 'steer'),
        target: 'next-step',
        wakeup: true,
      }),
    ).toBe('accepted')
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-4', 'inject'),
        target: 'next-step',
        wakeup: false,
      }),
    ).toBe('accepted')
    expect(sent.filter(item => (item.request as Record<string, unknown> | undefined)?.method === 'turn/steer'))
      .toHaveLength(1)
    expect(sent.filter(item => (item.request as Record<string, unknown> | undefined)?.method === 'thread/inject_items'))
      .toHaveLength(1)

    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/agentMessage/delta',
        params: { threadId: 'native-thread-1', turnId: 'native-turn-1', itemId: 'assistant-1', delta: 'hello' },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/completed',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: { type: 'agentMessage', id: 'assistant-1', text: 'hello' },
        },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/started',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', status: 'inProgress' },
        },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/completed',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: {
            type: 'commandExecution',
            id: 'tool-1',
            command: 'pwd',
            status: 'completed',
            aggregatedOutput: '/tmp',
          },
        },
      },
    })

    const approvalEvent = view.message({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'native-thread-1', turnId: 'native-turn-1', itemId: 'tool-approval' },
      },
    })
    const responseCountBeforeUnknown = sent.filter(item => item.type === 'mcp-response').length
    view.message({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 'foreign-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'foreign-thread', itemId: 'foreign-tool' },
      },
    })
    await settle()
    expect(approvalEvent.defaultPrevented).toBe(true)
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'mcp-response',
      response: { id: 'approval-1', result: { decision: 'accept' } },
    }))
    expect(sent.filter(item => item.type === 'mcp-response')).toHaveLength(responseCountBeforeUnknown + 1)

    const completed = {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/completed',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-1', status: 'completed' } },
      },
    }
    view.message(completed)
    view.message(completed)
    await settle()
    expect(turnStarts).toBe(2)
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/started',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-2', status: 'inProgress' } },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/completed',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-2', status: 'completed' } },
      },
    })
    await settle()

    expect(events).toEqual([
      'turn/start',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'step/end',
      'turn/end',
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(new Set(claims)).toEqual(new Set(['m-1', 'm-2', 'm-3', 'm-4']))

    let replacements = 0
    transport.onReplacement(() => {
      replacements += 1
    })
    view.message({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' })
    expect(replacements).toBe(1)
    transport.dispose()
  })

  it('fails closed outside the exact audited Desktop build', async () => {
    const view = new TestWindow()
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN, buildNumber: 'other' }),
      sendMessageFromView: async () => {},
    })
    expect(await CodexDesktopAgentSessionTransport.connect()).toBeUndefined()
  })
})
