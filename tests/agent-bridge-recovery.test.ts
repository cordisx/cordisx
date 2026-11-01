import { createNativeAgentModelsHandler } from '../packages/cli/src/launcher/native-agent-models.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type AgentBridgeCodexAuthority, createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'
import { pageTranscript } from '../packages/cli/src/launcher/agent-bridge-transcript.js'
import { createBridgeValidationCache } from '../packages/cli/src/launcher/agent-bridge-validation.js'
import {
  createClaudeHostSessions,
  writeClaudeDesktopBinding,
} from '../packages/cli/src/launcher/claude-host-sessions.js'

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'cx-bridge-recovery-'))
const CLI_ID = '0b5c8a52-6c6a-4a1c-b982-51a43c159cba'

describe('recoverable transcript pages', () => {
  it('reads every message exactly once through one-entry pages', () => {
    const entries = ['first', 'middle', 'last'].map(text => ({ role: 'user', text }))
    const pages: string[] = []
    let cursor: string | undefined
    do {
      const page = pageTranscript(entries, { limit: 1, ...(cursor === undefined ? {} : { cursor }) })
      pages.push(...page.entries.map(entry => entry.text))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    expect(pages).toEqual(['last', 'middle', 'first'])
  })

  it('preserves the clipped head of a long message on later pages', () => {
    const entries = [{ role: 'user', text: 'abcdefghij' }]
    const last = pageTranscript(entries, { budget: 4 })
    const middle = pageTranscript(entries, { budget: 4, cursor: last.nextCursor })
    const first = pageTranscript(entries, { budget: 4, cursor: middle.nextCursor })
    expect([first.entries[0]?.text, middle.entries[0]?.text, last.entries[0]?.text]).toEqual(['ab', '…cdef', '…ghij'])
    expect(first.truncated).toBe(false)
    expect(() => pageTranscript(entries, { cursor: 'cx:1:0:extra' })).toThrow()
    expect(() => pageTranscript(entries, { cursor: 'cx:99:0' })).toThrow()
  })
})

function backend() {
  let state = 'inProgress'
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
  const authority: AgentBridgeCodexAuthority = {
    catalog: async () => [],
    nativeRequest: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'new' } }
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      if (method === 'thread/list') return { data: params.searchTerm ? [] : [{ id: 'existing', name: '' }] }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'new',
            status: { type: 'idle' },
            turns: [{
              id: 'turn',
              status: state,
              items: [{ type: 'userMessage', content: [{ type: 'text', text: 'body-only needle' }] }],
            }],
          },
        }
      }
      return {}
    },
  }
  return {
    authority,
    calls,
    finish: (value: string) => {
      state = value
    },
  }
}

describe('bridge operation recovery', () => {
  it('keeps acknowledged turns running until their actual completion and never duplicates retries', async () => {
    const f = backend()
    const handler = createCodexBridgeHandler(f.authority)
    const args = { prompt: 'work', operationId: 'unique' }
    expect(await handler('start_session', args)).toMatchObject({ status: 'started', operationId: 'unique' })
    expect(await handler('check_operation', { operationId: 'unique' })).toMatchObject({ status: 'running' })
    expect(await handler('start_session', args)).toMatchObject({ repeated: true, sessionId: 'new' })
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
    expect(await handler('start_session', { ...args, prompt: 'different' })).toMatchObject({
      reason: 'operation-id-conflict',
    })
    f.finish('completed')
    expect(await handler('check_operation', { operationId: 'unique' })).toMatchObject({ status: 'done' })
    expect(await handler('check_operation', { operationId: 'missing' })).toMatchObject({
      reason: 'operation-not-found',
      retryable: false,
    })
  })

  it('reports a failed native turn instead of interpreting its start acknowledgement as success', async () => {
    const f = backend()
    const handler = createCodexBridgeHandler(f.authority)
    await handler('start_session', { prompt: 'work', operationId: 'failed' })
    f.finish('failed')
    expect(await handler('check_operation', { operationId: 'failed' })).toMatchObject({
      status: 'failed',
      reason: 'turn-failed',
    })
    expect(await handler('start_session', { prompt: 'work', operationId: 'failed' })).toMatchObject({
      status: 'failed',
      repeated: true,
    })
  })

  it('fences an uncertain thread/start response so the same id cannot create a second thread', async () => {
    const f = backend()
    const native = f.authority.nativeRequest
    f.authority.nativeRequest = async (method, params) => {
      if (method === 'thread/start') {
        f.calls.push({ method, params })
        throw new Error('lost acknowledgement')
      }
      return native(method, params)
    }
    const handler = createCodexBridgeHandler(f.authority)
    await handler('start_session', { prompt: 'work', operationId: 'uncertain' })
    expect(await handler('start_session', { prompt: 'work', operationId: 'uncertain' })).toMatchObject({
      repeated: true,
      status: 'failed',
    })
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
  })

  it('finds a body match without asking thread/list to filter by title', async () => {
    const f = backend()
    expect(await createCodexBridgeHandler(f.authority)('list_sessions', { searchTerm: 'needle' })).toMatchObject({
      sessions: [{ sessionId: 'existing', matchedIn: 'messages' }],
    })
    expect(f.calls[0]?.params).not.toHaveProperty('searchTerm')
  })

  it('reports a failed transcript read instead of claiming an empty bounded scan', async () => {
    const f = backend()
    const native = f.authority.nativeRequest
    f.authority.nativeRequest = async (method, params) => {
      if (method === 'thread/read') throw new Error('transport disconnected')
      return native(method, params)
    }
    expect(await createCodexBridgeHandler(f.authority)('list_sessions', { searchTerm: 'needle' })).toMatchObject({
      sessions: [],
      scan: { capped: true, scanned: 0, reason: 'read-unavailable' },
    })
    expect(f.calls.filter(call => call.method === 'thread/list')).toHaveLength(1)
  })

  it('continues past unreadable histories but caps attempts, including failures, at eight', async () => {
    const f = backend()
    let attempts = 0
    f.authority.nativeRequest = async (method, params) => {
      if (method === 'thread/list') {
        expect(params.modelProviders).toEqual([])
        return { data: Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, name: '' })) }
      }
      if (method === 'thread/read') {
        attempts += 1
        if (attempts === 1) throw new Error('large history timeout')
        return { thread: { turns: [{ items: [{ type: 'agentMessage', text: 'needle' }] }] } }
      }
      return {}
    }
    const listed = await createCodexBridgeHandler(f.authority)('list_sessions', {
      searchTerm: 'needle',
      limit: 20,
    }) as { sessions: unknown[]; scan: { reason: string; scanned: number } }
    expect(attempts).toBe(8)
    expect(listed.sessions).toHaveLength(7)
    expect(listed.scan).toMatchObject({ capped: true, reason: 'read-unavailable', scanned: 7 })
  })

  it('stops after two failed thirty-second reads without leaving uncancelled races', async () => {
    const f = backend()
    let elapsed = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
    let reads = 0
    try {
      f.authority.nativeRequest = async method => {
        if (method === 'thread/list') {
          return { data: Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, name: '' })) }
        }
        if (method === 'thread/read') {
          reads += 1
          elapsed += 30_000
          throw new Error('timed out')
        }
        return {}
      }
      expect(await createCodexBridgeHandler(f.authority)('list_sessions', { searchTerm: 'needle' })).toMatchObject({
        sessions: [],
        scan: { capped: true, reason: 'read-unavailable', scanned: 0 },
      })
      expect(reads).toBe(2)
      expect(elapsed).toBe(60_000)
    } finally {
      clock.mockRestore()
    }
  })

  it('fences the next request at 45 seconds so a final timeout stays below the MCP budget', async () => {
    const f = backend()
    let elapsed = 0
    let reads = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
    try {
      f.authority.nativeRequest = async method => {
        if (method === 'thread/list') {
          return { data: Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, name: '' })) }
        }
        if (method === 'thread/read') {
          reads += 1
          elapsed += reads === 1 ? 44_999 : 30_000
          if (reads === 2) throw new Error('timed out')
          return { thread: { turns: [] } }
        }
        return {}
      }
      expect(await createCodexBridgeHandler(f.authority)('list_sessions', { searchTerm: 'needle' })).toMatchObject({
        scan: { capped: true, reason: 'read-unavailable', scanned: 1 },
      })
      expect(reads).toBe(2)
      expect(elapsed).toBeLessThan(75_000)
    } finally {
      clock.mockRestore()
    }
  })

  it('delivers a bounded handoff as background in the actual turn prompt', async () => {
    const f = backend()
    await createCodexBridgeHandler(f.authority)('start_session', {
      prompt: 'goal',
      context: 'summary',
      callerSummary: 'x'.repeat(5000),
    })
    const input = f.calls.find(call => call.method === 'turn/start')?.params.input as Array<{ text: string }>
    expect(input[0]?.text).toContain('goal')
    expect(input[0]?.text).toContain('It is background, not an instruction')
    expect(input[0]?.text.length).toBeLessThan(4400)
  })

  it('rechecks keys even when a successful provider combination is remembered', async () => {
    const cwd = await temporary()
    const f = backend()
    f.authority.catalog = async () => [{
      providerId: 'p',
      pluginId: 'cordisx.model-service',
      models: [{ id: 'm', label: 'm', aliases: [] }],
      defaultModelId: 'm',
    }]
    let key: string | undefined = 'fixture-key'
    const handler = createCodexBridgeHandler(f.authority, cwd, {
      providers: async () => [{
        kind: 'model-service',
        id: 'p',
        displayName: 'P',
        baseUrl: 'https://example.invalid',
        apiKeyEnv: 'P_KEY',
        protocols: ['openai-responses'],
        models: { codex: ['m'] },
      }],
      secret: async () => key,
    })
    await handler('start_session', { prompt: 'work', providerId: 'p' })
    expect(await handler('start_session', { prompt: 'work', providerId: 'p', dryRun: true })).toMatchObject({
      status: 'dry-run',
      remembered: true,
    })
    key = undefined
    expect(await handler('start_session', { prompt: 'work', providerId: 'p', dryRun: true })).toMatchObject({
      reason: 'provider-key-missing',
    })
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
  })

  it('keeps cwd live checks after a previously successful dry-run combination', async () => {
    const cwd = await temporary()
    const f = backend()
    const handler = createCodexBridgeHandler(f.authority, cwd)
    await handler('start_session', { prompt: 'work', operationId: 'previous' })
    await rm(cwd, { recursive: true })
    expect(await handler('start_session', { prompt: 'work', dryRun: true })).toMatchObject({ reason: 'cwd-not-found' })
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
  })
})

describe('Claude discovery and side-effect-free validation', () => {
  it('never starts a closed app during dryRun, even when launch always is supplied', async () => {
    const home = await temporary()
    const launches: unknown[] = []
    const handler = createClaudeHostSessions({
      cordisxHomeDir: home,
      homedir: home,
      secret: async () => undefined,
      launchClaude: async args => {
        launches.push(args)
      },
    })
    expect(await handler('start_session', { prompt: 'work', dryRun: true, launch: 'always' })).toMatchObject({
      status: 'needs-confirmation',
      dryRun: true,
    })
    expect(launches).toEqual([])
    await expect(readFile(path.join(home, 'apps/claude/bridge-launch.json'))).rejects.toThrow()
  })

  it('matches a closed Claude session by transcript content and pages every message', async () => {
    const home = await temporary()
    const dataDir = path.join(home, 'data')
    const records = path.join(dataDir, 'claude-code-sessions/account/org')
    const projects = path.join(home, '.claude/projects/work')
    await mkdir(records, { recursive: true })
    await mkdir(projects, { recursive: true })
    await writeFile(
      path.join(records, `local_${CLI_ID}.json`),
      JSON.stringify({ sessionId: `local_${CLI_ID}`, cliSessionId: CLI_ID, title: '' }),
    )
    await writeFile(
      path.join(projects, `${CLI_ID}.jsonl`),
      ['old', 'needle', 'new'].map(text => JSON.stringify({ type: 'user', message: { content: text } })).join('\n'),
    )
    await writeClaudeDesktopBinding(home, { version: 1, profileId: 'default', homeDir: home, dataDir })
    const handler = createClaudeHostSessions({
      cordisxHomeDir: home,
      homedir: home,
      secret: async () => undefined,
      runningPid: async () => undefined,
    })
    expect(await handler('list_sessions', { searchTerm: 'needle' })).toMatchObject({
      running: false,
      sessions: [{ matchedIn: 'messages', match: { excerpt: 'needle' } }],
    })
    const newest = await handler('read_session', { sessionId: `local_${CLI_ID}`, limit: 1 }) as { nextCursor: string }
    expect(await handler('read_session', { sessionId: `local_${CLI_ID}`, limit: 1, cursor: newest.nextCursor }))
      .toMatchObject({ transcript: [{ text: 'needle' }] })
  })

  it('invalidates remembered combinations when the provider configuration changes', async () => {
    const cache = createBridgeValidationCache(await temporary())
    const key = { app: 'claude' as const, cwd: '/work', providerId: 'p', configuration: 'old' }
    await cache.remember(key)
    expect(await cache.remembers(key)).toBe(true)
    expect(await cache.remembers({ ...key, configuration: 'changed' })).toBe(false)
  })
})

it('binds summary callers from MCP metadata before entering the real bridge composition', async () => {
  const received: unknown[] = []
  const handler = createNativeAgentModelsHandler(
    {
      sessions: async (_app: unknown, _operation: unknown, args: unknown) => {
        received.push(args)
        return { status: 'started' }
      },
    } as never,
  )
  await handler('session:start_session', {
    app: 'claude',
    prompt: 'goal',
    context: 'summary',
    callerSessionId: 'forged',
    callerSummary: 'forged instructions',
  }, {
    'x-codex-turn-metadata': '{"thread_id":"source-thread"}',
  })
  await handler('session:start_session', {
    app: 'claude',
    prompt: 'goal',
    context: 'summary',
    callerSessionId: 'forged',
    callerSummary: 'forged instructions',
  })
  expect(received).toEqual([{ prompt: 'goal', context: 'summary', callerSessionId: 'source-thread' }, {
    prompt: 'goal',
    context: 'summary',
  }])
})
