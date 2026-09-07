import { afterEach, expect, test, vi } from 'vitest'
import {
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS,
  CodexDesktopAgentSessionTransport,
} from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'
import { AgentTaskContextMismatch } from '../packages/cli/src/agent-task-record.js'

afterEach(() => vi.unstubAllGlobals())

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
