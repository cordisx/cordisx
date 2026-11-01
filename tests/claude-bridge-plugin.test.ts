import { describe, expect, it } from 'vitest'
import { register } from '../packages/cli/assets/claude-bridge/hooks/register'

type Handler = (engine: unknown, event: unknown, next?: () => unknown) => Promise<unknown>

/**
 * The Claude bridge plugin is TypeScript the mod engine loads, so these tests
 * drive the real `register` with the smallest engine it uses: the session.start
 * handler that registers the tools, the tool call handlers, and the file and
 * environment reads.
 */
async function plugin(files: Readonly<Record<string, string>>) {
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
    http: { fetch: async () => ({ text: '{"ok":false,"unreachable":true}' }) },
    tool: {
      register: async (tool: { name: string; description: string; inputSchema: unknown }) => {
        registered.push(tool)
      },
      list: async () => [],
      call: async () => ({ text: '' }),
    },
    session: { id: async () => 'local_self' },
    clock: { every: () => ({}) },
  }
  await started!(engine, {}, async () => undefined)
  return {
    registered,
    async call(name: string) {
      const handler = handlers.get(`mcp__cordisx__${name}`)
      if (handler === undefined) throw new Error(`no handler for ${name}`)
      return (await handler(engine, { tool: `mcp__cordisx__${name}`, tool_use_id: 'call' })) as { result: string }
    },
  }
}

const declaredConfig = JSON.stringify({
  version: 1,
  providers: [
    {
      id: 'sub2tok',
      kind: 'model-service',
      displayName: 'sub2tok',
      baseUrl: 'https://api.sub2tok.com',
      apiKeyEnv: 'SUB2TOK_KEY',
      protocols: ['anthropic-messages', 'openai-responses'],
      models: { claude: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    },
    {
      // Codex-only: Claude cannot run a turn on it, so it is not listed here.
      id: 'only-responses',
      kind: 'model-service',
      displayName: 'Responses only',
      baseUrl: 'https://responses.invalid',
      apiKeyEnv: 'RESPONSES_KEY',
      protocols: ['openai-responses'],
      models: { codex: ['gpt-6.1-sol'] },
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

describe('The Claude bridge plugin', () => {
  it('registers the four session tools and list_model_providers', async () => {
    const { registered } = await plugin({})
    expect(registered.map(tool => tool.name)).toEqual([
      'list_sessions',
      'read_session',
      'start_session',
      'send_message',
      'list_model_providers',
    ])
    const read = registered.find(tool => tool.name === 'read_session')!
    expect(JSON.stringify(read.inputSchema)).toContain('"limit"')
    expect(read.description).toMatch(/limit/u)
    expect(JSON.stringify(registered.find(tool => tool.name === 'start_session')!.inputSchema)).toContain('"title"')
  })

  it('lists the Claude-capable declared services in the Codex tool shape, without credentials', async () => {
    const { call } = await plugin({ '/home/u/.cordisx/config.json': declaredConfig })
    const value = JSON.parse((await call('list_model_providers')).result)
    expect(value).toEqual({
      providers: [{
        providerId: 'sub2tok',
        title: 'sub2tok',
        models: [{ id: 'claude-opus-5-5', label: 'claude-opus-5-5' }, {
          id: 'claude-sonnet-5-5',
          label: 'claude-sonnet-5-5',
        }],
      }],
    })
    expect(JSON.stringify(value)).not.toMatch(/SUB2TOK_KEY|api\.sub2tok|baseUrl|apiKey/u)
  })

  it('answers with an empty list when no home config exists', async () => {
    const { call } = await plugin({})
    expect(JSON.parse((await call('list_model_providers')).result)).toEqual({ providers: [] })
  })
})
