import { CordisXCliParseError } from './parse-error.js'

export type CordisXPluginManagementCommand =
  | 'list'
  | 'search'
  | 'info'
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
  | 'uninstall'
  | 'hide'
  | 'unhide'

export type CordisXSourceManagementCommand =
  | 'list'
  | 'add'
  | 'edit'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'refresh'

export interface CordisXManagementOptions {
  readonly profile?: string
  readonly json: boolean
  readonly dryRun: boolean
  readonly yes: boolean
}

interface CordisXManagementBaseInvocation {
  readonly action: 'management'
  readonly options: CordisXManagementOptions
}

export interface CordisXManagementHelpInvocation extends CordisXManagementBaseInvocation {
  readonly namespace: 'plugin' | 'source'
  readonly command: 'help'
}

export interface CordisXPluginManagementInvocation extends CordisXManagementBaseInvocation {
  readonly namespace: 'plugin'
  readonly command: CordisXPluginManagementCommand
  readonly target?: string
  readonly query?: string
  readonly source?: string
  readonly version?: string
  readonly includeHidden?: true
}

export interface CordisXSourceManagementInvocation extends CordisXManagementBaseInvocation {
  readonly namespace: 'source'
  readonly command: CordisXSourceManagementCommand
  readonly target?: string
  readonly url?: string
  readonly name?: string
  readonly description?: string
  readonly trusted?: boolean
}

export type CordisXManagementInvocation =
  | CordisXManagementHelpInvocation
  | CordisXPluginManagementInvocation
  | CordisXSourceManagementInvocation

type BooleanOption = 'json' | 'dryRun' | 'yes' | 'includeHidden' | 'trusted' | 'untrusted' | 'help'
type ValueOption = 'profile' | 'source' | 'version' | 'url' | 'name' | 'description'
type Option = BooleanOption | ValueOption

interface ParsedManagementArguments {
  readonly positionals: readonly string[]
  readonly booleans: ReadonlySet<BooleanOption>
  readonly values: Readonly<Partial<Record<ValueOption, string>>>
}

const BOOLEAN_OPTIONS = new Map<string, BooleanOption>([
  ['--json', 'json'],
  ['--dry-run', 'dryRun'],
  ['--yes', 'yes'],
  ['--include-hidden', 'includeHidden'],
  ['--trusted', 'trusted'],
  ['--untrusted', 'untrusted'],
  ['--help', 'help'],
  ['-h', 'help'],
])

const VALUE_OPTIONS = new Map<string, ValueOption>([
  ['--profile', 'profile'],
  ['--source', 'source'],
  ['--version', 'version'],
  ['--url', 'url'],
  ['--name', 'name'],
  ['--description', 'description'],
])

const PLUGIN_COMMANDS = new Set<CordisXPluginManagementCommand>([
  'list',
  'search',
  'info',
  'install',
  'update',
  'enable',
  'disable',
  'uninstall',
  'hide',
  'unhide',
])

const SOURCE_COMMANDS = new Set<CordisXSourceManagementCommand>([
  'list',
  'add',
  'edit',
  'enable',
  'disable',
  'remove',
  'refresh',
])

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

function parseArguments(args: readonly string[]): ParsedManagementArguments {
  const positionals: string[] = []
  const booleans = new Set<BooleanOption>()
  const values: Partial<Record<ValueOption, string>> = {}
  const seen = new Set<Option>()

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) continue
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      throw new CordisXCliParseError(
        'unexpected-host-arguments',
        'plugin and source management commands do not accept host arguments after --',
      )
    }

    const separator = token.startsWith('--') ? token.indexOf('=') : -1
    const option = separator === -1 ? token : token.slice(0, separator)
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1)
    const boolean = BOOLEAN_OPTIONS.get(option)
    if (boolean !== undefined) {
      if (inlineValue !== undefined) {
        throw new CordisXCliParseError('invalid-option-value', `${option} does not accept a value`)
      }
      if (seen.has(boolean)) {
        throw new CordisXCliParseError('duplicate-option', `${option} may only be specified once`)
      }
      seen.add(boolean)
      booleans.add(boolean)
      continue
    }

    const value = VALUE_OPTIONS.get(option)
    if (value === undefined) {
      throw new CordisXCliParseError('unknown-option', `unknown CordisX management option: ${option}`)
    }
    if (seen.has(value)) {
      throw new CordisXCliParseError('duplicate-option', `${option} may only be specified once`)
    }
    seen.add(value)
    const raw = inlineValue ?? args[index + 1]
    if (raw === undefined || (inlineValue === undefined && raw.startsWith('-'))) {
      throw new CordisXCliParseError('missing-option-value', `${option} requires a value`)
    }
    if (inlineValue === undefined) index += 1
    values[value] = raw
  }

  const profile = values.profile
  if (profile !== undefined && !PROFILE_ID.test(profile)) {
    throw new CordisXCliParseError(
      'invalid-option-value',
      'profile must match [a-z0-9][a-z0-9._-]{0,63}',
    )
  }
  return { positionals, booleans, values }
}

function options(parsed: ParsedManagementArguments): CordisXManagementOptions {
  return {
    ...(parsed.values.profile === undefined ? {} : { profile: parsed.values.profile }),
    json: parsed.booleans.has('json'),
    dryRun: parsed.booleans.has('dryRun'),
    yes: parsed.booleans.has('yes'),
  }
}

function rejectOptions(
  parsed: ParsedManagementArguments,
  command: string,
  unsupported: readonly Option[],
): void {
  const supplied = unsupported.find(option =>
    parsed.booleans.has(option as BooleanOption) || parsed.values[option as ValueOption] !== undefined
  )
  if (supplied !== undefined) {
    const spelling = supplied === 'dryRun'
      ? '--dry-run'
      : supplied === 'includeHidden'
      ? '--include-hidden'
      : `--${supplied}`
    throw new CordisXCliParseError('unsupported-option', `${spelling} is not valid with ${command}`)
  }
}

function requireExactly(positionals: readonly string[], count: number, usage: string): void {
  if (positionals.length !== count) {
    throw new CordisXCliParseError('unexpected-positional', `Usage: ${usage}`)
  }
}

function parsePlugin(parsed: ParsedManagementArguments): CordisXManagementInvocation {
  const command = parsed.positionals[0]
  if (parsed.booleans.has('help') || command === undefined || command === 'help') {
    return { action: 'management', namespace: 'plugin', command: 'help', options: options(parsed) }
  }
  if (!PLUGIN_COMMANDS.has(command as CordisXPluginManagementCommand)) {
    throw new CordisXCliParseError('unexpected-positional', `unknown plugin command: ${command}`)
  }
  const pluginCommand = command as CordisXPluginManagementCommand
  const operands = parsed.positionals.slice(1)
  const queryCommand = pluginCommand === 'list' || pluginCommand === 'search' || pluginCommand === 'info'
  if (queryCommand) rejectOptions(parsed, `cordisx plugin ${pluginCommand}`, ['dryRun', 'yes'])
  if (pluginCommand !== 'list' && pluginCommand !== 'search') {
    rejectOptions(parsed, `cordisx plugin ${pluginCommand}`, ['includeHidden'])
  }
  if (!['search', 'info', 'install', 'update', 'hide', 'unhide'].includes(pluginCommand)) {
    rejectOptions(parsed, `cordisx plugin ${pluginCommand}`, ['source'])
  }
  if (!['search', 'info', 'install', 'update'].includes(pluginCommand)) {
    rejectOptions(parsed, `cordisx plugin ${pluginCommand}`, ['version'])
  }
  rejectOptions(parsed, `cordisx plugin ${pluginCommand}`, ['url', 'name', 'description', 'trusted', 'untrusted'])

  if (pluginCommand === 'list') requireExactly(operands, 0, 'cordisx plugin list [options]')
  else {
    requireExactly(
      operands,
      1,
      `cordisx plugin ${pluginCommand} <${pluginCommand === 'search' ? 'query' : 'plugin-id'}> [options]`,
    )
  }

  return {
    action: 'management',
    namespace: 'plugin',
    command: pluginCommand,
    options: options(parsed),
    ...(pluginCommand === 'search' ? { query: operands[0] } : {}),
    ...(pluginCommand !== 'list' && pluginCommand !== 'search' ? { target: operands[0] } : {}),
    ...(parsed.values.source === undefined ? {} : { source: parsed.values.source }),
    ...(parsed.values.version === undefined ? {} : { version: parsed.values.version }),
    ...(parsed.booleans.has('includeHidden') ? { includeHidden: true as const } : {}),
  }
}

function parseSource(parsed: ParsedManagementArguments): CordisXManagementInvocation {
  const command = parsed.positionals[0]
  if (parsed.booleans.has('help') || command === undefined || command === 'help') {
    return { action: 'management', namespace: 'source', command: 'help', options: options(parsed) }
  }
  if (!SOURCE_COMMANDS.has(command as CordisXSourceManagementCommand)) {
    throw new CordisXCliParseError('unexpected-positional', `unknown source command: ${command}`)
  }
  const sourceCommand = command as CordisXSourceManagementCommand
  const operands = parsed.positionals.slice(1)
  if (sourceCommand === 'list') {
    rejectOptions(parsed, 'cordisx source list', [
      'dryRun',
      'yes',
      'includeHidden',
      'url',
      'name',
      'description',
      'source',
      'version',
      'trusted',
      'untrusted',
    ])
    requireExactly(operands, 0, 'cordisx source list [options]')
  } else if (sourceCommand === 'add') {
    rejectOptions(parsed, 'cordisx source add', ['includeHidden', 'url', 'source', 'version'])
    requireExactly(operands, 1, 'cordisx source add <url> [--trusted|--untrusted] [options]')
  } else if (sourceCommand === 'edit') {
    rejectOptions(parsed, 'cordisx source edit', ['includeHidden', 'source', 'version'])
    requireExactly(
      operands,
      1,
      'cordisx source edit <source-url> [--url <url>] [--name <name>] [--description <text>] [options]',
    )
    if (
      parsed.values.url === undefined && parsed.values.name === undefined && parsed.values.description === undefined
      && !parsed.booleans.has('trusted') && !parsed.booleans.has('untrusted')
    ) {
      throw new CordisXCliParseError(
        'missing-option-value',
        'cordisx source edit requires --url, --name, --description, --trusted, or --untrusted',
      )
    }
  } else if (sourceCommand === 'refresh') {
    rejectOptions(parsed, 'cordisx source refresh', [
      'dryRun',
      'yes',
      'includeHidden',
      'url',
      'name',
      'description',
      'source',
      'version',
      'trusted',
      'untrusted',
    ])
    if (operands.length > 1) {
      throw new CordisXCliParseError('unexpected-positional', 'Usage: cordisx source refresh [source-url] [options]')
    }
  } else {
    rejectOptions(parsed, `cordisx source ${sourceCommand}`, [
      'includeHidden',
      'url',
      'name',
      'description',
      'source',
      'version',
      'trusted',
      'untrusted',
    ])
    requireExactly(operands, 1, `cordisx source ${sourceCommand} <source-url> [options]`)
  }

  if (parsed.booleans.has('trusted') && parsed.booleans.has('untrusted')) {
    throw new CordisXCliParseError('invalid-option-value', '--trusted and --untrusted cannot be used together')
  }
  return {
    action: 'management',
    namespace: 'source',
    command: sourceCommand,
    options: options(parsed),
    ...(sourceCommand === 'add' ? { url: operands[0] } : {}),
    ...(sourceCommand !== 'list' && sourceCommand !== 'add' && operands[0] !== undefined
      ? { target: operands[0] }
      : {}),
    ...(parsed.values.url === undefined ? {} : { url: parsed.values.url }),
    ...(parsed.values.name === undefined ? {} : { name: parsed.values.name }),
    ...(parsed.values.description === undefined ? {} : { description: parsed.values.description }),
    ...(parsed.booleans.has('trusted')
      ? { trusted: true }
      : parsed.booleans.has('untrusted')
      ? { trusted: false }
      : {}),
  }
}

export function parseManagementCli(argv: readonly string[]): CordisXManagementInvocation {
  const namespace = argv[0]
  if (namespace !== 'plugin' && namespace !== 'source') {
    throw new CordisXCliParseError('unexpected-positional', 'management command must start with plugin or source')
  }
  const parsed = parseArguments(argv.slice(1))
  return namespace === 'plugin' ? parsePlugin(parsed) : parseSource(parsed)
}
