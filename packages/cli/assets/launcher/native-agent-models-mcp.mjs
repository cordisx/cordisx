import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

const bindingPath = process.argv[2]
const tools = [{
  name: 'list_model_providers',
  description:
    'List configured CordisX model providers, exact model IDs, and provider-aware task creation availability in this app instance. This reuses the UI catalog and never returns credentials or changes defaults. Native OpenAI models remain in the native model tools. Use create_thread_with_provider only when threadCreation is available. Do not substitute a bootstrap message or an unregistered background thread.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}, {
  name: 'select_thread_model_provider',
  description:
    'Select a configured CordisX provider and model for an existing idle conversation in this app instance, only when the user explicitly requests that change. Call list_model_providers first. Does not send a message, change global config, or interrupt a running conversation. A conversation not loaded in this backend must first be opened normally. Does not extend create_thread or change a new conversation before its first turn. Treat reconciliation-required as an uncertain result and inspect the conversation instead of retrying automatically.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      threadId: { type: 'string', minLength: 1, maxLength: 512 },
      providerId: { type: 'string', minLength: 1, maxLength: 128 },
      model: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['threadId', 'providerId', 'model'],
  },
}, {
  name: 'create_thread_with_provider',
  description:
    'Create a native user task whose first message uses an admitted CordisX provider/model, only when the user explicitly requests a new task and provider. Call list_model_providers first and require threadCreation available. Reuses native project/directory provisioning, permissions, sidebar registration and first send. Supports this app instance on the audited native build; remote/cloud targets are unavailable. Retain a unique operationId for the exact request. On timeout, pending, or reconciliation-required, reuse/read the same operationId; never repeat with a new ID automatically. Never supplies endpoints or secrets. Native create_thread remains unchanged.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operationId: { type: 'string', minLength: 1, maxLength: 128 },
      providerId: { type: 'string', minLength: 1, maxLength: 128 },
      model: { type: 'string', minLength: 1, maxLength: 512 },
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      title: { type: 'string', minLength: 1, maxLength: 512 },
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { enum: ['project', 'projectless'] },
          projectId: { type: 'string' },
          directoryName: { type: 'string' },
          environment: {
            type: 'object',
            properties: { type: { enum: ['local', 'worktree'] }, startingState: { type: 'object' } },
            additionalProperties: false,
          },
        },
        required: ['type'],
      },
    },
    required: ['operationId', 'providerId', 'model', 'prompt', 'target'],
  },
}, {
  name: 'list_sessions',
  description:
    'List conversations in another app CordisX connects (`app`: "claude" for Claude Desktop Code sessions, "codex" for this Codex app), most recent first, each with a link the user can click to open it. Read-only. searchTerm matches messages as well as titles; matches include matchedIn and a short match excerpt. scan.capped reports bounded-search omissions. Claude needs Claude Desktop launched with `cordisx start claude`; no Claude session has to be open.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      searchTerm: { type: 'string', maxLength: 256 },
    },
    required: ['app'],
  },
}, {
  name: 'read_session',
  description:
    'Read one page of a conversation transcript by its sessionId (from list_sessions), newest messages kept, plus the link and `transcriptTotal`. Read-only and cheap for one page, but a page may be large (~60k characters). Page older text with `cursor` from `nextCursor`; `truncated: true` means something was left out, and `clippedCharacters` says how much of the oldest returned message was cut.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      sessionId: { type: 'string', minLength: 1, maxLength: 512 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: {
        type: 'string',
        maxLength: 128,
        description: 'nextCursor from an earlier read_session, unchanged, to read the next older page.',
      },
    },
    required: ['app', 'sessionId'],
  },
}, {
  name: 'start_session',
  description:
    'Start a new conversation in the named app for a task the user asked to hand over. context summary appends a bounded summary of this conversation as background. Costs a model call and may take minutes. Returns `operationId`, `sessionId` and a link; keep the operationId. A repeat with the same operationId returns that same session instead of starting a second one. `title` names the conversation where the app supports it. `providerId` and `model` pick one of the model services `list_model_providers` returns; a value it does not list is refused. In Claude the turn runs in the background in bypass permissions mode; `check_operation` reports when it ends. `dryRun: true` validates provider, model, cwd and key and starts nothing. If the app is not running the result asks you to ask the user whether to start it. Only when the user explicitly asks.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      operationId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Unique per intended start. Reuse it only to repeat this exact call.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Validate the provider, model, cwd and key without starting anything. Never required.',
      },
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      providerId: { type: 'string', minLength: 1, maxLength: 128 },
      model: { type: 'string', minLength: 1, maxLength: 512 },
      context: {
        enum: ['none', 'summary'],
        description: 'summary appends bounded background from the calling conversation.',
      },
      launch: {
        enum: ['once', 'always', 'ask'],
        description:
          'Only after the user answered a needs-confirmation result: "once" starts the app this time, "always" also from now on without asking, "ask" goes back to asking.',
      },
    },
    required: ['app', 'prompt'],
  },
}, {
  name: 'send_message',
  description:
    'Send a message to an existing conversation by its sessionId in the named app; it runs there as the next turn. Costs a model call and may take minutes. Returns `operationId`; a repeat with the same operationId does not send twice. Only when the user explicitly asks.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      operationId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Unique per intended send. Reuse it only to repeat this exact call.',
      },
      sessionId: { type: 'string', minLength: 1, maxLength: 512 },
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      launch: {
        enum: ['once', 'always', 'ask'],
        description:
          'Only after the user answered a needs-confirmation result: "once" starts the app this time, "always" also from now on without asking, "ask" goes back to asking.',
      },
    },
    required: ['app', 'sessionId', 'prompt'],
  },
}, {
  name: 'check_operation',
  description:
    'Report what a start_session or send_message operation became: `running`, `done` or `failed`, with the sessionId and link, or the failure reason. Read-only, side-effect free and cheap: call it instead of guessing how long a background turn takes, and poll it a few seconds apart rather than in a tight loop.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      operationId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['app', 'operationId'],
  },
}, {
  name: 'integration_status',
  description:
    "Report whether the CordisX integrations work right now, and what to fix when they do not, before you guess or retry: this app's bridge socket and token, the CordisX home and running profile; the other app (Codex Desktop or Claude Desktop) whether its process is still alive, its profile, the model service it was launched with, and whether its side of the bridge answers; the model services declared in the CordisX config with the models each app can use and whether their key variable is set (never its value); and cheap bridge-plugin health. Read-only and fast: no app is started, no turn runs, nothing is written. `problems` already carries a reason and a remedy for everything that is not working.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: {
        enum: ['claude', 'codex'],
        description: 'Whose side to report as "self". Defaults to this app (Codex).',
      },
    },
  },
}]
const sessionTools = new Set([
  'list_sessions',
  'read_session',
  'start_session',
  'send_message',
  'check_operation',
])

async function invoke(operation, input, metadata) {
  const binding = JSON.parse(await readFile(bindingPath, 'utf8'))
  if (binding.version !== 1 || typeof binding.socketPath !== 'string' || typeof binding.token !== 'string') {
    throw new Error('Native model tools unavailable')
  }
  return await new Promise((resolve, reject) => {
    const socket = connect(binding.socketPath)
    let buffer = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Native selection acknowledgement unavailable')), 85000)
    socket.on('error', () => finish(new Error('Native model tools unavailable')))
    socket.on('end', () => finish(new Error('Native selection acknowledgement unavailable')))
    socket.on(
      'connect',
      () => socket.write(JSON.stringify({ token: binding.token, operation, input, metadata }) + '\n'),
    )
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        finish(new Error('Native model response too large'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline))
        response.ok === true ? finish(undefined, response.value) : finish(new Error('Native model tools unavailable'))
      } catch {
        finish(new Error('Invalid native model response'))
      }
    })
  })
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
let active = 0
reader.on('line', line => {
  if (Buffer.byteLength(line) > 256 * 1024 || active >= 16) {
    process.exitCode = 1
    reader.close()
    return
  }
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id === undefined) return
  active++
  void (async () => {
    try {
      let result
      if (request.method === 'initialize') {
        result = {
          protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cordisx-models', version: '1.0.0' },
        }
      } else if (request.method === 'tools/list') result = { tools }
      else if (request.method === 'ping') result = {}
      else if (request.method === 'resources/list') result = { resources: [] }
      else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] }
      else if (request.method === 'tools/call') {
        const operation = sessionTools.has(request.params?.name)
          ? `session:${request.params.name}`
          : request.params?.name === 'integration_status'
          ? 'integration_status'
          : request.params?.name === 'list_model_providers'
          ? 'list'
          : request.params?.name === 'select_thread_model_provider'
          ? 'select'
          : request.params?.name === 'create_thread_with_provider'
          ? 'create'
          : undefined
        if (operation === undefined) throw new Error('Unknown native model tool')
        const value = await invoke(operation, request.params.arguments ?? {}, {
          ...request.params._meta,
          'cordisx/mcpRequestId': request.id,
        })
        result = {
          // Compact JSON: tool results are read by an agent, not a person.
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: value?.status === 'rejected' || value?.status === 'reconciliation-required'
            || value?.status === 'unavailable' || value?.status === 'failed',
        }
      } else {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
            + '\n',
        )
        return
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
    } catch {
      const result = {
        content: [{
          type: 'text',
          text: 'Native model tools unavailable; inspect the conversation before retrying a selection.',
        }],
        isError: true,
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
    } finally {
      active--
    }
  })()
})
