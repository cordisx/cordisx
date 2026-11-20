import { readFile } from 'node:fs/promises'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'

export interface CodexCommand {
  readonly operation: string
  readonly input: Record<string, unknown>
  readonly profile?: string
  readonly context?: string
  readonly sourceSession?: string
  readonly sourceTurn?: string
}
const failure = () => {
  throw new Error('INVALID_CODEX_OPTIONS')
}

/** Explicit command scope: an omitted chat target never becomes a defaults write. */
export async function parseCodexCommand(args: readonly string[], models = false): Promise<CodexCommand> {
  const command: string[] = []
  let index = 0
  while (index < args.length && !args[index]!.startsWith('--')) command.push(args[index++]!)
  const options: Record<string, string> = Object.create(null)
  const allowed = [
    '--profile',
    '--context',
    '--session',
    '--host',
    '--source-session',
    '--source-turn',
    '--provider',
    '--model',
    '--project',
    '--message',
    '--title',
    '--operation',
    '--revision',
    '--execution',
    '--approval',
    '--effort',
    '--work-mode',
    '--network',
    '--reviewer',
    '--fast',
    '--cwd',
    '--input-file',
  ]
  for (; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1]
    if (!allowed.includes(key) || value === undefined || Object.hasOwn(options, key)) failure()
    options[key] = value!
  }
  if (options['--host'] !== undefined && options['--host'] !== 'local') throw new Error('CODEX_HOST_UNAVAILABLE')
  if (
    ['--profile', '--context', '--source-session', '--source-turn'].some(key =>
      options[key] !== undefined && !options[key]
    )
  ) failure()
  const scopes = ['--profile', '--context', '--host', '--source-session', '--source-turn']
  const route = command.join(' ')
  let operation: string, accepted: string[], input: Record<string, unknown> = {}
  const id = () => ({ ...(options['--session'] === undefined ? {} : { sessionId: options['--session'] }) })
  if (!models && route === 'capabilities') {
    operation = 'capabilities'
    accepted = []
  } else if (!models && route === 'providers list') {
    operation = 'list'
    accepted = []
  } else if (
    !models
    && [
      'defaults model get',
      'defaults model set',
      'chats fast get',
      'chats fast set',
      'chats project get',
      'chats project set',
      'chats reviewer get',
      'chats reviewer set',
    ].includes(route)
  ) {
    const defaults = route.startsWith('defaults'), write = route.endsWith('set'), project = route.includes('project')
    const reviewer = route.includes('reviewer')
    operation = `configuration:${defaults ? 'model-defaults' : project ? 'project' : reviewer ? 'reviewer' : 'fast'}${
      write ? '-set' : ''
    }`
    accepted = [
      ...(defaults ? [] : ['--session']),
      ...(write
        ? [
          '--revision',
          ...(defaults
            ? ['--provider', '--model', '--fast', '--input-file']
            : project
            ? ['--project', '--cwd']
            : reviewer
            ? ['--reviewer']
            : ['--fast']),
        ]
        : []),
    ]
    input = defaults ? {} : id()
    if (write) {
      if (!/^\d+$/u.test(options['--revision'] ?? '')) failure()
      input.expectedRevision = Number(options['--revision'])
      if (!Number.isSafeInteger(input.expectedRevision)) failure()
      if (reviewer) {
        if (!['user', 'auto_review'].includes(options['--reviewer'] ?? '')) failure()
        input.reviewer = options['--reviewer']
      } else if (project) {
        if (!options['--project']) failure()
        input.projectId = options['--project']
        if (options['--cwd']) input.cwd = options['--cwd']
      } else {
        if (options['--fast'] !== undefined && !['true', 'false'].includes(options['--fast'])) failure()
        const selected = {
          ...(options['--provider'] ? { providerId: options['--provider'] } : {}),
          ...(options['--model'] ? { model: options['--model'] } : {}),
          ...(options['--fast'] === undefined ? {} : { fast: options['--fast'] === 'true' }),
        }
        if (defaults) {
          if (options['--input-file'] && Object.keys(selected).length) failure()
          input.settings = options['--input-file'] ? await readInput(options['--input-file']) : selected
        } else {
          if (options['--fast'] === undefined) failure()
          input.fast = selected.fast
        }
      }
    }
  } else if (!models && route === 'chats provider set') {
    operation = 'select'
    accepted = ['--session', '--provider', '--model']
    input = { threadId: options['--session'], providerId: options['--provider'], model: options['--model'] }
    if (!input.providerId || !input.model) failure()
  } else if (
    !models
    && ['chats settings get', 'chats settings set', 'chats settings reset', 'defaults get', 'defaults set'].includes(
      route,
    )
  ) {
    const defaults = route.startsWith('defaults '), write = !route.endsWith('get')
    operation = `execution:execution-${defaults ? 'defaults' : 'settings'}${write ? '-set' : ''}`
    accepted = [
      ...(defaults ? [] : ['--session']),
      ...(write
        ? ['--revision', '--input-file', '--execution', '--approval', '--effort', '--work-mode', '--network']
        : []),
    ]
    input = defaults ? {} : id()
    if (write) {
      if (!/^\d+$/u.test(options['--revision'] ?? '')) failure()
      input.expectedRevision = Number(options['--revision'])
      if (!Number.isSafeInteger(input.expectedRevision)) failure()
      if (route.endsWith('reset')) {
        accepted = ['--session', '--revision']
        input.settings = null
      } else {
        const settings: Record<string, unknown> = {}
        for (
          const [flag, key] of [['--execution', 'execution'], ['--approval', 'approval'], ['--effort', 'effort'], [
            '--work-mode',
            'workMode',
          ]] as const
        ) {
          if (options[flag] !== undefined) settings[key] = options[flag]
        }
        if (options['--network'] !== undefined) {
          if (!['true', 'false'].includes(options['--network'])) failure()
          settings.networkAccess = options['--network'] === 'true'
        }
        if (options['--input-file'] && Object.keys(settings).length) failure()
        input.settings = parseChatExecutionSettings(
          options['--input-file'] ? await readInput(options['--input-file']) : settings,
        )
      }
    }
  } else if (models && route === 'services list') {
    operation = 'model-services:read'
    accepted = []
  } else if (models && route === 'services save') {
    operation = 'model-services:save'
    accepted = ['--input-file']
    if (!options['--input-file']) failure()
    input = await readInput(options['--input-file']!)
  } else if (!models && route === 'chats create') {
    operation = 'create'
    accepted = ['--provider', '--model', '--fast', '--project', '--message', '--title', '--operation']
    if (!options['--message'] || !options['--operation']) failure()
    if (options['--fast'] !== undefined && !['true', 'false'].includes(options['--fast'])) failure()
    input = {
      ...(options['--provider'] ? { providerId: options['--provider'] } : {}),
      ...(options['--model'] ? { model: options['--model'] } : {}),
      ...(options['--fast'] === undefined ? {} : { fast: options['--fast'] === 'true' }),
      prompt: options['--message'],
      operationId: options['--operation'],
      ...(options['--title'] ? { title: options['--title'] } : {}),
      target: options['--project']
        ? { type: 'project', projectId: options['--project'], environment: { type: 'local' } }
        : { type: 'projectless' },
    }
  } else throw new Error('INVALID_CODEX_COMMAND')
  if (Object.keys(options).some(key => !scopes.includes(key) && !accepted.includes(key))) failure()
  return {
    operation,
    input,
    ...(options['--profile'] ? { profile: options['--profile'] } : {}),
    ...(options['--context'] ? { context: options['--context'] } : {}),
    ...(options['--source-session'] ? { sourceSession: options['--source-session'] } : {}),
    ...(options['--source-turn'] ? { sourceTurn: options['--source-turn'] } : {}),
  }
}
async function readInput(file: string): Promise<Record<string, unknown>> {
  try {
    let source = ''
    if (file === '-') {
      if (process.stdin.isTTY) throw new Error('pipe-required')
      for await (const chunk of process.stdin) {
        source += String(chunk)
        if (Buffer.byteLength(source) > 256 * 1024) throw new Error('large')
      }
    } else source = await readFile(file, 'utf8')
    if (Buffer.byteLength(source) > 256 * 1024) throw new Error('large')
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
    return value as Record<string, unknown>
  } catch {
    throw new Error('INVALID_CODEX_INPUT')
  }
}
