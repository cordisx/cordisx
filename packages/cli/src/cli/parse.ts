export type CordisXCliAction = 'help' | 'launch' | 'setup' | 'config' | 'doctor' | 'dev'
export type CordisXDataMode = 'shared' | 'host-isolated'

export type CordisXCliParseErrorCode =
  | 'unknown-option'
  | 'duplicate-option'
  | 'missing-option-value'
  | 'invalid-option-value'
  | 'unexpected-positional'
  | 'unexpected-host-arguments'
  | 'unsupported-option'
  | 'conflicting-options'

export class CordisXCliParseError extends Error {
  readonly code: CordisXCliParseErrorCode

  constructor(code: CordisXCliParseErrorCode, message: string) {
    super(message)
    this.name = 'CordisXCliParseError'
    this.code = code
  }
}

export interface CordisXLauncherOptions {
  readonly attach: boolean
  readonly system: boolean
  readonly isolated: boolean
  readonly profileDir?: string
  readonly executable?: string
  readonly debugPort?: number
  readonly onlineDevtools: boolean
  readonly dryRun: boolean
}

export interface CordisXHelpInvocation {
  readonly action: 'help'
}

export interface CordisXLaunchInvocation {
  readonly action: 'launch'
  readonly app?: string
  readonly profile?: string
  readonly dataMode?: CordisXDataMode
  readonly options: CordisXLauncherOptions
  readonly hostArgs: readonly string[]
}

export interface CordisXSetupInvocation {
  readonly action: 'setup'
}

export interface CordisXConfigInvocation {
  readonly action: 'config'
}

export interface CordisXDoctorInvocation {
  readonly action: 'doctor'
}

export interface CordisXDevInvocation {
  readonly action: 'dev'
  readonly pluginPath?: string
  readonly configPath?: string
  readonly naturalLanguage: boolean
  readonly dataMode?: CordisXDataMode
  readonly options: CordisXLauncherOptions
  readonly hostArgs: readonly string[]
}

export type CordisXCliInvocation =
  | CordisXHelpInvocation
  | CordisXLaunchInvocation
  | CordisXSetupInvocation
  | CordisXConfigInvocation
  | CordisXDoctorInvocation
  | CordisXDevInvocation

type BooleanOptionName = 'attach' | 'system' | 'isolated' | 'onlineDevtools' | 'dryRun' | 'naturalLanguage' | 'help'
type ValueOptionName = 'dataMode' | 'profileDir' | 'executable' | 'debugPort' | 'configPath'
type ParsedOptionName = BooleanOptionName | ValueOptionName

interface ParsedOptions {
  attach: boolean
  system: boolean
  isolated: boolean
  onlineDevtools: boolean
  dryRun: boolean
  naturalLanguage: boolean
  help: boolean
  dataMode?: CordisXDataMode
  profileDir?: string
  executable?: string
  debugPort?: number
  configPath?: string
}

const BOOLEAN_OPTIONS = new Map<string, BooleanOptionName>([
  ['--attach', 'attach'],
  ['--system', 'system'],
  ['--isolated', 'isolated'],
  ['--online-devtools', 'onlineDevtools'],
  ['--dry-run', 'dryRun'],
  ['--natural-language', 'naturalLanguage'],
  ['--help', 'help'],
  ['-h', 'help'],
])

const VALUE_OPTIONS = new Map<string, ValueOptionName>([
  ['--data', 'dataMode'],
  ['--profile-dir', 'profileDir'],
  ['--executable', 'executable'],
  ['--debug-port', 'debugPort'],
  ['--config', 'configPath'],
  ['-c', 'configPath'],
])

const COMMANDS = new Set(['help', 'setup', 'config', 'doctor', 'dev'])
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function parseValue(option: string, name: ValueOptionName, raw: string): string | number {
  if (raw.length === 0) {
    throw new CordisXCliParseError('missing-option-value', `${option} requires a value`)
  }
  if (name === 'dataMode') {
    if (raw !== 'shared' && raw !== 'host-isolated' && raw !== 'isolated') {
      throw new CordisXCliParseError(
        'invalid-option-value',
        `${option} must be either "shared" or "host-isolated"`,
      )
    }
    // v1 used `isolated` for a fully private Host root. Keep it as a
    // lossless compatibility alias without calling ordinary CordisX profile
    // isolation a separate login.
    return raw === 'isolated' ? 'host-isolated' : raw
  }
  if (name === 'debugPort') {
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new CordisXCliParseError(
        'invalid-option-value',
        '--debug-port must be an integer between 1024 and 65535',
      )
    }
    return port
  }
  return raw
}

function parseCordisXOptions(args: readonly string[]): {
  readonly options: ParsedOptions
  readonly positionals: readonly string[]
} {
  const options: ParsedOptions = {
    attach: false,
    system: false,
    isolated: false,
    onlineDevtools: false,
    dryRun: false,
    naturalLanguage: false,
    help: false,
  }
  const seen = new Set<ParsedOptionName>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) continue
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const separator = token.startsWith('--') ? token.indexOf('=') : -1
    const option = separator === -1 ? token : token.slice(0, separator)
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1)
    const booleanName = BOOLEAN_OPTIONS.get(option)
    if (booleanName !== undefined) {
      if (inlineValue !== undefined) {
        throw new CordisXCliParseError('invalid-option-value', `${option} does not accept a value`)
      }
      if (seen.has(booleanName)) {
        throw new CordisXCliParseError('duplicate-option', `${option} may only be specified once`)
      }
      seen.add(booleanName)
      options[booleanName] = true
      continue
    }

    const valueName = VALUE_OPTIONS.get(option)
    if (valueName === undefined) {
      throw new CordisXCliParseError('unknown-option', `unknown CordisX option: ${option}`)
    }
    if (seen.has(valueName)) {
      throw new CordisXCliParseError('duplicate-option', `${option} may only be specified once`)
    }
    seen.add(valueName)

    const raw = inlineValue ?? args[index + 1]
    if (raw === undefined || (inlineValue === undefined && raw.startsWith('-'))) {
      throw new CordisXCliParseError('missing-option-value', `${option} requires a value`)
    }
    if (inlineValue === undefined) index += 1
    const value = parseValue(option, valueName, raw)
    if (valueName === 'dataMode') options.dataMode = value as CordisXDataMode
    else if (valueName === 'debugPort') options.debugPort = value as number
    else options[valueName] = value as string
  }

  return { options, positionals }
}

function launcherOptions(options: ParsedOptions): CordisXLauncherOptions {
  return {
    attach: options.attach,
    system: options.system,
    isolated: options.isolated,
    onlineDevtools: options.onlineDevtools,
    dryRun: options.dryRun,
    ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.debugPort === undefined ? {} : { debugPort: options.debugPort }),
  }
}

function assertLauncherOptionCompatibility(options: ParsedOptions): void {
  if (options.system && options.isolated) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--system and --isolated cannot be used together',
    )
  }
  if (options.attach && (options.isolated || options.profileDir !== undefined)) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--attach cannot be combined with --isolated or --profile-dir',
    )
  }
  if (options.attach && options.system) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--attach and --system cannot be used together',
    )
  }
  if (options.attach && options.dataMode !== undefined) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--attach cannot override a host-data profile',
    )
  }
  if (options.attach && options.executable !== undefined) {
    throw new CordisXCliParseError(
      'unsupported-option',
      '--executable is not valid with --attach because no host is launched',
    )
  }
  if (options.attach && options.onlineDevtools) {
    throw new CordisXCliParseError(
      'unsupported-option',
      '--online-devtools is not valid with --attach because the endpoint already exists',
    )
  }
  if (options.system && options.profileDir !== undefined) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--system and --profile-dir cannot be used together',
    )
  }
  if (options.system && options.onlineDevtools) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--online-devtools is only valid with an independent Chromium profile',
    )
  }
}

function assertNoOptions(options: ParsedOptions, action: 'setup' | 'config' | 'doctor'): void {
  const supplied = [
    options.attach && '--attach',
    options.system && '--system',
    options.isolated && '--isolated',
    options.onlineDevtools && '--online-devtools',
    options.dryRun && '--dry-run',
    options.naturalLanguage && '--natural-language',
    options.dataMode !== undefined && '--data',
    options.profileDir !== undefined && '--profile-dir',
    options.executable !== undefined && '--executable',
    options.debugPort !== undefined && '--debug-port',
    options.configPath !== undefined && '--config',
  ].find((value): value is string => typeof value === 'string')
  if (supplied !== undefined) {
    if (supplied === '--config') {
      throw new CordisXCliParseError('unsupported-option', '--config is only valid with cordisx dev')
    }
    throw new CordisXCliParseError('unsupported-option', `${supplied} is not valid with cordisx ${action}`)
  }
}

/**
 * Parse arguments following the `cordisx` executable name.
 *
 * The first `--` is a hard boundary. Every later token is returned unchanged
 * in `hostArgs` and is never interpreted as a CordisX option.
 */
export function parseCordisXCli(argv: readonly string[]): CordisXCliInvocation {
  const boundary = argv.indexOf('--')
  const cordisArgs = boundary === -1 ? argv : argv.slice(0, boundary)
  const hostArgs = boundary === -1 ? [] : argv.slice(boundary + 1)
  const { options, positionals } = parseCordisXOptions(cordisArgs)

  if (options.help || positionals[0] === 'help') return { action: 'help' }

  const first = positionals[0]
  const action = first !== undefined && COMMANDS.has(first) ? first : 'launch'
  if (action === 'setup' || action === 'config' || action === 'doctor') {
    if (positionals.length > 1) {
      throw new CordisXCliParseError(
        'unexpected-positional',
        `cordisx ${action} does not accept positional arguments`,
      )
    }
    if (hostArgs.length > 0) {
      throw new CordisXCliParseError(
        'unexpected-host-arguments',
        `cordisx ${action} does not accept host arguments after --`,
      )
    }
    assertNoOptions(options, action)
    return { action }
  }

  if (action === 'dev') {
    if (positionals.length > 2) {
      throw new CordisXCliParseError(
        'unexpected-positional',
        'cordisx dev accepts at most one plugin path',
      )
    }
    assertLauncherOptionCompatibility(options)
    if (options.attach && hostArgs.length > 0) {
      throw new CordisXCliParseError(
        'unexpected-host-arguments',
        '--attach does not launch a host and cannot accept host arguments',
      )
    }
    if (options.dataMode !== undefined) {
      throw new CordisXCliParseError('unsupported-option', '--data is not valid with cordisx dev')
    }
    if (positionals[1] !== undefined && options.configPath !== undefined) {
      throw new CordisXCliParseError(
        'conflicting-options',
        'cordisx dev accepts either a plugin path or --config, not both',
      )
    }
    if (options.naturalLanguage && (positionals[1] !== undefined || options.configPath !== undefined)) {
      throw new CordisXCliParseError(
        'conflicting-options',
        '--natural-language creates its managed development entry and cannot be combined with a plugin path or --config',
      )
    }
    if (options.naturalLanguage && options.attach) {
      throw new CordisXCliParseError(
        'conflicting-options',
        '--natural-language must launch a Host so the active development entry is available to the Codex session',
      )
    }
    return {
      action: 'dev',
      ...(positionals[1] === undefined ? {} : { pluginPath: positionals[1] }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      naturalLanguage: options.naturalLanguage,
      options: launcherOptions(options),
      hostArgs,
    }
  }

  assertLauncherOptionCompatibility(options)
  if (options.naturalLanguage) {
    throw new CordisXCliParseError('unsupported-option', '--natural-language is only valid with cordisx dev')
  }
  if (options.configPath !== undefined) {
    throw new CordisXCliParseError('unsupported-option', '--config is only valid with cordisx dev')
  }
  if (options.isolated) {
    throw new CordisXCliParseError(
      'unsupported-option',
      '--isolated is only valid with cordisx dev; use --data host-isolated for a separate Host root',
    )
  }
  if (positionals.length > 2) {
    throw new CordisXCliParseError(
      'unexpected-positional',
      'cordisx launch accepts at most two positional arguments: [app] [profile]',
    )
  }
  const profile = positionals[1]
  const app = positionals[0]
  if (app !== undefined && !PROFILE_ID.test(app)) {
    throw new CordisXCliParseError(
      'invalid-option-value',
      'app must match [a-z0-9][a-z0-9._-]{0,63}',
    )
  }
  if (profile !== undefined && !PROFILE_ID.test(profile)) {
    throw new CordisXCliParseError(
      'invalid-option-value',
      'profile must match [a-z0-9][a-z0-9._-]{0,63}',
    )
  }
  if (options.attach && profile !== undefined) {
    throw new CordisXCliParseError(
      'conflicting-options',
      '--attach cannot select a named profile',
    )
  }
  if (options.attach && hostArgs.length > 0) {
    throw new CordisXCliParseError(
      'unexpected-host-arguments',
      '--attach does not launch a host and cannot accept host arguments',
    )
  }
  return {
    action: 'launch',
    ...(app === undefined ? {} : { app }),
    ...(profile === undefined ? {} : { profile }),
    ...(options.dataMode === undefined ? {} : { dataMode: options.dataMode }),
    options: launcherOptions(options),
    hostArgs,
  }
}
