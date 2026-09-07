import { afterEach, expect, test, vi } from 'vitest'
import {
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS,
  CodexDesktopAgentSessionTransport,
} from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'
import { AgentTaskContextMismatch } from '../packages/cli/src/agent-task-record.js'

afterEach(() => vi.unstubAllGlobals())

test('native integer approval identities abort on serverRequest/resolved without sending a late reply', async () => {
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
  vi.stubGlobal('electronBridge', {
    getSentryInitOptions: () => CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS.find(pin => pin.buildNumber === '8109'),
    sendMessageFromView: async (envelope: { type: string; request: { id: string } }) => {
      if (envelope.type === 'mcp-response') {
        responses.push(envelope)
        return
      }
      queueMicrotask(() =>
        emit({
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: envelope.request.id,
            result: { thread: { id: 'native-cancel', cwd: '/task' } },
          },
        })
      )
    },
  })
  const transport = await CodexDesktopAgentSessionTransport.connect({
    saveBinding: async () => {},
    resolveBinding: async () => undefined,
  })
  let signal!: AbortSignal
  transport!.onApprovalRequest(request => {
    signal = request.signal!
    return new Promise(resolve => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))
  })
  try {
    await transport!.create({
      owner: { pluginId: 'owner', generation: 1 },
      sessionId: 'cancel',
      options: { model: 'model' },
    })
    emit({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'native-cancel', itemId: 'exec', reason: 'Run CLI' },
      },
    })
    expect(signal.aborted).toBe(false)
    emit({
      type: 'mcp-notification',
      hostId: 'local',
      message: { method: 'serverRequest/resolved', params: { threadId: 'native-cancel', requestId: 42 } },
    })
    expect(signal.aborted).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(responses).toEqual([])
  } finally {
    transport?.dispose()
  }
})

test.each(['/resolved/task', '/wrong/task', undefined])(
  'native task creation reads back cwd %s and preserves a mismatched partial binding',
  async returnedCwd => {
    const view = new EventTarget()
    vi.stubGlobal('window', view)
    vi.stubGlobal('location', { href: 'app://-/index.html' })
    vi.stubGlobal('codexWindowType', 'electron')
    const requests: { method: string; params: Record<string, unknown> }[] = []
    vi.stubGlobal('electronBridge', {
      getSentryInitOptions: () => CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS.find(pin => pin.buildNumber === '8109'),
      sendMessageFromView: async (
        { request }: { request: { id: string; method: string; params: Record<string, unknown> } },
      ) => {
        requests.push(request)
        const event = new Event('message')
        Object.defineProperties(event, {
          source: { value: null },
          data: {
            value: {
              type: 'mcp-response',
              hostId: 'local',
              message: {
                id: request.id,
                result: { thread: { id: 'native-task', cwd: returnedCwd } },
              },
            },
          },
        })
        queueMicrotask(() => view.dispatchEvent(event))
      },
    })
    const saveBinding = vi.fn(async () => {})
    const transport = await CodexDesktopAgentSessionTransport.connect({
      saveBinding,
      resolveBinding: async () => undefined,
    })
    expect(transport).toBeDefined()
    try {
      const result = transport!.create({
        owner: { pluginId: 'owner', generation: 1 },
        sessionId: 'one',
        options: { model: 'model' },
        executionContext: { cwd: '/resolved/task' },
      })
      if (returnedCwd === '/resolved/task') await expect(result).resolves.toMatchObject({ status: 'accepted' })
      else await expect(result).rejects.toBeInstanceOf(AgentTaskContextMismatch)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ method: 'thread/start', params: { cwd: '/resolved/task' } })
      expect(saveBinding).toHaveBeenCalledWith(
        { pluginId: 'owner', generation: 1 },
        expect.objectContaining({
          sessionId: 'one',
          threadId: 'native-task',
          context: { cwd: returnedCwd ?? '' },
        }),
      )
    } finally {
      transport?.dispose()
    }
  },
)
