import { request } from 'node:http'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

const CLI_ID = '0b5c8a52-6c6a-4a1c-b982-51a43c159cba'

/** A launched Claude profile with one Code session record, as `cordisx start claude` leaves it. */
async function claudeProfile(home: string): Promise<{ dataDir: string }> {
  const dataDir = path.join(home, 'apps', 'claude', 'profiles', 'e2e', 'data-3p')
  const sessions = path.join(dataDir, 'claude-code-sessions', 'account', 'org')
  await mkdir(sessions, { recursive: true })
  await writeFile(
    path.join(sessions, `local_${CLI_ID}.json`),
    JSON.stringify({
      sessionId: `local_${CLI_ID}`,
      cliSessionId: CLI_ID,
      title: 'Tidy README',
      cwd: '/work',
      lastActivityAt: 5,
    }),
  )
  await mkdir(path.join(home, 'run'), { recursive: true })
  await writeFile(
    path.join(home, 'run', 'claude-desktop.json'),
    JSON.stringify({
      version: 1,
      profileId: 'e2e',
      homeDir: home,
      dataDir,
    }),
  )
  return { dataDir }
}

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
    const listed = await createCodexBridgeHandler(codex)('list_sessions', { limit: 5 }) as {
      sessions: Array<{ sessionId: string; title: string; link: string }>
    }
    expect(codex.calls[0]).toEqual({ method: 'thread/list', params: { limit: 5 } })
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: 't1', title: 'Fix the build', link: 'codex://threads/t1' }),
    ])
  })

  it('reads a thread into a bounded transcript', async () => {
    const read = await createCodexBridgeHandler(fakeCodex())('read_session', { sessionId: 't1' }) as {
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
    const started = await handler('start_session', { prompt: 'build it', providerId: 'deepseek' })
    expect(started).toEqual(
      expect.objectContaining({ status: 'started', sessionId: 'new-thread', link: 'codex://threads/new-thread' }),
    )
    expect(codex.calls.map(call => call.method)).toEqual(['thread/start', 'turn/start'])
    expect(codex.calls[0]!.params).toEqual({ cwd: '/home/u', modelProvider: 'deepseek', model: 'deepseek-chat' })
    expect(codex.calls[1]!.params).toEqual({
      threadId: 'new-thread',
      input: [{ type: 'text', text: 'build it', text_elements: [] }],
    })
    expect(await handler('start_session', { prompt: 'x', providerId: 'nope' })).toEqual({
      status: 'rejected',
      reason: 'provider-not-configured',
    })
    expect(await handler('start_session', { prompt: 'x', cwd: 'relative' })).toEqual({
      status: 'rejected',
      reason: 'cwd-must-be-absolute',
    })
  })

  it('resumes an unloaded thread before sending to it', async () => {
    const codex = fakeCodex()
    await createCodexBridgeHandler(codex)('send_message', { sessionId: 'cold', prompt: 'next' })
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

  it('records the Codex profile it runs so Claude can start it again', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({ cordisxHomeDir: home, codex: fakeCodex(), codexProfileId: 'work' })
    await bridge.close()
    expect(JSON.parse(await readFile(path.join(home, 'run', 'codex-launch.json'), 'utf8'))).toEqual({
      version: 1,
      homeDir: home,
      profileId: 'work',
    })
  })

  it('writes an owner-only binding and refuses a request without its token', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({ cordisxHomeDir: home, codex: fakeCodex() })
    const binding = JSON.parse(await readFile(path.join(home, 'run', 'agent-bridge.json'), 'utf8')) as {
      socketPath: string
    }
    expect(binding.socketPath).toBe(bridge.binding.socketPath)
    expect((await stat(path.join(home, 'run', 'agent-bridge.json'))).mode & 0o777).toBe(0o600)
    expect((await post(bridge, '/sessions', { app: 'codex', operation: 'list_sessions' }, 'wrong')).status).toBe(403)
    const listed = await post(bridge, '/sessions', { app: 'codex', operation: 'list_sessions', args: {} })
    expect(listed.body.ok).toBe(true)
  })

  it('answers Claude requests from the launched profile without any Claude session', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({ cordisxHomeDir: home, codex: fakeCodex() })
    // Never launched and not allowed to start it: the agent gets a question, at once.
    expect(await bridge.call('claude', 'list_sessions', {})).toEqual(expect.objectContaining({
      status: 'needs-confirmation',
      reason: 'claude-not-running',
    }))

    const { dataDir } = await claudeProfile(home)
    expect(await bridge.call('claude', 'list_sessions', {})).toEqual({
      running: false,
      sessions: [expect.objectContaining({
        sessionId: `local_${CLI_ID}`,
        title: 'Tidy README',
        link: `claude://resume?session=${CLI_ID}`,
      })],
    })
    expect(dataDir).toContain('data-3p')
  })

  it('hands a message for a session Claude has open to that session alone', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-bridge-'))
    bridge = await startAgentBridge({
      cordisxHomeDir: home,
      codex: fakeCodex(),
      processList: async () => `claude --resume ${CLI_ID}\n`,
      runningClaudePid: async () => -1,
    })
    await claudeProfile(home)
    const message = { sessionId: `local_${CLI_ID}`, prompt: 'hi' }
    // Another session polling does not make this one reachable.
    await post(bridge, '/claude/poll', { sessionId: 'other' })
    await expect(bridge.call('claude', 'send_message', message)).rejects.toThrow(/plugin is not connected/)

    await post(bridge, '/claude/poll', { sessionId: CLI_ID })
    const pending = bridge.call('claude', 'send_message', message)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await post(bridge, '/claude/poll', { sessionId: 'other' })).body.value).toEqual({})
    const first = await post(bridge, '/claude/poll', { sessionId: CLI_ID })
    const claimed = first.body.value as { id: string; operation: string; args: unknown }
    expect(claimed).toEqual(expect.objectContaining({
      operation: 'send_message',
      args: { ...message, cliSessionId: CLI_ID },
    }))
    await post(bridge, '/claude/result', { id: claimed.id, ok: true, value: { status: 'sent' } })
    await expect(pending).resolves.toEqual({ status: 'sent' })
  })

  it('routes the generic session tools to the named app through the agent-models handler', async () => {
    const seen: Array<[string, string, unknown]> = []
    const handler = createNativeAgentModelsHandler({
      catalog: async () => [],
      controller: {} as never,
      switchThread: async () => undefined,
      reserve: () => true,
      commit: () => undefined,
      release: () => undefined,
      sessions: async (app, operation, input) => {
        seen.push([app, operation, input])
        return { sessions: [] }
      },
    })
    expect(await handler('session:list_sessions', { app: 'claude', limit: 2 })).toEqual({
      status: 'ok',
      value: { sessions: [] },
    })
    expect(seen).toEqual([['claude', 'list_sessions', { limit: 2 }]])
    expect(await handler('session:list_sessions', { app: 'zcode' })).toEqual(expect.objectContaining({
      status: 'rejected',
    }))
    expect(await handler('session:rm_rf', {})).toEqual({ status: 'rejected', reason: 'invalid-selection' })
  })
})
