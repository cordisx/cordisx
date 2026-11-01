import { describe, expect, it } from 'vitest'
import { register } from '../packages/cli/assets/claude-bridge/hooks/register'

type Handler = (engine: unknown, event: unknown, next?: () => unknown) => Promise<unknown>

/**
 * The Claude bridge plugin is TypeScript the mod engine loads, so this drives
 * the real `register` with the smallest engine it uses: the session.start
 * handler that registers the tools, the tool call handlers, and the file,
 * HTTP, tool and environment reads `integration_status` makes.
 */
async function plugin(files: Readonly<Record<string, string>>, options: {
  readonly bridgeAnswer?: unknown
  readonly sessionTools?: readonly string[]
  readonly fetch?: (request: { socketPath?: string; body: string }) => Promise<{ text: string }>
} = {}) {
  const registered: { name: string; description: string; inputSchema: unknown }[] = []
  const handlers = new Map<string, Handler>()
  let started: Handler | undefined
  const on = (event: string, filter: unknown, handler?: Handler) => {
    if (event === 'session.start') {
      started = filter as Handler
      return
    }
    handlers.set((filter as { tool: string }).tool, handler!)
  }
  register(on as never)
  const calls: Array<{ route: string; body: string }> = []
  const engine = {
    env: { get: async (name: string) => name === 'CORDISX_HOME' ? '/home/u/.cordisx' : undefined },
    fs: {
      read: async (file: string) => {
        const value = files[file]
        if (value === undefined) throw new Error(`ENOENT: ${file}`)
        return value
      },
      write: async () => undefined,
    },
    http: {
      fetch: async (url: string, request: { socketPath?: string; body: string }) => {
        calls.push({ route: url, body: request.body })
        if (options.fetch !== undefined) return await options.fetch(request)
        return { text: JSON.stringify(options.bridgeAnswer ?? { ok: false, unreachable: true }) }
      },
    },
    tool: {
      register: async (tool: { name: string; description: string; inputSchema: unknown }) => {
        registered.push(tool)
      },
      list: async () => (options.sessionTools ?? []).map(name => ({ name })),
      call: async () => ({ text: '' }),
    },
    session: { id: async () => 'local_self' },
    clock: { every: () => ({}) },
  }
  await started!(engine, {}, async () => undefined)
  return {
    registered,
    calls,
    async call(name: string, args: Record<string, unknown> = {}) {
      const handler = handlers.get(`mcp__cordisx__${name}`)
      if (handler === undefined) throw new Error(`no handler for ${name}`)
      const answer = await handler(engine, { tool: `mcp__cordisx__${name}`, tool_use_id: 'call', ...args })
      return JSON.parse((answer as { result: string }).result) as Record<string, unknown>
    },
  }
}

const HOME = '/home/u/.cordisx'

const config = JSON.stringify({
  version: 1,
  environmentVariables: [{ name: 'UNIFIED_KEY', value: 'sk-never-report', enabled: true }],
  providers: [
    {
      id: 'unified',
      kind: 'model-service',
      displayName: 'Unified',
      baseUrl: 'https://unified.invalid',
      apiKeyEnv: 'UNIFIED_KEY',
      protocols: ['anthropic-messages', 'openai-responses'],
      models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] },
    },
    {
      id: 'disabled',
      kind: 'model-service',
      displayName: 'Disabled',
      baseUrl: 'https://disabled.invalid',
      apiKeyEnv: 'DISABLED_KEY',
      protocols: ['anthropic-messages'],
      enabled: false,
      models: { claude: ['claude-opus-5-5'] },
    },
  ],
})

const claudeProfile = JSON.stringify({
  version: 1,
  profileId: 'e2e',
  homeDir: HOME,
  dataDir: `${HOME}/apps/claude/profiles/e2e/data-3p`,
  provider: { id: 'unified', baseUrl: 'https://unified.invalid', apiKeyEnv: 'UNIFIED_KEY' },
})

const codexLaunch = JSON.stringify({ version: 1, homeDir: HOME, profileId: 'work', modelServiceId: 'unified' })

describe('integration_status in the Claude bridge plugin', () => {
  it('registers the tool beside the session tools', async () => {
    const p = await plugin({})
    expect(p.registered.map(tool => tool.name)).toEqual([
      'list_sessions',
      'read_session',
      'start_session',
      'send_message',
      'integration_status',
    ])
    const status = p.registered.find(tool => tool.name === 'integration_status')!
    expect(status.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { app: { enum: ['claude', 'codex'] } },
    })
    // No required argument: it is the first thing an agent calls when unsure.
    expect((status.inputSchema as Record<string, unknown>).required).toBeUndefined()
  })

  it('returns the bridge report when the CordisX Codex launch answers', async () => {
    const report = { version: 1, status: 'ok', app: 'claude', self: { app: 'claude' } }
    const p = await plugin({
      [`${HOME}/run/agent-bridge.json`]: JSON.stringify({ socketPath: '/tmp/sock', token: 'secret-token' }),
    }, { bridgeAnswer: { ok: true, value: report } })
    expect(await p.call('integration_status')).toEqual(report)
    expect(p.calls).toEqual([{ route: 'http://cordisx/status', body: JSON.stringify({ caller: 'claude' }) }])
  })

  it('passes the named app through and still asks as Claude', async () => {
    const p = await plugin({
      [`${HOME}/run/agent-bridge.json`]: JSON.stringify({ socketPath: '/tmp/sock', token: 'secret-token' }),
    }, { bridgeAnswer: { ok: true, value: { status: 'ok' } } })
    await p.call('integration_status', { app: 'codex' })
    expect(p.calls[0]!.body).toBe(JSON.stringify({ caller: 'claude', app: 'codex' }))
  })

  it('reports from Claude alone when no bridge answers, without inventing Codex state', async () => {
    const p = await plugin({
      [`${HOME}/config.json`]: config,
      [`${HOME}/run/agent-bridge.json`]: JSON.stringify({ socketPath: '/tmp/sock', token: 'secret-token' }),
      [`${HOME}/run/claude-desktop.json`]: claudeProfile,
      [`${HOME}/run/codex-launch.json`]: codexLaunch,
    }, { bridgeAnswer: { ok: false, unreachable: true } })
    const report = await p.call('integration_status')

    expect(report).toMatchObject({
      version: 1,
      status: 'degraded',
      app: 'claude',
      cordisxHome: HOME,
      self: { app: 'claude', status: 'ok', profileId: 'e2e', modelService: { id: 'unified', declared: true } },
      other: {
        app: 'codex',
        status: 'not-running',
        profileId: 'work',
        modelService: { id: 'unified', declared: true },
      },
    })
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'other', reason: 'codex-not-running', remedy: expect.any(String) }),
      expect.objectContaining({ area: 'model-service:disabled', reason: 'no-app-can-use-it' }),
    ]))
    // A model service key is reported only as present.
    expect(JSON.stringify(report)).not.toContain('sk-never-report')
    expect(JSON.stringify(report)).not.toContain('secret-token')
    expect(report.modelServices).toEqual([
      expect.objectContaining({
        id: 'unified',
        keyVariable: 'UNIFIED_KEY',
        keySet: true,
        apps: {
          claude: { usable: true, models: ['claude-opus-5-5'] },
          codex: { usable: true, models: ['gpt-6.1-sol'] },
        },
      }),
      expect.objectContaining({
        id: 'disabled',
        apps: expect.objectContaining({ claude: expect.objectContaining({ usable: false }) }),
      }),
    ])
  })

  it('flags a missing home config and a missing bridge binding as different fixes', async () => {
    const p = await plugin({}, { bridgeAnswer: { ok: false, unreachable: true } })
    const report = await p.call('integration_status')
    expect(report.other).toMatchObject({ status: 'not-running', reason: 'bridge-binding-missing' })
    expect((report.other as Record<string, unknown>).remedy).toContain('cordisx start codex')
    expect(report).toMatchObject({ modelServices: [] })
  })
})
