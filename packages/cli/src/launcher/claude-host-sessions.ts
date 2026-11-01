import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type HomeConfigProvider, parseHomeConfig } from '../config/home-config.js'
import { readClaudeProviderCatalog } from './claude-desktop-profile.js'
import { runningClaudeProfile } from './claude-desktop-process.js'
import { CLAUDE_DEFAULT_PERMISSION_MODE } from './claude-permission-mode.js'
import { modelsForApp } from './model-service-projection.js'

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
/** How long a started turn gets to fail visibly before the tool answers "started". */
const TURN_REPORT_MS = 8_000

const MAX_TRANSCRIPT_CHARS = 60_000
/** The organization folder Claude Desktop files sessions under on a fresh profile. */
const DEFAULT_ORGANIZATION = '00000000-0000-4000-8000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined

/** `limit` as the tools declare it: a positive integer of message entries, or undefined when absent. */
const transcriptLimit = (value: unknown): number | undefined =>
  Number.isInteger(value) ? Math.min(Math.max(value as number, 1), 200) : undefined

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

/** The user and assistant text of a CLI transcript, newest last, bounded by `limit` entries and 60k characters. */
export function claudeTranscript(
  jsonl: string,
  limit?: number,
): readonly { role: string; text: string }[] {
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
  const newest = limit === undefined ? entries : entries.slice(-Math.max(limit, 0))
  for (const entry of newest.reverse()) {
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
  /** How long a started turn is given to report a failure before the call answers "started" (tests shorten it). */
  readonly turnReportMs?: number
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
    /** A model service this call named, instead of the one the profile was launched on. */
    readonly service?: ClaudeServiceChoice
  }): Promise<TurnHandle> {
    const cli = await claudeProfileCli(options.binding.dataDir, homedir)
    if (cli === undefined) {
      throw new Error('Claude Desktop has not installed Claude Code yet; open one Code session in Claude once')
    }
    const provider = options.service ?? options.binding.provider
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
    // The CLI's own report of a failed turn is the only evidence a background run gives:
    // a nonzero exit, or a JSON result that says it failed.
    const out: Buffer[] = []
    const child = spawn(cli, args, {
      cwd: options.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < 64) out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (out.length < 64) out.push(chunk)
    })
    child.stdin.end(options.prompt)
    child.once('error', () => undefined)
    const ended = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => resolve({ code: null, signal: null }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    void ended.then(async () => {
      const { pid } = await profile().catch(() => ({ pid: undefined }))
      if (pid !== undefined) await sendClaudeUrl(pid, claudeSessionLink(options.cliSessionId)).catch(() => undefined)
    })
    return {
      ended: ended.then(exit => turnFailure(exit, Buffer.concat(out).toString('utf8'))),
    }
  }

  /** Writes a started session's title into the record Claude Desktop lists it by. */
  async function titleStartedSession(
    binding: ClaudeDesktopBinding,
    cliSessionId: string,
    title: string,
  ): Promise<void> {
    const account = await preferredAccount(binding.dataDir)
    const folder = path.join(binding.dataDir, 'claude-code-sessions', account, DEFAULT_ORGANIZATION)
    const sessionId = `local_${cliSessionId}`
    const record = await readJson(path.join(folder, `${sessionId}.json`))
    const file = path.join(folder, `${sessionId}.json`)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeAtomically(
      file,
      JSON.stringify({
        ...(record ?? {}),
        sessionId,
        cliSessionId,
        title,
        titleSource: 'tool',
        cwd: record?.cwd ?? homedir,
        createdAt: typeof record?.createdAt === 'number' ? record.createdAt : Date.now(),
        lastActivityAt: typeof record?.lastActivityAt === 'number' ? record.lastActivityAt : Date.now(),
        isArchived: false,
      }),
    )
  }

  /** The account folder Claude files sessions under: the one its config names, else the first it has, else a fresh one. */
  async function preferredAccount(dataDir: string): Promise<string> {
    const known = (await readJson(path.join(dataDir, 'config.json')))?.lastKnownAccountUuid
    if (typeof known === 'string' && UUID.test(known)) return known
    const existing = (await directories(path.join(dataDir, 'claude-code-sessions'))).map(folder =>
      path.basename(folder)
    )
    return existing.sort()[0] ?? DEFAULT_ORGANIZATION
  }

  /**
   * The Claude model services this home declares for Claude, as
   * `list_model_providers` returns them: the CordisX config's `model-service`
   * entries merged with what the profile's `configLibrary` already holds. The
   * same shape the Codex tool returns, and only ids, titles and model ids: no
   * endpoint and no key.
   */
  async function claudeCatalog(binding: ClaudeDesktopBinding) {
    const providers = (await readClaudeProviderCatalog(await readHomeProviders(input.cordisxHomeDir), binding.dataDir))
      .map(entry => ({
        providerId: entry.providerId,
        title: entry.title,
        models: entry.models.map(id => ({ id, label: id })),
      }))
    return { providers }
  }

  /** `providerId` and `model` for a Claude start, or why they cannot be honored. */
  async function selectClaudeService(
    binding: ClaudeDesktopBinding,
    args: Record<string, unknown>,
  ): Promise<
    | { readonly providerId?: string; readonly model?: string; readonly service?: ClaudeServiceChoice }
    | { readonly status: 'rejected'; readonly reason: string }
  > {
    const catalog = await claudeCatalog(binding)
    const declared = await readHomeProviders(input.cordisxHomeDir)
    const serviceOf = (providerId: string): ClaudeServiceChoice | undefined => {
      const declaration = declared.find(entry => entry.kind === 'model-service' && entry.id === providerId)
      return declaration === undefined || declaration.kind !== 'model-service'
        ? undefined
        : {
          id: declaration.id,
          baseUrl: declaration.baseUrl,
          apiKeyEnv: declaration.apiKeyEnv,
          ...(modelsForApp(declaration, 'claude')[0] === undefined
            ? {}
            : { model: modelsForApp(declaration, 'claude')[0]! }),
        }
    }
    const providerId = text(args.providerId, 128)
    const model = text(args.model)
    if (providerId === undefined) {
      // A model on its own names a model of the service the profile runs on.
      if (model === undefined) return {}
      const profile = binding.provider
      if (profile === undefined) return { status: 'rejected', reason: 'model-without-provider' }
      const known = catalog.providers.find(entry => entry.providerId === profile.id)?.models ?? []
      return known.some(entry => entry.id === model)
        ? { providerId: profile.id, model, service: profile }
        : { status: 'rejected', reason: 'model-not-in-provider-catalog' }
    }
    const provider = catalog.providers.find(entry => entry.providerId === providerId)
    if (provider === undefined) return { status: 'rejected', reason: 'provider-not-configured' }
    const chosen = model ?? provider.models[0]?.id
    if (chosen !== undefined && !provider.models.some(entry => entry.id === chosen)) {
      return { status: 'rejected', reason: 'model-not-in-provider-catalog' }
    }
    const service = serviceOf(providerId)
    if (service === undefined) {
      // A service only the profile's own library holds has no declaration here to
      // take an endpoint and key from; refusing beats starting a turn on the wrong one.
      return { status: 'rejected', reason: 'provider-not-declared' }
    }
    return {
      providerId,
      ...chosen === undefined ? {} : { model: chosen },
      service: chosen === undefined ? service : { ...service, model: chosen },
    }
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
      transcript: file === undefined ? [] : claudeTranscript(await readFile(file, 'utf8'), transcriptLimit(args.limit)),
    }
  }

  return async (operation: unknown, rawArgs: unknown): Promise<unknown> => {
    const args = object(rawArgs) ?? {}
    if (operation === 'list_model_providers') {
      // A catalog read needs only the home config and the profile's files.
      const current = await profile()
      const binding = current.binding ?? {
        dataDir: path.join(input.cordisxHomeDir, 'apps', 'claude', 'profiles', 'default', 'data-3p'),
      } as ClaudeDesktopBinding
      return await claudeCatalog(binding)
    }
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
      const selection = await selectClaudeService(binding, args)
      if ('status' in selection) return selection
      const cliSessionId = randomUUID()
      const turn = await runTurn({
        binding,
        cliSessionId,
        resume: false,
        prompt,
        cwd,
        ...selection.model === undefined ? {} : { model: selection.model },
        ...selection.service === undefined ? {} : { service: selection.service },
      })
      const title = text(args.title, 120)
      if (title !== undefined) await titleStartedSession(binding, cliSessionId, title).catch(() => undefined)
      // A turn may run for minutes: only a failure it reports within a brief wait
      // is folded in, and a slow turn stays "started" with a note on how to check.
      const reported = await withinReportWindow(turn.ended, input.turnReportMs)
      return {
        status: 'started',
        sessionId: `local_${cliSessionId}`,
        cliSessionId,
        ...(title === undefined ? {} : { title }),
        ...(selection.providerId === undefined ? {} : { modelProvider: selection.providerId }),
        ...(selection.model === undefined ? {} : { model: selection.model }),
        link: claudeSessionLink(cliSessionId),
        ...(reported === undefined ? {} : { turn: reported }),
        note: reported === undefined
          ? 'The turn runs in the background with the CordisX model service; the session appears in Claude when it finishes, and the link opens it. Read the session again to see whether that turn finished.'
          : reported.status === 'failed'
          ? 'The first turn failed before the session could appear in Claude; the link still opens it, and another message runs a new turn.'
          : 'The turn finished; the session appears in Claude, and the link opens it.',
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

interface TurnHandle {
  /** Resolves once the turn ended, with what its exit said about it. Never rejects. */
  readonly ended: Promise<TurnResult>
}

interface TurnResult {
  readonly status: 'succeeded' | 'failed'
  readonly error?: string
}

/** The turn's result if it ended within the report window, else undefined: it is still running. */
async function withinReportWindow(
  ended: Promise<TurnResult>,
  windowMs = TURN_REPORT_MS,
): Promise<TurnResult | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), windowMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([ended, late])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * What a finished background turn reported. The CLI prints one JSON result on
 * `--output-format json`; a nonzero exit or `is_error` means the turn failed,
 * and the reason is what the CLI said, never the model service's key.
 */
export function turnFailure(
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null },
  output: string,
  key?: string,
): { readonly status: 'succeeded' | 'failed'; readonly error?: string } {
  const scrub = (value: string): string => (key === undefined ? value : value.split(key).join('[redacted]'))
  let reported: Record<string, unknown> | undefined
  for (const line of output.split('\n').reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      reported = object(JSON.parse(candidate))
      if (reported !== undefined) break
    } catch { /* a later line may still be the result */ }
  }
  const failed = exit.code !== 0 || reported?.is_error === true || reported?.subtype === 'error'
  if (!failed) return { status: 'succeeded' }
  const said = typeof reported?.result === 'string'
    ? reported.result
    : typeof reported?.error === 'string'
    ? reported.error
    : undefined
  const tail = said ?? output.trim().slice(-1000)
  const reason = exit.signal !== null
    ? `The turn was stopped by ${exit.signal}`
    : exit.code === null
    ? 'The turn could not be run'
    : `The turn exited with code ${exit.code}`
  return {
    status: 'failed',
    error: scrub(tail.length === 0 ? reason : `${reason}: ${tail}`).slice(0, 2000),
  }
}

/** A record is replaced in one step, so a reader never sees half a session. */
async function writeAtomically(file: string, content: string): Promise<void> {
  const temporary = `${file}.cordisx-${process.pid}.tmp`
  await writeFile(temporary, `${content}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

/** The CordisX config's provider declarations; a missing or invalid file declares none. */
export async function readHomeProviders(cordisxHomeDir: string): Promise<readonly HomeConfigProvider[]> {
  try {
    const document = JSON.parse(await readFile(path.join(cordisxHomeDir, 'config.json'), 'utf8'))
    return parseHomeConfig(document).providers
  } catch {
    return []
  }
}

/** One model service a call named, as the turn needs it: where to send, which key, which model. */
interface ClaudeServiceChoice {
  readonly id: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly model?: string
}
