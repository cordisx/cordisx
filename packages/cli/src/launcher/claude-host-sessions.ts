import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { runningClaudeProfile } from './claude-desktop-process.js'
import { CLAUDE_DEFAULT_PERMISSION_MODE } from './claude-permission-mode.js'

/**
 * Claude Desktop conversations driven from outside the app, with no Claude
 * session open and no "start the session?" prompt.
 *
 * Claude Desktop accepts no debugging switch and refuses its session tools to
 * runs nobody opened, so CordisX works the way the app's own "import CLI
 * session" does: the Claude Code CLI that Claude Desktop installed in the
 * profile runs the turn, and a `claude://resume?session=<id>` link sent to that
 * profile's process (by pid, never to whichever Claude the system picks)
 * imports it as `local_<id>`. Lists and transcripts are read from the
 * profile's session records and the CLI's transcript files.
 */

const run = promisify(execFile)

/** What `cordisx start claude` records for the agent bridge. */
export interface ClaudeDesktopBinding {
  readonly version: 1
  readonly profileId: string
  /** The CordisX home the profile was launched from, where its pid file is. */
  readonly homeDir: string
  readonly dataDir: string
  readonly provider?: {
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv: string
    readonly model?: string
  }
}

export function claudeDesktopBindingPath(cordisxHomeDir: string): string {
  return path.join(cordisxHomeDir, 'run', 'claude-desktop.json')
}

export async function writeClaudeDesktopBinding(cordisxHomeDir: string, binding: ClaudeDesktopBinding): Promise<void> {
  const file = claudeDesktopBindingPath(cordisxHomeDir)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(binding)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

export const claudeSessionLink = (cliSessionId: string): string => `claude://resume?session=${cliSessionId}`

/** Whether the bridge may start Claude itself: `always` once the person said so, else it asks. */
export type ClaudeLaunchPreference = 'ask' | 'always'
export const CLAUDE_LAUNCH_CHOICES = ['once', 'always', 'ask'] as const

export function claudeLaunchPreferencePath(cordisxHomeDir: string): string {
  return path.join(cordisxHomeDir, 'apps', 'claude', 'bridge-launch.json')
}

export async function readClaudeLaunchPreference(cordisxHomeDir: string): Promise<ClaudeLaunchPreference> {
  return (await readJson(claudeLaunchPreferencePath(cordisxHomeDir)))?.launch === 'always' ? 'always' : 'ask'
}

export async function writeClaudeLaunchPreference(
  cordisxHomeDir: string,
  launch: ClaudeLaunchPreference,
): Promise<void> {
  const file = claudeLaunchPreferencePath(cordisxHomeDir)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify({ launch })}\n`, { mode: 0o600 })
}

/**
 * What an agent hears when the target app is closed and nobody said it may be
 * started. The Claude plugin answers the same shape for Codex.
 */
export function appLaunchQuestion(app: 'codex' | 'claude') {
  const name = app === 'codex' ? 'Codex Desktop' : 'Claude Desktop'
  return Object.freeze({
    status: 'needs-confirmation',
    reason: `${app}-not-running`,
    question: `${name} is not running. Start it?`,
    howToContinue:
      `Ask the user, in their language, whether to start ${name}. If they agree, call this tool again with the same arguments plus launch "once" (start it this time) or "always" (start it automatically from now on, without asking). Do not retry without their answer.`,
  })
}
const CLAUDE_LAUNCH_QUESTION = appLaunchQuestion('claude')

const LAUNCH_WAIT_MS = 30_000

const MAX_TRANSCRIPT_CHARS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined

interface SessionRecord {
  readonly sessionId: string
  readonly cliSessionId: string
  readonly title: string
  readonly cwd?: string
  readonly model?: string
  readonly updatedAt?: number
  readonly archived: boolean
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

async function directories(parent: string): Promise<readonly string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(parent, entry.name))
  } catch {
    return []
  }
}

/** Every Code session record the profile keeps, newest first. */
export async function readClaudeSessionRecords(dataDir: string): Promise<readonly SessionRecord[]> {
  const records: SessionRecord[] = []
  for (const account of await directories(path.join(dataDir, 'claude-code-sessions'))) {
    for (const organization of await directories(account)) {
      for (const name of await readdir(organization).catch(() => [] as string[])) {
        if (!/^local_.+\.json$/u.test(name)) continue
        const record = await readJson(path.join(organization, name))
        const sessionId = text(record?.sessionId)
        const cliSessionId = text(record?.cliSessionId)
        if (record === undefined || sessionId === undefined || cliSessionId === undefined) continue
        records.push({
          sessionId,
          cliSessionId,
          title: text(record.title, 1024) ?? '',
          ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
          ...(typeof record.model === 'string' ? { model: record.model } : {}),
          ...(typeof record.lastActivityAt === 'number' ? { updatedAt: record.lastActivityAt } : {}),
          archived: record.isArchived === true,
        })
      }
    }
  }
  return records.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
}

/** The CLI transcript of a session, found by id under `~/.claude/projects`. */
export async function findClaudeTranscript(homedir: string, cliSessionId: string): Promise<string | undefined> {
  if (!UUID.test(cliSessionId)) return undefined
  for (const project of await directories(path.join(homedir, '.claude', 'projects'))) {
    const file = path.join(project, `${cliSessionId}.jsonl`)
    try {
      await access(file)
      return file
    } catch { /* next project */ }
  }
  return undefined
}

/** The user and assistant text of a CLI transcript, newest last, bounded. */
export function claudeTranscript(jsonl: string): readonly { role: string; text: string }[] {
  const entries: { role: string; text: string }[] = []
  for (const line of jsonl.split('\n')) {
    let entry: Record<string, unknown> | undefined
    try {
      entry = object(JSON.parse(line))
    } catch {
      continue
    }
    if (entry?.type !== 'user' && entry?.type !== 'assistant') continue
    const content = object(entry.message)?.content
    const said = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : [])
        .map(part => object(part)?.type === 'text' ? object(part)?.text : undefined)
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
    if (said.trim().length > 0) entries.push({ role: entry.type, text: said })
  }
  let budget = MAX_TRANSCRIPT_CHARS
  const kept: { role: string; text: string }[] = []
  for (const entry of entries.reverse()) {
    if (budget <= 0) break
    const clipped = entry.text.length > budget ? `…${entry.text.slice(-budget)}` : entry.text
    budget -= clipped.length
    kept.push({ role: entry.role, text: clipped })
  }
  return kept.reverse()
}

/**
 * The newest Claude Code CLI Claude Desktop installed: the profile's own, else
 * the person's own Claude data folders' (a new profile installs one with its
 * first session).
 */
export async function claudeProfileCli(dataDir: string, homedir = os.homedir()): Promise<string | undefined> {
  const support = path.join(homedir, 'Library', 'Application Support')
  for (const folder of [dataDir, path.join(support, 'Claude-3p'), path.join(support, 'Claude')]) {
    const found = await newestCli(folder)
    if (found !== undefined) return found
  }
  return undefined
}

async function newestCli(dataDir: string): Promise<string | undefined> {
  const versions = await directories(path.join(dataDir, 'claude-code'))
  const ordered = [...versions].sort((left, right) =>
    path.basename(right).localeCompare(path.basename(left), undefined, { numeric: true })
  )
  for (const version of ordered) {
    for (const build of await directories(version)) {
      const binary = path.join(build, 'claude.app', 'Contents', 'MacOS', 'claude')
      try {
        await access(binary)
        return binary
      } catch { /* next build */ }
    }
  }
  return undefined
}

const SEND_URL_SCRIPT = `ObjC.import('Foundation')
function run(argv) {
  const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(Number(argv[0]))
  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x4755524c, 0x4755524c, target, -1, 0)
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(argv[1]), 0x2d2d2d2d)
  const error = Ref()
  const reply = event.sendEventWithOptionsTimeoutError(1, 5, error)
  if (reply.isNil() && !error[0].isNil()) throw new Error(error[0].localizedDescription.js)
  return 'sent'
}`

/** Hands a `claude://` link to one Claude process, as opening it would, without letting the system pick the app. */
export async function sendClaudeUrl(pid: number, url: string): Promise<void> {
  await run('osascript', ['-l', 'JavaScript', '-e', SEND_URL_SCRIPT, String(pid), url], { timeout: 15_000 })
}

/** Processes of Claude Code sessions the app is running now, to tell an open session from a closed one. */
async function liveCliSessions(): Promise<string> {
  try {
    return (await run('ps', ['-axww', '-o', 'command='], { maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch {
    return ''
  }
}

export interface ClaudeHostSessionsInput {
  readonly cordisxHomeDir: string
  readonly homedir?: string
  /** Resolves a model service key by variable name: the launch environment, then the CordisX config. */
  readonly secret: (name: string) => Promise<string | undefined>
  /** The pid of the app running a profile, if it runs. */
  readonly runningPid?: (homeDir: string, profileId: string) => Promise<number | undefined>
  /** The command lines of running processes; a session the app has open shows its id there. */
  readonly processList?: () => Promise<string>
  /** Starts Claude on a profile as `cordisx start claude` does; absent, Claude is never started here. */
  readonly launchClaude?: (
    request: { readonly homeDir: string; readonly profileId: string; readonly providerId?: string },
  ) => Promise<void>
  /** Answers through a Claude session's plugin, for a session the app is running right now. */
  readonly viaPlugin?: (operation: 'send_message', args: Record<string, unknown>, target: string) => Promise<unknown>
}

/** Validated `app: "claude"` operations that need no Claude session to be open. */
export function createClaudeHostSessions(input: ClaudeHostSessionsInput) {
  const homedir = input.homedir ?? os.homedir()

  async function profile(): Promise<{ binding?: ClaudeDesktopBinding; pid?: number }> {
    const binding = await readJson(claudeDesktopBindingPath(input.cordisxHomeDir)) as ClaudeDesktopBinding | undefined
    if (binding?.version !== 1 || typeof binding.dataDir !== 'string' || typeof binding.profileId !== 'string') {
      return {}
    }
    const pid = await (input.runningPid ?? runningClaudeProfile)(
      binding.homeDir ?? input.cordisxHomeDir,
      binding.profileId,
    )
    return pid === undefined ? { binding } : { binding, pid }
  }

  /**
   * The running profile, starting Claude when the person allowed it: this
   * call (`launch: "once" | "always"`, the latter remembered) or an
   * earlier "always". Otherwise the agent gets a question to ask, at once.
   */
  async function running(
    args: Record<string, unknown>,
  ): Promise<ClaudeDesktopBinding | ReturnType<typeof appLaunchQuestion>> {
    const current = await profile()
    if (current.binding !== undefined && current.pid !== undefined) return current.binding
    const choice = args.launch
    if (choice === 'always' || choice === 'ask') await writeClaudeLaunchPreference(input.cordisxHomeDir, choice)
    const allowed = choice === 'once' || choice === 'always'
      || (choice !== 'ask' && await readClaudeLaunchPreference(input.cordisxHomeDir) === 'always')
    if (!allowed || input.launchClaude === undefined) return CLAUDE_LAUNCH_QUESTION
    await input.launchClaude({
      homeDir: current.binding?.homeDir ?? input.cordisxHomeDir,
      profileId: current.binding?.profileId ?? 'default',
      ...(current.binding?.provider === undefined ? {} : { providerId: current.binding.provider.id }),
    })
    for (const deadline = Date.now() + LAUNCH_WAIT_MS; Date.now() < deadline;) {
      const started = await profile()
      if (started.binding !== undefined && started.pid !== undefined) return started.binding
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Claude Desktop did not start within 30 seconds')
  }

  async function findRecord(dataDir: string, sessionId: string): Promise<SessionRecord | undefined> {
    const records = await readClaudeSessionRecords(dataDir)
    return records.find(record => record.sessionId === sessionId || record.cliSessionId === sessionId)
  }

  /** Runs one turn with the profile's CLI in the background, then imports the session into the app. */
  async function runTurn(options: {
    readonly binding: ClaudeDesktopBinding
    readonly cliSessionId: string
    readonly resume: boolean
    readonly prompt: string
    readonly cwd: string
    readonly model?: string
  }): Promise<void> {
    const cli = await claudeProfileCli(options.binding.dataDir, homedir)
    if (cli === undefined) {
      throw new Error('Claude Desktop has not installed Claude Code yet; open one Code session in Claude once')
    }
    const provider = options.binding.provider
    const key = provider === undefined ? undefined : await input.secret(provider.apiKeyEnv)
    if (provider !== undefined && key === undefined) {
      throw new Error(`The key for model service ${provider.id} (${provider.apiKeyEnv}) is not set`)
    }
    const model = options.model ?? provider?.model
    const args = [
      '-p',
      ...(options.resume ? ['--resume', options.cliSessionId] : ['--session-id', options.cliSessionId]),
      '--permission-mode',
      CLAUDE_DEFAULT_PERMISSION_MODE,
      '--output-format',
      'json',
      ...(model === undefined ? [] : ['--model', model]),
    ]
    const environment: Record<string, string | undefined> = { ...process.env }
    // The turn runs outside the app: no CordisX bridge plugin, no inherited app session.
    delete environment.CLAUDE_CODE_PLUGIN_DIRS
    delete environment.CLAUDECODE
    // The CLI reads the gateway from its environment; settings files do not log it in.
    if (provider !== undefined) {
      environment.ANTHROPIC_BASE_URL = provider.baseUrl
      environment.ANTHROPIC_AUTH_TOKEN = key
      delete environment.ANTHROPIC_API_KEY
    }
    const child = spawn(cli, args, { cwd: options.cwd, env: environment, stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end(options.prompt)
    child.once('error', () => undefined)
    child.once('exit', () => {
      void (async () => {
        const { pid } = await profile().catch(() => ({ pid: undefined }))
        if (pid !== undefined) await sendClaudeUrl(pid, claudeSessionLink(options.cliSessionId)).catch(() => undefined)
      })()
    })
  }

  async function read(
    operation: 'list_sessions' | 'read_session',
    args: Record<string, unknown>,
    binding: ClaudeDesktopBinding,
    running: boolean,
  ): Promise<unknown> {
    if (operation === 'list_sessions') {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit as number, 1), 50) : 20
      const search = text(args.searchTerm, 256)?.toLowerCase()
      const sessions = (await readClaudeSessionRecords(binding.dataDir))
        .filter(record => !record.archived)
        .filter(record => search === undefined || record.title.toLowerCase().includes(search))
        .slice(0, limit)
        .map(record => ({ ...record, link: claudeSessionLink(record.cliSessionId) }))
      return { running, sessions }
    }
    const sessionId = text(args.sessionId)
    if (sessionId === undefined) return { status: 'rejected', reason: 'sessionId-required' }
    const record = await findRecord(binding.dataDir, sessionId)
    const cliSessionId = record?.cliSessionId ?? sessionId.replace(/^local_/u, '')
    const file = await findClaudeTranscript(homedir, cliSessionId)
    if (record === undefined && file === undefined) return { status: 'rejected', reason: 'session-not-found' }
    return {
      ...(record ?? { sessionId: `local_${cliSessionId}`, cliSessionId }),
      link: claudeSessionLink(cliSessionId),
      transcript: file === undefined ? [] : claudeTranscript(await readFile(file, 'utf8')),
    }
  }

  return async (operation: unknown, rawArgs: unknown): Promise<unknown> => {
    const args = object(rawArgs) ?? {}
    if (operation === 'list_sessions' || operation === 'read_session') {
      // Reading needs only the profile's files, not the app.
      const current = await profile()
      const binding = current.binding ?? await running(args)
      if (!('version' in binding)) return binding
      return await read(operation, args, binding, current.pid !== undefined || current.binding === undefined)
    }
    if (operation !== 'start_session' && operation !== 'send_message') {
      return { status: 'rejected', reason: 'unknown-operation' }
    }
    const binding = await running(args)
    if (!('version' in binding)) return binding
    if (operation === 'start_session') {
      const prompt = text(args.prompt, 100_000)
      if (prompt === undefined) return { status: 'rejected', reason: 'prompt-required' }
      const cwd = text(args.cwd, 4096) ?? homedir
      if (!path.isAbsolute(cwd)) return { status: 'rejected', reason: 'cwd-must-be-absolute' }
      const cliSessionId = randomUUID()
      await runTurn({ binding, cliSessionId, resume: false, prompt, cwd, ...modelOf(args) })
      return {
        status: 'started',
        sessionId: `local_${cliSessionId}`,
        cliSessionId,
        link: claudeSessionLink(cliSessionId),
        note:
          'The turn runs in the background with the CordisX model service; the session appears in Claude when it finishes, and the link opens it.',
      }
    }
    const sessionId = text(args.sessionId)
    const prompt = text(args.prompt, 100_000)
    if (sessionId === undefined || prompt === undefined) {
      return { status: 'rejected', reason: 'sessionId-and-prompt-required' }
    }
    const record = await findRecord(binding.dataDir, sessionId)
    if (record === undefined) return { status: 'rejected', reason: 'session-not-found' }
    // An open session belongs to the app's own process; a second writer would fork its transcript.
    if (resumes(await (input.processList ?? liveCliSessions)(), record.cliSessionId)) {
      if (input.viaPlugin === undefined) return { status: 'rejected', reason: 'session-open-in-claude' }
      // The open session's own plugin submits it there, as the next turn.
      return await input.viaPlugin(
        'send_message',
        { sessionId: record.sessionId, cliSessionId: record.cliSessionId, prompt },
        record.cliSessionId,
      )
    }
    await runTurn({
      binding,
      cliSessionId: record.cliSessionId,
      resume: true,
      prompt,
      cwd: record.cwd ?? homedir,
      ...(record.model === undefined ? {} : { model: record.model }),
    })
    return { status: 'sent', sessionId: record.sessionId, link: claudeSessionLink(record.cliSessionId) }
  }
}

/** Whether a running Claude Code process holds the session: the app's own (`--resume=<id>`) or a turn of ours. */
export function resumes(processList: string, cliSessionId: string): boolean {
  const flag = new RegExp(`(^|\\s)--resume[= ]${cliSessionId}(\\s|$)`, 'u')
  return processList.split('\n').some(line => flag.test(line))
}

function modelOf(args: Record<string, unknown>): { model?: string } {
  const model = text(args.model)
  return model === undefined ? {} : { model }
}
