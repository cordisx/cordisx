import type { EngineInterface, Register } from 'claude-code'

/**
 * CordisX bridge for Claude Code sessions in a Claude Desktop profile that
 * `cordisx start claude` launched.
 *
 * - Claude -> Codex: registers `codex_*` tools; each one asks the CordisX agent
 *   bridge, which runs it on the Codex desktop's own app-server.
 * - Codex -> Claude: the bridge drives Claude from outside the app; it queues
 *   only a message for a session the app has open, which this plugin polls
 *   for and sends with Claude Desktop's own session tools.
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
  /** No CordisX Codex launch is answering: Codex is closed. */
  readonly unreachable?: boolean
}

const POLL_MS = 1500
const SESSION_ID = /local_[0-9a-f-]{36}/u
const CLAUDE_LINK = /claude:\/\/[^\s"]+/u

const APPS = ['codex', 'claude'] as const
const APP = { enum: APPS, description: 'The app whose conversations to use: "codex" or "claude".' }
const LAUNCH = {
  enum: ['once', 'always', 'ask'],
  description:
    'Only after the user answered a needs-confirmation result: "once" starts the app this time, "always" also from now on without asking, "ask" goes back to asking.',
}
/** How long a started Codex gets to bring its agent bridge up. */
const CODEX_START_MS = 90_000

/** One set of tool names for every app CordisX connects; `app` names the target. */
const MODEL_PROVIDER_TOOL = {
  name: 'list_model_providers',
  description:
    'List the CordisX model services declared for Claude in this CordisX home (`<CORDISX_HOME>/config.json`) merged with the services this Claude profile already holds, with their exact model ids. Read-only: never returns endpoints or credentials, and changes no default. The same shape the Codex app returns. `start_session` with `app: "claude"` takes a `providerId` and `model` from here; one it does not list is refused.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
} as const

/** One set of tool names for every app CordisX connects; `app` names the target. */
const SESSION_TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List conversations in an app CordisX connects (`app`: "codex" for Codex Desktop threads, "claude" for Claude Desktop Code sessions), most recent first, each with a link the user can click to open it. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: APP,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        searchTerm: { type: 'string', maxLength: 256 },
        launch: LAUNCH,
      },
      required: ['app'],
    },
  },
  {
    name: 'read_session',
    description:
      'Read the recent transcript of one conversation by its sessionId (from list_sessions) in the named app, plus its link. Read-only. `limit` caps the number of returned message entries (the newest ones); the transcript is also capped at about 60k characters.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: APP,
        sessionId: { type: 'string', minLength: 1, maxLength: 512 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        launch: LAUNCH,
      },
      required: ['app', 'sessionId'],
    },
  },
  {
    name: 'start_session',
    description:
      'Start a new conversation in the named app for a task the user asked to hand over, and return its sessionId and link. The prompt is the full brief. `title` names the conversation where the app supports it. `providerId` and `model` pick one of the model services `list_model_providers` returns for that app; a value it does not list is refused. For Claude the turn runs in the background, and the result says whether it failed within a short wait; a turn still running is reported as started. Only when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: APP,
        prompt: { type: 'string', minLength: 1, maxLength: 100000 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        providerId: { type: 'string', minLength: 1, maxLength: 128 },
        model: { type: 'string', minLength: 1, maxLength: 512 },
        launch: LAUNCH,
      },
      required: ['app', 'prompt'],
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to an existing conversation by its sessionId in the named app; it runs there as the next turn. Only when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: APP,
        sessionId: { type: 'string', minLength: 1, maxLength: 512 },
        prompt: { type: 'string', minLength: 1, maxLength: 100000 },
        launch: LAUNCH,
      },
      required: ['app', 'sessionId', 'prompt'],
    },
  },
] as const

let polling = false

async function readBinding($: EngineInterface): Promise<Binding | undefined> {
  const home = await cordisxHome($)
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
  if (binding === undefined) {
    return { ok: false, unreachable: true, error: 'CordisX is not running Codex (no agent bridge found)' }
  }
  try {
    const response = await $.http.fetch(`http://cordisx${route}`, {
      method: 'POST',
      socketPath: binding.socketPath,
      headers: { 'content-type': 'application/json', 'x-cordisx-bridge-token': binding.token },
      body: JSON.stringify(body),
    })
    return JSON.parse(response.text) as BridgeReply
  } catch {
    return { ok: false, unreachable: true, error: 'The CordisX agent bridge is not reachable' }
  }
}

function textOf(value: unknown): string {
  const text = (value as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : JSON.stringify(value)
}

function limitOf(args: Record<string, unknown>, fallback: number): number {
  return typeof args.limit === 'number' ? args.limit : fallback
}

/**
 * The model services a Claude start may name, in the shape the Codex tool
 * returns: provider id, title, exact model ids and labels. The CordisX side
 * merges the home config's declarations with this profile's own library, so
 * the two apps answer the same list; without a bridge, the declarations alone
 * are read from `<CORDISX_HOME>/config.json`.
 */
async function modelProviders($: EngineInterface): Promise<unknown> {
  const bridged = await post($, '/sessions', { app: 'claude', operation: 'list_model_providers', args: {} })
  if (bridged.ok) return bridged.value
  const home = await cordisxHome($)
  let providers: Record<string, unknown>[] = []
  try {
    const config = JSON.parse(await $.fs.read(`${home}/config.json`)) as { providers?: unknown }
    const declared = Array.isArray(config.providers) ? config.providers : []
    providers = declared.flatMap(entry => {
      const provider = entry as Record<string, unknown>
      if (provider?.kind !== 'model-service' || provider.enabled === false) return []
      const protocols = Array.isArray(provider.protocols) ? provider.protocols : []
      const appliesTo = Array.isArray(provider.appliesTo) ? provider.appliesTo : undefined
      if (!protocols.includes('anthropic-messages')) return []
      if (appliesTo !== undefined && !appliesTo.includes('claude')) return []
      const models = (provider.models as Record<string, unknown> | undefined)?.claude
      return [{
        providerId: String(provider.id ?? ''),
        title: String(provider.displayName ?? provider.id ?? ''),
        models: (Array.isArray(models) ? models : []).map(id => ({ id: String(id), label: String(id) })),
      }]
    })
  } catch { /* no config yet: nothing is declared */ }
  return { providers }
}

/** Runs one Codex -> Claude request with Claude Desktop's own session tools. */
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
    const prompt = String(args.prompt ?? args.message ?? '')
    // Claude refuses a session's message to itself; a prompt this session submits is its next turn.
    if (args.cliSessionId === await $.session.id()) {
      await $.prompt.submit({ text: prompt })
      return { status: 'sent', sessionId: args.sessionId }
    }
    const sent = await $.tool.call({
      tool: 'mcp__ccd_session_mgmt__send_message',
      session_id: String(args.sessionId ?? ''),
      message: prompt,
    })
    return { status: 'sent', result: textOf(sent) }
  }
  throw new Error(`unknown Claude bridge operation: ${operation}`)
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    // Claude's session tools connect after the session starts; until they do,
    // this session cannot answer a Codex request and must not claim one.
    if (!await hostsClaudeSessions($)) return
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

/** Runs one session tool: Codex through the agent bridge, Claude with this app's own session tools. */
async function runSessionTool($: EngineInterface, operation: string, input: Record<string, unknown>): Promise<string> {
  const { app, ...args } = input
  if (app === 'claude') {
    // The bridge drives Claude from outside the app, so a new session needs no
    // "start the session?" prompt; without a bridge, Claude's own tools answer.
    const { launch: _launch, ...request } = args
    const bridged = await post($, '/sessions', { app, operation, args: request })
    if (bridged.ok) return JSON.stringify(bridged.value, null, 2)
    try {
      return JSON.stringify(await answer($, operation, args), null, 2)
    } catch (error) {
      return `Claude could not do it: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (app !== 'codex') return `app must be one of ${APPS.join(', ')}`
  const { launch, ...request } = args
  let answered = await post($, '/sessions', { app, operation, args: request })
  if (!answered.ok && answered.unreachable === true) {
    const started = await startCodex($, launch)
    if (started !== true) return JSON.stringify(started, null, 2)
    answered = await post($, '/sessions', { app, operation, args: request })
  }
  return answered.ok
    ? JSON.stringify(answered.value, null, 2)
    : `Codex is unavailable: ${answered.error ?? 'unknown error'}`
}

async function cordisxHome($: EngineInterface): Promise<string> {
  return await $.env.get('CORDISX_HOME') ?? `${await $.env.get('HOME') ?? ''}/.cordisx`
}

/**
 * Starts the CordisX Codex launch this home last ran, when the person allowed
 * it: this call (`launch: "once" | "always"`, the latter remembered) or an
 * earlier "always". Otherwise the same question the Codex side asks about
 * Claude, at once.
 */
async function startCodex($: EngineInterface, launch: unknown): Promise<true | Record<string, string>> {
  const home = await cordisxHome($)
  const preference = `${home}/apps/codex/bridge-launch.json`
  if (launch === 'always' || launch === 'ask') {
    await $.fs.write(preference, `${JSON.stringify({ launch })}\n`)
  }
  let remembered = false
  try {
    remembered = (JSON.parse(await $.fs.read(preference)) as { launch?: unknown }).launch === 'always'
  } catch { /* never answered */ }
  const allowed = launch === 'once' || launch === 'always' || (launch !== 'ask' && remembered)
  if (!allowed) {
    return {
      status: 'needs-confirmation',
      reason: 'codex-not-running',
      question: 'Codex Desktop is not running. Start it?',
      howToContinue:
        'Ask the user, in their language, whether to start Codex Desktop. If they agree, call this tool again with the same arguments plus launch "once" (start it this time) or "always" (start it automatically from now on, without asking). Do not retry without their answer.',
    }
  }
  let cli: string[] = []
  try {
    cli = JSON.parse(await $.env.get('CORDISX_CLI') ?? '[]') as string[]
  } catch { /* not launched by CordisX */ }
  let target = { homeDir: home, profileId: 'default' }
  try {
    target = { ...target, ...JSON.parse(await $.fs.read(`${home}/run/codex-launch.json`)) as typeof target }
  } catch { /* Codex never ran with the bridge; its default profile */ }
  const argv = cli.length > 0
    ? [...cli, 'start', 'codex', target.profileId]
    : ['cordisx', 'start', 'codex', target.profileId]
  const started = await $.process.run(argv, { env: { CORDISX_HOME: target.homeDir }, timeoutMs: CODEX_START_MS })
  if (started.exitCode !== 0) {
    return { status: 'failed', reason: 'codex-start-failed', detail: started.stderr.slice(-2000) }
  }
  for (const deadline = Date.now() + CODEX_START_MS; Date.now() < deadline;) {
    if ((await post($, '/sessions', { app: 'codex', operation: 'list_sessions', args: { limit: 1 } })).ok) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return { status: 'failed', reason: 'codex-bridge-not-ready' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of [...SESSION_TOOLS, MODEL_PROVIDER_TOOL]) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('tool.call', { tool: `mcp__cordisx__${MODEL_PROVIDER_TOOL.name}` }, async $ => {
    try {
      return { result: JSON.stringify(await modelProviders($), null, 2) }
    } catch (error) {
      return {
        result: `The model services could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })

  for (const tool of SESSION_TOOLS) {
    on('tool.call', { tool: `mcp__cordisx__${tool.name}` }, async ($, e) => {
      const { tool: _tool, tool_use_id: _id, ...args } = e as Record<string, unknown>
      return { result: await runSessionTool($, tool.name, args) }
    })
  }
}
