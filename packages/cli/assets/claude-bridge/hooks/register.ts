import type { EngineInterface, Register } from 'claude-code'

/**
 * CordisX bridge for Claude Code sessions in a Claude Desktop profile that
 * `cordisx start claude` launched.
 *
 * - Claude -> Codex: registers `codex_*` tools; each one asks the CordisX agent
 *   bridge, which runs it on the Codex desktop's own app-server.
 * - Codex -> Claude: polls the bridge for requests a Codex agent queued and
 *   answers them with Claude Desktop's own session tools.
 *
 * The bridge's socket and token come from `<CORDISX_HOME>/run/agent-bridge.json`,
 * written by a running CordisX Codex launch. Without it the tools say so.
 */

interface Binding {
  readonly socketPath: string
  readonly token: string
}

interface BridgeReply {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

const POLL_MS = 1500
const SESSION_ID = /local_[0-9a-f-]{36}/u
const CLAUDE_LINK = /claude:\/\/[^\s"]+/u

/** Claude session tools that change state; each needs an allow rule, or Claude asks the person. */
const WRITE_TOOLS = ['mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__send_message'] as const
const ALLOW_HINT = 'Add these to "permissions.allow" in ~/.claude/settings.json and restart Claude: '
  + WRITE_TOOLS.join(', ')

const CODEX_TOOLS = [
  {
    name: 'codex_list_threads',
    operation: 'list_threads',
    description:
      'List conversations (threads) in the Codex Desktop app that CordisX runs: title, folder, model provider, status, and a codex:// link the user can click to open each one. Use when the user asks what Codex is working on. Requires Codex launched with `cordisx start`.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        searchTerm: { type: 'string', maxLength: 256 },
      },
    },
  },
  {
    name: 'codex_read_thread',
    operation: 'read_thread',
    description:
      'Read one Codex Desktop conversation by thread id (from codex_list_threads): its status and recent messages, plans, and commands. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { threadId: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['threadId'],
    },
  },
  {
    name: 'codex_start_thread',
    operation: 'start_thread',
    description:
      'Start a new conversation in Codex Desktop for a task the user asked to hand to Codex; Codex begins on the prompt at once and the conversation appears in the Codex window. Optionally pick one of the model providers CordisX configured (providerId, model). Returns the thread id and a codex:// link. Only when the user explicitly asks for work in Codex.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 100000 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        providerId: { type: 'string', minLength: 1, maxLength: 128 },
        model: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'codex_send_message',
    operation: 'send_message',
    description:
      'Send a follow-up message to an existing, idle Codex Desktop conversation by thread id. Only when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string', minLength: 1, maxLength: 512 },
        prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      },
      required: ['threadId', 'prompt'],
    },
  },
] as const

let polling = false

async function readBinding($: EngineInterface): Promise<Binding | undefined> {
  const home = await $.env.get('CORDISX_HOME') ?? `${await $.env.get('HOME') ?? ''}/.cordisx`
  try {
    const value = JSON.parse(await $.fs.read(`${home}/run/agent-bridge.json`)) as Partial<Binding>
    return typeof value.socketPath === 'string' && typeof value.token === 'string'
      ? { socketPath: value.socketPath, token: value.token }
      : undefined
  } catch {
    return undefined
  }
}

async function post($: EngineInterface, route: string, body: unknown): Promise<BridgeReply> {
  const binding = await readBinding($)
  if (binding === undefined) return { ok: false, error: 'CordisX is not running Codex (no agent bridge found)' }
  try {
    const response = await $.http.fetch(`http://cordisx${route}`, {
      method: 'POST',
      socketPath: binding.socketPath,
      headers: { 'content-type': 'application/json', 'x-cordisx-bridge-token': binding.token },
      body: JSON.stringify(body),
    })
    return JSON.parse(response.text) as BridgeReply
  } catch {
    return { ok: false, error: 'The CordisX agent bridge is not reachable' }
  }
}

function textOf(value: unknown): string {
  const text = (value as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : JSON.stringify(value)
}

function limitOf(args: Record<string, unknown>, fallback: number): number {
  return typeof args.limit === 'number' ? args.limit : fallback
}

/** Runs one Codex -> Claude request with Claude Desktop's own session tools. */
async function requireAllowed($: EngineInterface, tool: (typeof WRITE_TOOLS)[number]): Promise<void> {
  const verdict = await $.tool.check({ tool, input: {} })
  // A dialog in a session nobody may be watching would hold the request until it times out.
  if (verdict.decision !== 'allow') throw new Error(`Claude needs permission for ${tool}. ${ALLOW_HINT}`)
}

async function answer($: EngineInterface, operation: string, args: Record<string, unknown>): Promise<unknown> {
  if (operation === 'list_sessions') {
    const current = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' })
    const others = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions', limit: limitOf(args, 20) })
    return { current: textOf(current), others: textOf(others) }
  }
  if (operation === 'read_session') {
    const sessionId = String(args.sessionId ?? '')
    const details = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: sessionId })
    // list_events reads other sessions only; this session's own transcript is read directly.
    const own = textOf(await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' }))
    const transcript = own.includes(sessionId)
      ? JSON.stringify((await $.session.messages()).slice(-limitOf(args, 40)))
      : textOf(
        await $.tool.call({
          tool: 'mcp__ccd_session_mgmt__list_events',
          session_id: sessionId,
          limit: limitOf(args, 40),
        }),
      )
    return { session: textOf(details), transcript }
  }
  if (operation === 'start_session') {
    await requireAllowed($, 'mcp__ccd_session__start_session')
    const started = await $.tool.call({
      tool: 'mcp__ccd_session__start_session',
      initiation: 'user_asked',
      context: 'fresh',
      title: String(args.title ?? 'Task from Codex'),
      prompt: String(args.prompt ?? ''),
      background:
        "This task was handed over from a Codex Desktop conversation through the CordisX agent bridge, at the user's request. Treat the prompt as the complete brief.",
      ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
    })
    const sessionId = SESSION_ID.exec(textOf(started))?.[0]
    if (sessionId === undefined) return { status: 'unknown', result: textOf(started) }
    // A session this one starts nests under it; the user should see it as their own.
    try {
      await $.tool.call({ tool: 'mcp__ccd_session_mgmt__detach_session', session_id: sessionId })
    } catch { /* stays nested; still usable */ }
    const details = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: sessionId })
    const link = CLAUDE_LINK.exec(textOf(details))?.[0]
    return { status: 'started', sessionId, ...(link === undefined ? {} : { link }) }
  }
  if (operation === 'send_message') {
    await requireAllowed($, 'mcp__ccd_session_mgmt__send_message')
    const sent = await $.tool.call({
      tool: 'mcp__ccd_session_mgmt__send_message',
      session_id: String(args.sessionId ?? ''),
      message: String(args.message ?? ''),
    })
    return { status: 'sent', result: textOf(sent) }
  }
  throw new Error(`unknown Claude bridge operation: ${operation}`)
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const next = await post($, '/claude/poll', { sessionId: await $.session.id() })
    const request = (next.ok ? next.value : undefined) as
      | { id?: string; operation?: string; args?: Record<string, unknown> }
      | undefined
    if (request?.id === undefined || request.operation === undefined) return
    try {
      const value = await answer($, request.operation, request.args ?? {})
      await post($, '/claude/result', { id: request.id, ok: true, value })
    } catch (error) {
      await post($, '/claude/result', {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    polling = false
  }
}

async function hostsClaudeSessions($: EngineInterface): Promise<boolean> {
  const tools = await $.tool.list()
  return ['mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__list_sessions'].every(name =>
    tools.some(tool => tool.name === name)
  )
}

async function askCodex($: EngineInterface, operation: string, args: Record<string, unknown>): Promise<string> {
  const answered = await post($, '/codex', { operation, args })
  return answered.ok
    ? JSON.stringify(answered.value, null, 2)
    : `Codex is unavailable: ${answered.error ?? 'unknown error'}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of CODEX_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    // Only a session Claude Desktop hosts has the session tools a Codex request
    // needs; a terminal or headless session must not claim one it cannot answer.
    if (await hostsClaudeSessions($)) $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  for (const tool of CODEX_TOOLS) {
    on('tool.call', { tool: `mcp__cordisx__${tool.name}` }, async ($, e) => {
      const { tool: _tool, tool_use_id: _id, ...args } = e as Record<string, unknown>
      return { result: await askCodex($, tool.operation, args) }
    })
  }
}
