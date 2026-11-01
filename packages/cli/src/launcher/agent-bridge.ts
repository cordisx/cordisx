import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  beginScan,
  capScan,
  contextArgument,
  contextResult,
  conversationSummary,
  handedSummary,
  handoffPrompt,
  readCandidate,
  scanReport,
  SEARCH_MAX_ELAPSED_MS,
  SEARCH_MAX_THREADS,
  SEARCH_RECENT_THREADS,
  searchEntries,
} from './agent-bridge-context.js'
import type { HomeConfigProvider } from '../config/home-config.js'
import {
  AgentBridgeUnavailable,
  type BridgeApp,
  type BridgeFailure,
  bridgeFailure,
  type BridgeOperation,
  BridgeOperationError,
  type BridgeOperationRegistry,
  type BridgeTurnOperation,
  type BridgeValidationCache,
  type BridgeValidationKey,
  createBridgeOperationRegistry,
  createTurnRunner,
  dryRunResult,
  failureFromError,
  isBridgeApp,
  isBridgeOperation,
  newOperationId,
  pageTranscript,
  requireDirectory,
  type TranscriptEntry,
} from './agent-bridge-contract.js'
import { createBridgeValidationCache, memoryValidationCache } from './agent-bridge-validation.js'
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
 * Both apps get the same tools (`list_sessions`, `read_session`, `start_session`,
 * `send_message`, `check_operation`) with an `app` argument naming the target,
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
 * Every answer is the same wire shape on both sides (agent-bridge-contract.ts):
 * a result, or a failure carrying `status`, `reason`, `retryable` and
 * `howToContinue`, so an agent can recover without reading prose. A start or a
 * send returns an `operationId`; the same id answers with the same session
 * instead of starting a second one, and `check_operation` reports progress.
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

export {
  BRIDGE_APPS,
  BRIDGE_OPERATIONS,
  BRIDGE_REASONS,
  type BridgeApp,
  type BridgeFailure,
  bridgeFailure,
  type BridgeOperation,
  type BridgeValidationCache,
  type BridgeValidationKey,
  failureFromError,
  pageTranscript,
  requireDirectory,
  type TranscriptEntry,
} from './agent-bridge-contract.js'

const MAX_BODY = 1024 * 1024
const CLAUDE_LIVE_MS = 8_000
const CLAUDE_TIMEOUT_MS = 60_000

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

/** Every readable entry of a thread, oldest first: messages, plans, and commands. */
export function threadEntries(value: unknown): readonly TranscriptEntry[] {
  const thread = object(value) ?? {}
  const entries: TranscriptEntry[] = []
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
  return entries
}

/** The newest page of a thread's transcript; `limit` bounds entries and the page says what it left out. */
export const threadTranscript = (value: unknown, limit?: number): readonly TranscriptEntry[] =>
  pageTranscript(threadEntries(value), limit === undefined ? {} : { limit }).entries

/** `limit` as the tools declare it: a positive integer of message entries, or undefined when absent. */
const transcriptLimit = (value: unknown): number | undefined =>
  Number.isInteger(value) ? Math.min(Math.max(value as number, 1), 200) : undefined

export interface CodexBridgeOptions {
  /** Where a validated app + provider + model + cwd combination is remembered. */
  readonly validation?: BridgeValidationCache
  /** Resolves a model service key by variable name, for a `dryRun` key check. */
  readonly secret?: (name: string) => Promise<string | undefined>
  /** The CordisX home's provider declarations, for a `dryRun` key check. */
  readonly providers?: () => Promise<readonly HomeConfigProvider[]>
}

interface CodexSelection {
  readonly providerId?: string
  readonly model?: string
  readonly cwd: string
}

const transcriptSize = (entries: readonly TranscriptEntry[]): number =>
  entries.reduce((total, entry) => total + entry.text.length, 0)

/**
 * `list_sessions` with a `searchTerm` on Codex. `thread/list` filters the title
 * only, so this reads the messages of at most `SEARCH_MAX_THREADS` recent
 * threads (a few MB in all), answers a short excerpt for each match, and says
 * when it stopped before reading every candidate.
 */
async function searchCodexThreads(
  codex: AgentBridgeCodexAuthority,
  threads: readonly (Record<string, unknown> | undefined)[],
  search: string,
  limit: number,
): Promise<{ sessions: readonly unknown[]; scan: ReturnType<typeof scanReport> }> {
  const scan = beginScan()
  const matched: unknown[] = []
  let unread = 0
  let attempts = 0
  const startedAt = Date.now()
  const term = search.toLowerCase()
  for (const thread of threads) {
    if (thread === undefined) continue
    const session = threadSummary(thread)
    if (matched.length >= limit) {
      unread += 1
      continue
    }
    // A title match needs no transcript read.
    if (session.title.toLowerCase().includes(term)) {
      matched.push({ ...session, matchedIn: 'title' })
      continue
    }
    if (attempts >= SEARCH_MAX_THREADS) {
      unread += 1
      continue
    }
    if (Date.now() - startedAt >= SEARCH_MAX_ELAPSED_MS) {
      scan.capped = true
      scan.reason ??= 'time-limit'
      break
    }
    attempts += 1
    let read: Record<string, unknown> | undefined
    try {
      read = object(await codex.nativeRequest('thread/read', { threadId: session.sessionId, includeTurns: true }))
    } catch {
      scan.capped = true
      scan.reason = 'read-unavailable'
      continue
    }
    const entries = threadEntries(read?.thread)
    if (!readCandidate(scan, transcriptSize(entries))) {
      unread += 1
      break
    }
    const found = searchEntries(entries, search)
    if (found !== undefined) matched.push({ ...session, match: found, matchedIn: 'messages' })
  }
  if (unread > 0) capScan(scan)
  return { sessions: matched, scan: scanReport(scan) }
}

/** The summary of the calling Codex thread, for a task handed to Claude. */
export async function codexConversationSummary(
  codex: Pick<AgentBridgeCodexAuthority, 'nativeRequest'>,
  callerThreadId: string,
): Promise<string | undefined> {
  try {
    const read = object(await codex.nativeRequest('thread/read', { threadId: callerThreadId, includeTurns: true }))
    const thread = object(read?.thread)
    const title = text(thread?.name, 1024)
    const summary = conversationSummary(threadEntries(thread), {
      app: 'Codex',
      sessionId: callerThreadId,
      ...(title === undefined ? {} : { title }),
    })
    return summary.length === 0 ? undefined : summary
  } catch {
    return undefined
  }
}

/**
 * The summary a `start_session` carries, resolved before either handler runs.
 * A caller that can read its own conversation (the Claude plugin) hands the
 * text over as `callerSummary`; the Codex tool can only name the thread it was
 * called from, so that thread is read here and the text is handed on instead.
 */
async function resolveCallerSummary(
  codex: Pick<AgentBridgeCodexAuthority, 'nativeRequest'>,
  args: unknown,
): Promise<unknown> {
  const values = object(args)
  if (values === undefined || values.context !== 'summary' || handedSummary(values) !== undefined) return args
  const caller = text(values.callerSessionId, 512)
  if (caller === undefined) return args
  const { callerSessionId: _caller, ...rest } = values
  const summary = await codexConversationSummary(codex, caller)
  return summary === undefined ? rest : { ...rest, callerSummary: summary }
}

/** Validated operations on Codex. Each maps onto the allowlisted native methods only. */
export function createCodexBridgeHandler(
  codex: AgentBridgeCodexAuthority,
  homedir = os.homedir(),
  options: CodexBridgeOptions = {},
) {
  // A caller with no home of its own still gets remembered validation, for this handler's lifetime.
  const validation = options.validation ?? memoryValidationCache()
  const turns = createTurnRunner('codex', {
    registry: createBridgeOperationRegistry(),
    dryRun: async (args, operationId) => await dryRun(args, operationId),
    refresh: async record => {
      if (record.sessionId === undefined || record.turnId === undefined) return undefined
      const read = object(await codex.nativeRequest('thread/read', { threadId: record.sessionId, includeTurns: true }))
      const thread = object(read?.thread)
      const turn = (Array.isArray(thread?.turns) ? thread.turns : []).map(object).find(item =>
        item?.id === record.turnId
      )
      if (turn?.status === 'completed') return { status: 'succeeded' }
      if (turn?.status === 'failed' || turn?.status === 'interrupted') {
        return {
          status: 'failed',
          error: text(object(turn.error)?.message, 2000) ?? 'The turn failed or was interrupted',
        }
      }
      return undefined
    },
  })

  /**
   * Validates a start without starting anything: the provider and model are in
   * this app's catalog, the cwd is a directory, and a declared model service
   * has its key. A combination an earlier start proved works answers as
   * `remembered`; live keys and directories are always checked again.
   */
  async function dryRun(args: Record<string, unknown>, operationId: string): Promise<Record<string, unknown>> {
    const prompt = text(args.prompt, 100_000)
    if (prompt === undefined) throw new BridgeOperationError('prompt-required')
    if (contextArgument(args) === undefined) throw new BridgeOperationError('context-invalid')
    const providerId = text(args.providerId, 128)
    let model = text(args.model)
    const cwd = text(args.cwd, 4096) ?? homedir
    if (!path.isAbsolute(cwd)) throw new BridgeOperationError('cwd-must-be-absolute')
    if (providerId !== undefined) {
      const provider = (await codex.catalog()).find(entry => entry.providerId === providerId)
      if (provider === undefined) throw new BridgeOperationError('provider-not-configured')
      model ??= provider.defaultModelId ?? provider.models[0]?.id
      if (model === undefined || !provider.models.some(entry => entry.id === model)) {
        throw new BridgeOperationError('model-not-in-provider-catalog')
      }
    }
    const known = await validation.remembers({
      ...validationKeyFor({ providerId, model, cwd }),
      configuration: JSON.stringify(await options.providers?.() ?? []),
    })
    {
      await requireDirectory(cwd)
      const missing = await providerKeyCheck(options, providerId)
      // A dry run that would fail says so plainly, still starting nothing.
      if (missing !== undefined) return { ...missing, status: 'failed', dryRun: true, operationId }
    }
    const declared = await declaredProvider(options, providerId)
    return dryRunResult({
      app: 'codex',
      operationId,
      checks: {
        provider: providerId === undefined ? 'not-requested' : known ? 'remembered' : 'ok',
        model: model === undefined || providerId === undefined ? 'not-requested' : known ? 'remembered' : 'ok',
        cwd: 'ok',
        key: declared === undefined ? 'not-required' : 'ok',
      },
      wouldStart: {
        cwd,
        ...(providerId === undefined ? {} : { providerId }),
        ...(model === undefined ? {} : { model }),
      },
    })
  }

  return async (operation: unknown, input: unknown): Promise<unknown> => {
    const args = object(input) ?? {}
    try {
      if (operation === 'check_operation') return await turns.check(args)
      if (!isBridgeOperation(operation)) return bridgeFailure('unknown-operation')
      if (operation === 'start_session') {
        return await turns.run('start_session', args, async turn => {
          const prompt = text(args.prompt, 100_000)
          if (prompt === undefined) throw new BridgeOperationError('prompt-required')
          const context = contextArgument(args)
          if (context === undefined) throw new BridgeOperationError('context-invalid')
          const handed = context === 'summary' ? handedSummary(args) : undefined
          const providerId = text(args.providerId, 128)
          let model = text(args.model)
          if (providerId !== undefined) {
            const provider = (await codex.catalog()).find(entry => entry.providerId === providerId)
            if (provider === undefined) throw new BridgeOperationError('provider-not-configured')
            model ??= provider.defaultModelId ?? provider.models[0]?.id
            if (model === undefined || !provider.models.some(entry => entry.id === model)) {
              throw new BridgeOperationError('model-not-in-provider-catalog')
            }
          }
          const cwd = text(args.cwd, 4096) ?? homedir
          if (!path.isAbsolute(cwd)) throw new BridgeOperationError('cwd-must-be-absolute')
          // A normal start behaves as before: the app itself decides about cwd.
          // `dryRun` is where a missing directory is reported first.
          const missing = await providerKeyCheck(options, providerId)
          if (missing !== undefined) return turn.failed({ ...missing })
          turn.uncertain()
          const started = object(
            await codex.nativeRequest('thread/start', {
              cwd,
              ...(providerId === undefined ? {} : { modelProvider: providerId }),
              ...(model === undefined ? {} : { model }),
            }),
          )
          const threadId = text(object(started?.thread)?.id)
          if (threadId === undefined) throw new BridgeOperationError('session-not-started')
          // The thread exists from here on: a repeat sends to it instead of starting another.
          const link = codexThreadLink(threadId)
          turn.effected(threadId, link)
          const requestedTitle = text(args.title, 120)
          let title: string | undefined
          if (requestedTitle !== undefined) {
            title = await codex.nativeRequest('thread/name/set', { threadId, name: requestedTitle })
              .then(() => requestedTitle)
              .catch(() => undefined)
          }
          const turnId = await startTurn(codex, threadId, handoffPrompt(prompt, handed))
          const base = {
            sessionId: threadId,
            link,
            ...(title === undefined ? {} : { title }),
            modelProvider: started?.modelProvider,
            model: started?.model,
            ...(context === 'summary' ? { context: contextResult(handed) } : {}),
          }
          await validation.remember({
            ...validationKeyFor({ providerId, model, cwd }),
            configuration: JSON.stringify(await options.providers?.() ?? []),
          })
          if (turnId === undefined) {
            return turn.failed({
              ...base,
              status: 'failed',
              reason: 'turn-failed',
              retryable: true,
              howToContinue: 'The thread exists; call send_message with this sessionId to run the brief.',
              message: 'The thread was created but its first turn did not start.',
            })
          }
          return turn.started({ status: 'started', ...base, turnId }, turnId)
        })
      }
      if (operation === 'send_message') {
        return await turns.run('send_message', args, async turn => {
          const threadId = text(args.sessionId)
          const prompt = text(args.prompt, 100_000)
          if (threadId === undefined || prompt === undefined) {
            throw new BridgeOperationError('sessionId-and-prompt-required')
          }
          const read = object(await codex.nativeRequest('thread/read', { threadId, includeTurns: false }))
          const status = object(object(read?.thread)?.status)?.type
          if (status === 'active') throw new BridgeOperationError('session-busy')
          if (status === 'notLoaded') await codex.nativeRequest('thread/resume', { threadId })
          const link = codexThreadLink(threadId)
          turn.effected(threadId, link)
          const turnId = await startTurn(codex, threadId, prompt)
          if (turnId === undefined) {
            return turn.failed({
              status: 'failed',
              sessionId: threadId,
              link,
              reason: 'turn-failed',
              retryable: true,
              howToContinue: 'The message did not start a turn; call send_message again with a new operationId.',
              message: 'The message did not start a turn in that thread.',
            })
          }
          return turn.started({ status: 'sent', sessionId: threadId, link, turnId }, turnId)
        })
      }
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
        const search = text(args.searchTerm, 256)
        const listed = object(
          await codex.nativeRequest('thread/list', {
            sortKey: 'updated_at',
            sortDirection: 'desc',
            modelProviders: [],
            limit: search === undefined ? limit : Math.max(limit, SEARCH_RECENT_THREADS),
            ...(text(args.cursor, 512) === undefined ? {} : { cursor: args.cursor }),
          }),
        )
        const threads = (Array.isArray(listed?.data) ? listed.data : []).map(object)
        const result = search === undefined
          ? { sessions: threads.map(threadSummary) }
          : await searchCodexThreads(codex, threads, search, limit)
        if (search !== undefined && 'scan' in result && typeof listed?.nextCursor === 'string') {
          result.scan.capped = true
        }
        return { ...result, ...(typeof listed?.nextCursor === 'string' ? { nextCursor: listed.nextCursor } : {}) }
      }
      // `read_session`: a page of the newest messages, with a cursor for the rest.
      const threadId = text(args.sessionId)
      if (threadId === undefined) throw new BridgeOperationError('sessionId-required')
      const read = object(await codex.nativeRequest('thread/read', { threadId, includeTurns: true }))
      const limit = transcriptLimit(args.limit)
      const page = pageTranscript(threadEntries(read?.thread), {
        ...(limit === undefined ? {} : { limit }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      })
      return {
        ...threadSummary(read?.thread),
        transcript: page.entries,
        transcriptTotal: page.total,
        truncated: page.truncated,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        ...(page.clippedCharacters === 0 ? {} : { clippedCharacters: page.clippedCharacters }),
      }
    } catch (error) {
      return failureFromError(error)
    }
  }
}

/** The combination a Codex start proved works, as the cache keys it. */
function validationKeyFor(selection: {
  readonly providerId: string | undefined
  readonly model: string | undefined
  readonly cwd: string
}): BridgeValidationKey {
  return {
    app: 'codex',
    ...(selection.providerId === undefined ? {} : { providerId: selection.providerId }),
    ...(selection.model === undefined ? {} : { model: selection.model }),
    cwd: selection.cwd,
  }
}

async function startTurn(
  codex: AgentBridgeCodexAuthority,
  threadId: string,
  prompt: string,
): Promise<string | undefined> {
  const started = object(
    await codex.nativeRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    }),
  )
  return text(object(started?.turn)?.id)
}

/** The model service the CordisX config declares under this id, if any. */
async function declaredProvider(
  options: CodexBridgeOptions,
  providerId: string | undefined,
): Promise<{ readonly id: string; readonly apiKeyEnv: string } | undefined> {
  if (providerId === undefined || options.providers === undefined) return undefined
  const declared = (await options.providers().catch(() => [])).find(entry =>
    entry.kind === 'model-service' && entry.id === providerId
  )
  return declared === undefined || declared.kind !== 'model-service' ? undefined : declared
}

/** A declared model service's key is set; a provider this home does not declare has no key to check. */
export async function providerKeyCheck(
  options: CodexBridgeOptions,
  providerId: string | undefined,
): Promise<BridgeFailure | undefined> {
  const declared = await declaredProvider(options, providerId)
  if (declared === undefined || options.secret === undefined) return undefined
  if (await options.secret(declared.apiKeyEnv) !== undefined) return undefined
  return bridgeFailure('provider-key-missing', {
    message: `The key for model service ${declared.id} (${declared.apiKeyEnv}) is not set`,
    detail: declared.apiKeyEnv,
  })
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
  /** One operation on the named app: Codex directly, Claude through the launched profile. */
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
    if (size > MAX_BODY) throw new BridgeOperationError('malformed-request', { message: 'body-too-large' })
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeOperationError('malformed-request', { message: 'The request body is not JSON' })
  }
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
  /** The CordisX home's provider declarations; defaults to reading its config. */
  readonly providers?: () => Promise<readonly HomeConfigProvider[]>
}): Promise<AgentBridge> {
  const runDir = path.join(input.cordisxHomeDir, 'run')
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'agent-bridge.sock')
  const bindingPath = agentBridgeBindingPath(input.cordisxHomeDir)
  const token = randomBytes(32).toString('hex')
  const secret = (name: string) => configuredSecret(input.cordisxHomeDir, input.environment ?? process.env, name)
  const validation = createBridgeValidationCache(input.cordisxHomeDir)
  const readProviders = input.providers ?? (async () => {
    const { readHomeProviders } = await import('./claude-host-sessions.js')
    return await readHomeProviders(input.cordisxHomeDir)
  })
  // One registry for both apps: an entry records the app it belongs to.
  const operations: BridgeOperationRegistry = createBridgeOperationRegistry()
  const codexHandler = createCodexBridgeHandler(input.codex, input.homedir, {
    validation,
    secret,
    providers: readProviders,
  })
  const claudeHandler = createClaudeHostSessions({
    cordisxHomeDir: input.cordisxHomeDir,
    ...(input.homedir === undefined ? {} : { homedir: input.homedir }),
    secret,
    providers: readProviders,
    validation,
    operations,
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
    if (closed) throw new AgentBridgeUnavailable('The CordisX agent bridge is closed')
    if (Date.now() - (lastPollAt.get(target) ?? 0) >= CLAUDE_LIVE_MS) {
      throw new AgentBridgeUnavailable(
        'This Claude session is open in Claude but its CordisX plugin is not connected, so it cannot take the message; send it from Claude, or close the session and try again.',
        'claude-plugin-unavailable',
      )
    }
    return await new Promise<unknown>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        const index = queue.findIndex(item => item.id === id)
        if (index >= 0) queue.splice(index, 1)
        reject(new AgentBridgeUnavailable('Claude did not answer the request in time', 'timeout'))
      }, CLAUDE_TIMEOUT_MS)
      queue.push({ id, operation, args, target, resolve, reject, timer })
    })
  }

  async function call(app: BridgeApp, operation: BridgeOperation, args: unknown): Promise<unknown> {
    try {
      const request = operation === 'start_session' ? await resolveCallerSummary(input.codex, args) : args
      return app === 'codex' ? await codexHandler(operation, request) : await claudeHandler(operation, request)
    } catch (error) {
      return failureFromError(error)
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST' || request.headers['x-cordisx-bridge-token'] !== token) {
          reply(response, 403, { ok: false, value: bridgeFailure('malformed-request', { message: 'forbidden' }) })
          return
        }
        const body = object(await readBody(request)) ?? {}
        if (request.url === '/sessions') {
          if (!isBridgeApp(body.app)) {
            reply(response, 400, {
              ok: false,
              value: bridgeFailure('unknown-app', { message: 'app must be "codex" or "claude"' }),
            })
            return
          }
          if (!isBridgeOperation(body.operation)) {
            reply(response, 400, {
              ok: false,
              value: bridgeFailure('unknown-operation', { message: `unknown operation ${String(body.operation)}` }),
            })
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
            else {
              item!.reject(
                new AgentBridgeUnavailable(
                  text(body.error, 2048) ?? 'Claude request failed',
                  'claude-plugin-unavailable',
                ),
              )
            }
          }
          reply(response, 200, { ok: true, value: {} })
        } else {
          reply(response, 404, { ok: false, value: bridgeFailure('unknown-operation', { message: 'not-found' }) })
        }
      } catch (error) {
        const failure = failureFromError(error)
        reply(response, failure.reason === 'malformed-request' ? 400 : 500, { ok: false, value: failure })
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
        item.reject(new AgentBridgeUnavailable('The CordisX agent bridge closed'))
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
