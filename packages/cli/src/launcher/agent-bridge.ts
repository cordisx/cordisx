import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { type ClaudeHostSessionsInput, createClaudeHostSessions } from './claude-host-sessions.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { agentBridgeBindingPath, codexLaunchRecordPath } from './agent-bridge-paths.js'
import { createIntegrationStatus } from './integration-status.js'

export { agentBridgeBindingPath, codexLaunchRecordPath } from './agent-bridge-paths.js'

/**
 * The CordisX agent bridge: one owner-only HTTP endpoint on a Unix socket that
 * lets Codex Desktop and Claude Desktop act on each other's conversations.
 *
 * Both apps get the same four tools (`list_sessions`, `read_session`,
 * `start_session`, `send_message`) with an `app` argument naming the target,
 * so a new app is a new `app` value rather than new tool names.
 *
 * - `app: "codex"` runs on the Codex desktop's own app-server, so threads it
 *   reads or starts are the ones the Codex window shows.
 * - `app: "claude"` runs here, on the Claude profile `cordisx start claude`
 *   launched, with no Claude session open (see claude-host-sessions.ts). Only a
 *   message to a session the app has open right now waits in a queue until a
 *   Claude Code session's plugin polls `/claude/poll`, sends it with Claude's
 *   own session tools, and posts `/claude/result`.
 *
 * The socket and its token live in `<CORDISX_HOME>/run`, readable only by the
 * user. Requests carry the token; nothing here accepts an endpoint or secret.
 */

export interface AgentBridgeCodexAuthority {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
  catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
}

export interface AgentBridgeBinding {
  readonly version: 1
  readonly socketPath: string
  readonly token: string
}

export class AgentBridgeClaudeUnavailable extends Error {
  readonly code = 'claude-unavailable'
}

const MAX_BODY = 1024 * 1024
const MAX_TRANSCRIPT_CHARS = 60_000
const CLAUDE_LIVE_MS = 8_000
const CLAUDE_TIMEOUT_MS = 60_000

export const BRIDGE_APPS = ['codex', 'claude'] as const
export type BridgeApp = typeof BRIDGE_APPS[number]
export const BRIDGE_OPERATIONS = [
  'list_sessions',
  'read_session',
  'start_session',
  'send_message',
  'list_model_providers',
] as const
export type BridgeOperation = typeof BRIDGE_OPERATIONS[number]

export const isBridgeApp = (value: unknown): value is BridgeApp =>
  typeof value === 'string' && (BRIDGE_APPS as readonly string[]).includes(value)
export const isBridgeOperation = (value: unknown): value is BridgeOperation =>
  typeof value === 'string' && (BRIDGE_OPERATIONS as readonly string[]).includes(value)

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined

export const codexThreadLink = (threadId: string): string => `codex://threads/${threadId}`

function threadSummary(value: unknown) {
  const thread = object(value) ?? {}
  const id = text(thread.id) ?? ''
  return {
    sessionId: id,
    title: text(thread.name, 1024) ?? text(thread.preview, 1024) ?? '',
    cwd: typeof thread.cwd === 'string' ? thread.cwd : undefined,
    modelProvider: typeof thread.modelProvider === 'string' ? thread.modelProvider : undefined,
    status: object(thread.status)?.type,
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined,
    link: codexThreadLink(id),
  }
}

/**
 * A readable transcript of a thread: messages, plans, and commands, newest
 * last, bounded by `limit` entries (the newest ones) and 60k characters.
 */
export function threadTranscript(
  value: unknown,
  limit?: number,
): readonly { role: string; text: string }[] {
  const thread = object(value) ?? {}
  const entries: { role: string; text: string }[] = []
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    for (const item of Array.isArray(object(turn)?.items) ? object(turn)!.items as unknown[] : []) {
      const entry = object(item)
      if (entry === undefined) continue
      if (entry.type === 'userMessage') {
        const parts = Array.isArray(entry.content) ? entry.content : []
        const said = parts.map(part => object(part)?.text).filter((part): part is string => typeof part === 'string')
        if (said.length > 0) entries.push({ role: 'user', text: said.join('\n') })
      } else if (entry.type === 'agentMessage' && typeof entry.text === 'string') {
        entries.push({ role: 'assistant', text: entry.text })
      } else if (entry.type === 'plan' && typeof entry.text === 'string') {
        entries.push({ role: 'plan', text: entry.text })
      } else if (entry.type === 'commandExecution' && typeof entry.command === 'string') {
        entries.push({ role: 'command', text: entry.command })
      }
    }
  }
  let budget = MAX_TRANSCRIPT_CHARS
  const kept: { role: string; text: string }[] = []
  const newest = limit === undefined ? entries : entries.slice(-Math.max(limit, 0))
  for (const entry of newest.reverse()) {
    if (budget <= 0) break
    const clipped = entry.text.length > budget ? `…${entry.text.slice(-budget)}` : entry.text
    budget -= clipped.length
    kept.push({ role: entry.role, text: clipped })
  }
  return kept.reverse()
}

/** `limit` as the tools declare it: a positive integer of message entries, or undefined when absent. */
const transcriptLimit = (value: unknown): number | undefined =>
  Number.isInteger(value) ? Math.min(Math.max(value as number, 1), 200) : undefined

/** Validated operations on Codex. Each maps onto the allowlisted native methods only. */
export function createCodexBridgeHandler(codex: AgentBridgeCodexAuthority, homedir = os.homedir()) {
  const startTurn = async (threadId: string, prompt: string) => {
    const started = object(
      await codex.nativeRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      }),
    )
    return text(object(started?.turn)?.id)
  }
  return async (operation: unknown, input: unknown): Promise<unknown> => {
    const args = object(input) ?? {}
    if (operation === 'list_model_providers') {
      // The same shape the Claude plugin answers with, from this app's own catalog.
      return {
        providers: (await codex.catalog()).map(provider => ({
          providerId: provider.providerId,
          title: provider.title ?? provider.providerId,
          models: provider.models.map(model => ({ id: model.id, label: model.label })),
        })),
      }
    }
    if (operation === 'list_sessions') {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit as number, 1), 50) : 20
      const listed = object(
        await codex.nativeRequest('thread/list', {
          limit,
          ...(text(args.searchTerm, 256) === undefined ? {} : { searchTerm: args.searchTerm }),
          ...(text(args.cursor, 512) === undefined ? {} : { cursor: args.cursor }),
        }),
      )
      return {
        sessions: (Array.isArray(listed?.data) ? listed.data : []).map(threadSummary),
        ...(typeof listed?.nextCursor === 'string' ? { nextCursor: listed.nextCursor } : {}),
      }
    }
    if (operation === 'read_session') {
      const threadId = text(args.sessionId)
      if (threadId === undefined) return { status: 'rejected', reason: 'sessionId-required' }
      const read = object(await codex.nativeRequest('thread/read', { threadId, includeTurns: true }))
      return {
        ...threadSummary(read?.thread),
        transcript: threadTranscript(read?.thread, transcriptLimit(args.limit)),
      }
    }
    if (operation === 'start_session') {
      const prompt = text(args.prompt, 100_000)
      if (prompt === undefined) return { status: 'rejected', reason: 'prompt-required' }
      const requestedTitle = text(args.title, 120)
      const providerId = text(args.providerId, 128)
      let model = text(args.model)
      if (providerId !== undefined) {
        const provider = (await codex.catalog()).find(entry => entry.providerId === providerId)
        if (provider === undefined) return { status: 'rejected', reason: 'provider-not-configured' }
        model ??= provider.defaultModelId ?? provider.models[0]?.id
        if (model === undefined || !provider.models.some(entry => entry.id === model)) {
          return { status: 'rejected', reason: 'model-not-in-provider-catalog' }
        }
      }
      const cwd = text(args.cwd, 4096) ?? homedir
      if (!path.isAbsolute(cwd)) return { status: 'rejected', reason: 'cwd-must-be-absolute' }
      const started = object(
        await codex.nativeRequest('thread/start', {
          cwd,
          ...(providerId === undefined ? {} : { modelProvider: providerId }),
          ...(model === undefined ? {} : { model }),
        }),
      )
      const threadId = text(object(started?.thread)?.id)
      if (threadId === undefined) return { status: 'failed', reason: 'thread-not-started' }
      // `thread/start` takes no name, so the sidebar title is set right after it.
      let title: string | undefined
      if (requestedTitle !== undefined) {
        title = await codex.nativeRequest('thread/name/set', { threadId, name: requestedTitle })
          .then(() => requestedTitle)
          .catch(() => undefined)
      }
      const turnId = await startTurn(threadId, prompt)
      return {
        status: 'started',
        sessionId: threadId,
        ...(turnId === undefined ? {} : { turnId }),
        ...(title === undefined ? {} : { title }),
        modelProvider: started?.modelProvider,
        model: started?.model,
        link: codexThreadLink(threadId),
      }
    }
    if (operation === 'send_message') {
      const threadId = text(args.sessionId)
      const prompt = text(args.prompt, 100_000)
      if (threadId === undefined || prompt === undefined) {
        return { status: 'rejected', reason: 'sessionId-and-prompt-required' }
      }
      const read = object(await codex.nativeRequest('thread/read', { threadId, includeTurns: false }))
      const status = object(object(read?.thread)?.status)?.type
      if (status === 'active') return { status: 'rejected', reason: 'thread-busy' }
      if (status === 'notLoaded') await codex.nativeRequest('thread/resume', { threadId })
      const turnId = await startTurn(threadId, prompt)
      return {
        status: 'sent',
        sessionId: threadId,
        ...(turnId === undefined ? {} : { turnId }),
        link: codexThreadLink(threadId),
      }
    }
    return { status: 'rejected', reason: 'unknown-operation' }
  }
}

interface ClaudeRequest {
  readonly id: string
  readonly operation: string
  readonly args: unknown
  /** The one Claude session (its CLI session id) that may claim the request. */
  readonly target: string
  claimedBy?: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export interface AgentBridge {
  readonly binding: AgentBridgeBinding
  /** One operation on the named app: Codex directly, Claude through a polling session. */
  call(app: BridgeApp, operation: BridgeOperation, args: unknown): Promise<unknown>
  /** The read-only integration report, as the `/status` route serves it. Never launches or writes. */
  status(args?: unknown): Promise<unknown>
  claudeLive(): boolean
  close(): Promise<void>
}

/** A model service key: the launch environment first, then the CordisX config's environment variables. */
async function configuredSecret(
  cordisxHomeDir: string,
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): Promise<string | undefined> {
  if (environment[name]) return environment[name]
  try {
    const config = object(JSON.parse(await readFile(path.join(cordisxHomeDir, 'config.json'), 'utf8')))
    const entries = Array.isArray(config?.environmentVariables) ? config.environmentVariables : []
    const entry = entries.map(object).find(item => item?.name === name && item.enabled !== false)
    return text(entry?.value, 16_384)
  } catch {
    return undefined
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('body-too-large')
    chunks.push(chunk as Buffer)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

export async function startAgentBridge(input: {
  readonly cordisxHomeDir: string
  readonly codex: AgentBridgeCodexAuthority
  readonly homedir?: string
  /** The launch environment, where a model service key may be set. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly processList?: () => Promise<string>
  readonly runningClaudePid?: ClaudeHostSessionsInput['runningPid']
  readonly launchClaude?: ClaudeHostSessionsInput['launchClaude']
  /** The Codex profile this launch runs, recorded so Claude can start it again. */
  readonly codexProfileId?: string
  /** The `model-service` declaration this launch was started on, for the status report only. */
  readonly codexModelServiceId?: string
}): Promise<AgentBridge> {
  const runDir = path.join(input.cordisxHomeDir, 'run')
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'agent-bridge.sock')
  const bindingPath = agentBridgeBindingPath(input.cordisxHomeDir)
  const token = randomBytes(32).toString('hex')
  const codexHandler = createCodexBridgeHandler(input.codex, input.homedir)
  const claudeHandler = createClaudeHostSessions({
    cordisxHomeDir: input.cordisxHomeDir,
    ...(input.homedir === undefined ? {} : { homedir: input.homedir }),
    secret: name => configuredSecret(input.cordisxHomeDir, input.environment ?? process.env, name),
    ...(input.processList === undefined ? {} : { processList: input.processList }),
    ...(input.runningClaudePid === undefined ? {} : { runningPid: input.runningClaudePid }),
    ...(input.launchClaude === undefined ? {} : { launchClaude: input.launchClaude }),
    viaPlugin: (operation, args, target) => callClaude(operation, args, target),
  })
  const queue: ClaudeRequest[] = []
  const lastPollAt = new Map<string, number>()
  let closed = false
  /** Whether any open Claude session's plugin answered the bridge recently: its session tools are connected. */
  const claudeLive = (): boolean => [...lastPollAt.values()].some(at => Date.now() - at < CLAUDE_LIVE_MS)
  const integrationStatus = createIntegrationStatus({
    cordisxHomeDir: input.cordisxHomeDir,
    // This endpoint is only ever reached from a running Codex launch, so that is the caller unless named.
    caller: 'codex',
    ...(input.homedir === undefined ? {} : { homedir: input.homedir }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    // Reaching this route already proves the bridge answers.
    bridgeAnswers: () => true,
    claudePluginPolling: claudeLive,
    ...(input.runningClaudePid === undefined ? {} : { runningClaudePid: input.runningClaudePid }),
    codexAppServer: async () => {
      try {
        await input.codex.nativeRequest('thread/list', { limit: 1 })
        return true
      } catch {
        return false
      }
    },
  })

  /** Hands a request to one open Claude session's plugin, which answers it from inside that session. */
  async function callClaude(operation: BridgeOperation, args: unknown, target: string): Promise<unknown> {
    if (closed) throw new AgentBridgeClaudeUnavailable('The CordisX agent bridge is closed')
    if (Date.now() - (lastPollAt.get(target) ?? 0) >= CLAUDE_LIVE_MS) {
      throw new AgentBridgeClaudeUnavailable(
        'This Claude session is open in Claude but its CordisX plugin is not connected, so it cannot take the message; send it from Claude, or close the session and try again.',
      )
    }
    return await new Promise<unknown>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        const index = queue.findIndex(item => item.id === id)
        if (index >= 0) queue.splice(index, 1)
        reject(
          new AgentBridgeClaudeUnavailable(
            'Claude did not answer the request in time',
          ),
        )
      }, CLAUDE_TIMEOUT_MS)
      queue.push({ id, operation, args, target, resolve, reject, timer })
    })
  }

  async function call(app: BridgeApp, operation: BridgeOperation, args: unknown): Promise<unknown> {
    return app === 'codex' ? await codexHandler(operation, args) : await claudeHandler(operation, args)
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST' || request.headers['x-cordisx-bridge-token'] !== token) {
          reply(response, 403, { ok: false, error: 'forbidden' })
          return
        }
        const body = object(await readBody(request)) ?? {}
        if (request.url === '/sessions') {
          if (!isBridgeApp(body.app) || !isBridgeOperation(body.operation)) {
            reply(response, 400, { ok: false, error: 'app and operation must be known values' })
            return
          }
          reply(response, 200, { ok: true, value: await call(body.app, body.operation, body.args) })
        } else if (request.url === '/status') {
          reply(response, 200, {
            ok: true,
            value: await integrationStatus({
              app: isBridgeApp(body.app) ? body.app : isBridgeApp(body.caller) ? body.caller : 'codex',
            }),
          })
        } else if (request.url === '/claude/poll') {
          const sessionId = text(body.sessionId) ?? 'unknown'
          lastPollAt.set(sessionId, Date.now())
          const next = queue.find(item => item.claimedBy === undefined && item.target === sessionId)
          if (next !== undefined) next.claimedBy = sessionId
          reply(response, 200, {
            ok: true,
            value: next === undefined ? {} : { id: next.id, operation: next.operation, args: next.args },
          })
        } else if (request.url === '/claude/result') {
          const index = queue.findIndex(item => item.id === body.id)
          if (index >= 0) {
            const [item] = queue.splice(index, 1)
            clearTimeout(item!.timer)
            if (body.ok === true) item!.resolve(body.value)
            else item!.reject(new Error(text(body.error, 2048) ?? 'Claude request failed'))
          }
          reply(response, 200, { ok: true, value: {} })
        } else {
          reply(response, 404, { ok: false, error: 'not-found' })
        }
      } catch (error) {
        reply(response, 500, { ok: false, error: error instanceof Error ? error.message : 'bridge-error' })
      }
    })()
  })

  await rm(socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  const binding: AgentBridgeBinding = Object.freeze({ version: 1, socketPath, token })
  await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 })
  await chmod(bindingPath, 0o600)
  if (input.codexProfileId !== undefined) {
    // Kept after this launch ends: it tells the Claude plugin which profile to start.
    await writeFile(
      codexLaunchRecordPath(input.cordisxHomeDir),
      `${
        JSON.stringify({
          version: 1,
          homeDir: input.cordisxHomeDir,
          profileId: input.codexProfileId,
          ...(input.codexModelServiceId === undefined ? {} : { modelServiceId: input.codexModelServiceId }),
        })
      }\n`,
      { mode: 0o600 },
    )
  }

  return Object.freeze({
    binding,
    claudeLive,
    call,
    status: (args?: unknown) => integrationStatus(args),
    async close() {
      if (closed) return
      closed = true
      for (const item of queue.splice(0)) {
        clearTimeout(item.timer)
        item.reject(new AgentBridgeClaudeUnavailable('The CordisX agent bridge closed'))
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
      // Another launch may have taken the well-known path since; only remove our own binding.
      try {
        const current = object(JSON.parse(await readFile(bindingPath, 'utf8')))
        if (current?.token === token) {
          await rm(bindingPath, { force: true })
          await rm(socketPath, { force: true })
        }
      } catch { /* already gone */ }
    },
  })
}
