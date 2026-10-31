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
    'List conversations in another app CordisX connects (`app`: "claude" for Claude Desktop Code sessions, "codex" for this Codex app), most recent first, each with a link the user can click to open it. Read-only. Claude needs Claude Desktop launched with `cordisx start claude` and an open Code session.',
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
    'Read the recent transcript of one conversation by its sessionId (from list_sessions) in the named app, plus its link. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      sessionId: { type: 'string', minLength: 1, maxLength: 512 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['app', 'sessionId'],
  },
}, {
  name: 'start_session',
  description:
    'Start a new conversation in the named app for a task the user asked to hand over, and return its sessionId and link. The prompt is the full brief. In Claude the person must allow the new session in the Claude window; the call waits for that. Only when the user explicitly asks.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      providerId: { type: 'string', minLength: 1, maxLength: 128 },
      model: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['app', 'prompt'],
  },
}, {
  name: 'send_message',
  description:
    'Send a message to an existing conversation by its sessionId in the named app. It runs there as the next turn, without any approval prompt. Only when the user explicitly asks.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      app: { enum: ['claude', 'codex'] },
      sessionId: { type: 'string', minLength: 1, maxLength: 512 },
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
    },
    required: ['app', 'sessionId', 'prompt'],
  },
}]
const sessionTools = new Set(['list_sessions', 'read_session', 'start_session', 'send_message'])

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
    const timer = setTimeout(() => finish(new Error('Native selection acknowledgement unavailable')), 190000)
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
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: value?.status === 'rejected' || value?.status === 'reconciliation-required'
            || value?.status === 'unavailable',
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
