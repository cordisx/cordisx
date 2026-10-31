import { request } from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AgentBridge,
  type AgentBridgeCodexAuthority,
  createCodexBridgeHandler,
  startAgentBridge,
  threadTranscript,
} from '../packages/cli/src/launcher/agent-bridge.js'
import { createNativeAgentModelsHandler } from '../packages/cli/src/launcher/native-agent-models.js'

function fakeCodex(): AgentBridgeCodexAuthority & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    async catalog() {
      return [{
        providerId: 'deepseek',
        pluginId: 'cordisx.model-service',
        title: 'DeepSeek',
        models: [{ id: 'deepseek-chat', label: 'deepseek-chat', aliases: [] }],
        defaultModelId: 'deepseek-chat',
      }]
    },
    async nativeRequest(method, params) {
      calls.push({ method, params })
      if (method === 'thread/list') {
        return {
          data: [{ id: 't1', name: 'Fix the build', cwd: '/w', modelProvider: 'openai', status: { type: 'idle' } }],
        }
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 't1',
            status: { type: (params as { threadId: string }).threadId === 'loaded' ? 'idle' : 'notLoaded' },
            turns: [{
              items: [
                { type: 'userMessage', content: [{ type: 'text', text: 'please fix' }] },
                { type: 'commandExecution', command: 'npm test' },
                { type: 'agentMessage', text: 'fixed' },
              ],
            }],
          },
        }
      }
      if (method === 'thread/start') {
        return { thread: { id: 'new-thread' }, modelProvider: (params as { modelProvider?: string }).modelProvider }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      return {}
    },
  }
}

describe('Codex side of the agent bridge', () => {
  it('lists threads with clickable codex links', async () => {
    const codex = fakeCodex()
    const listed = await createCodexBridgeHandler(codex)('list_threads', { limit: 5 }) as {
      threads: Array<{ threadId: string; title: string; link: string }>
    }
    expect(codex.calls[0]).toEqual({ method: 'thread/list', params: { limit: 5 } })
    expect(listed.threads).toEqual([
      expect.objectContaining({ threadId: 't1', title: 'Fix the build', link: 'codex://threads/t1' }),
    ])
  })

  it('reads a thread into a bounded transcript', async () => {
    const read = await createCodexBridgeHandler(fakeCodex())('read_thread', { threadId: 't1' }) as {
      transcript: Array<{ role: string; text: string }>
    }
    expect(read.transcript).toEqual([
      { role: 'user', text: 'please fix' },
      { role: 'command', text: 'npm test' },
      { role: 'assistant', text: 'fixed' },
    ])
    const long = threadTranscript({ turns: [{ items: [{ type: 'agentMessage', text: 'x'.repeat(100_000) }] }] })
    expect(long[0]!.text.length).toBeLessThanOrEqual(60_001)
  })

  it('starts a thread on a declared provider and refuses one outside the catalog', async () => {
    const codex = fakeCodex()
    const handler = createCodexBridgeHandler(codex, '/home/u')
    const started = await handler('start_thread', { prompt: 'build it', providerId: 'deepseek' })
    expect(started).toEqual(
      expect.objectContaining({ status: 'started', threadId: 'new-thread', link: 'codex://threads/new-thread' }),
    )
    expect(codex.calls.map(call => call.method)).toEqual(['thread/start', 'turn/start'])
    expect(codex.calls[0]!.params).toEqual({ cwd: '/home/u', modelProvider: 'deepseek', model: 'deepseek-chat' })
    expect(codex.calls[1]!.params).toEqual({
      threadId: 'new-thread',
      input: [{ type: 'text', text: 'build it', text_elements: [] }],
    })
    expect(await handler('start_thread', { prompt: 'x', providerId: 'nope' })).toEqual({
      status: 'rejected',
      reason: 'provider-not-configured',
    })
    expect(await handler('start_thread', { prompt: 'x', cwd: 'relative' })).toEqual({
      status: 'rejected',
      reason: 'cwd-must-be-absolute',
    })
  })

  it('resumes an unloaded thread before sending to it', async () => {
    const codex = fakeCodex()
    await createCodexBridgeHandler(codex)('send_message', { threadId: 'cold', prompt: 'next' })
    expect(codex.calls.map(call => call.method)).toEqual(['thread/read', 'thread/resume', 'turn/start'])
  })
})

function post(bridge: AgentBridge, route: string, body: unknown, token = bridge.binding.token): Promise<{
  status: number
  body: { ok: boolean; value?: unknown; error?: string }
}> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: bridge.binding.socketPath,
      path: route,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cordisx-bridge-token': token },
    }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => data += chunk)
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('agent bridge transport', () => {
  let bridge: AgentBridge | undefined
  afterEach(async () => {
    await bridge?.close()
    bridge = undefined
  })

  it('writes an owner-only binding and refuses a request without its token', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({ cordisxHomeDir: home, codex: fakeCodex() })
    const binding = JSON.parse(await readFile(path.join(home, 'run', 'agent-bridge.json'), 'utf8')) as {
      socketPath: string
    }
    expect(binding.socketPath).toBe(bridge.binding.socketPath)
    expect((await stat(path.join(home, 'run', 'agent-bridge.json'))).mode & 0o777).toBe(0o600)
    expect((await post(bridge, '/codex', { operation: 'list_threads' }, 'wrong')).status).toBe(403)
    const listed = await post(bridge, '/codex', { operation: 'list_threads', args: {} })
    expect(listed.body.ok).toBe(true)
  })

  it('hands a Codex agent request to one polling Claude session and returns its answer', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({ cordisxHomeDir: home, codex: fakeCodex() })
    await expect(bridge.callClaude('list_sessions', {})).rejects.toThrow(/No Claude Code session is connected/)

    await post(bridge, '/claude/poll', { sessionId: 'local_a' })
    const pending = bridge.callClaude('list_sessions', { limit: 3 })
    const first = await post(bridge, '/claude/poll', { sessionId: 'local_a' })
    const claimed = first.body.value as { id: string; operation: string; args: unknown }
    expect(claimed).toEqual(expect.objectContaining({ operation: 'list_sessions', args: { limit: 3 } }))
    // A second session does not get the same request.
    expect((await post(bridge, '/claude/poll', { sessionId: 'local_b' })).body.value).toEqual({})
    await post(bridge, '/claude/result', { id: claimed.id, ok: true, value: { sessions: ['x'] } })
    await expect(pending).resolves.toEqual({ sessions: ['x'] })
  })

  it('routes the Codex agent tools to the bridge through the agent-models handler', async () => {
    const seen: Array<[string, unknown]> = []
    const handler = createNativeAgentModelsHandler({
      catalog: async () => [],
      controller: {} as never,
      switchThread: async () => undefined,
      reserve: () => true,
      commit: () => undefined,
      release: () => undefined,
      claude: async (operation, input) => {
        seen.push([operation, input])
        return { sessions: [] }
      },
    })
    expect(await handler('claude:list_sessions', { limit: 2 })).toEqual({ status: 'ok', value: { sessions: [] } })
    expect(seen).toEqual([['list_sessions', { limit: 2 }]])
    expect(await handler('claude:rm_rf', {})).toEqual({ status: 'rejected', reason: 'invalid-selection' })
  })
})
