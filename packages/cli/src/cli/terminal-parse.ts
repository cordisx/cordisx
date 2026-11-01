import { CordisXCliParseError } from './parse-error.js'

export interface TerminalInvocation {
  readonly action: 'terminal'
  readonly client?: 'codex' | 'claude-code'
  readonly help: boolean
  readonly list: boolean
  readonly profile?: string
  readonly service?: string
  readonly model?: string
  readonly instructionsFile?: string
  readonly executable?: string
  readonly codexArgs: readonly string[]
}
export const TERMINAL_HELP = `Usage:
  cordisx start --mode cli [codex|claude-code] [-s SERVICE -m MODEL] [-- client-arguments...]
  cordisx cli --list [--profile ID]
  cordisx cli --service PROVIDER --model MODEL [options] [-- codex-arguments...]
  cordisx cli [--instructions-file PATH] [-- codex-arguments...]

Options:
  --profile ID             Existing CordisX Codex profile
  -s, --service PROVIDER   Shared model service or live plugin provider ID
  -m, --model MODEL       Exact model ID for the selected service
  --instructions-file PATH Replace Codex built-in instructions for this invocation
  --codex-executable PATH  Codex CLI executable (default: codex on PATH)
  --executable PATH        Selected CLI executable (Claude Code defaults to claude on PATH)
  --list                   Print the live services/models as JSON; starts no CLI/App
  -h, --help               Show this help

The original Codex or Claude Code terminal UI runs with inherited stdio.
Arguments after -- belong to Codex, including exec/resume/fork and native
provider configuration. --profile above selects CordisX; Codex --profile goes
after --. A selected CordisX service/model cannot be overridden after --.
Plugin and Manager-managed services reuse the existing Host and login; no App
is started, stopped or restarted. Shared model-service declarations work without
a running Host. Protocol and model compatibility are checked before startup.
No global Codex config is rewritten. Instructions apply only to this invocation;
changing an already-loaded thread remains dependent on the Codex CLI version.`

export function parseTerminalCli(argv: readonly string[]): TerminalInvocation {
  const boundary = argv.indexOf('--')
  const options = boundary < 0 ? argv.slice(1) : argv.slice(1, boundary)
  const codexArgs = boundary < 0 ? [] : argv.slice(boundary + 1)
  const flags = new Set(['--list', '--help', '-h'])
  const values = new Set(['--profile', '--service', '--model', '--instructions-file', '--codex-executable'])
  const aliases = new Map([['-s', '--service'], ['-m', '--model'], ['--executable', '--codex-executable']])
  const positionals: string[] = []
  const seen = new Map<string, string>()
  for (let i = 0; i < options.length; i++) {
    const token = options[i]!
    const equal = token.indexOf('=')
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const rawKey = equal < 0 ? token : token.slice(0, equal)
    const key = aliases.get(rawKey) ?? rawKey
    if (!flags.has(key) && !values.has(key)) {
      throw new CordisXCliParseError('unknown-option', `Unknown CLI option ${key}; pass Codex arguments after --`)
    }
    if (seen.has(key)) throw new CordisXCliParseError('duplicate-option', `${key} may only be specified once`)
    if (flags.has(key)) {
      if (equal >= 0) throw new CordisXCliParseError('invalid-option-value', `${key} accepts no value`)
      seen.set(key, '')
      continue
    }
    const value = equal < 0 ? options[++i] : token.slice(equal + 1)
    if (!value || value.startsWith('-') || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new CordisXCliParseError('invalid-option-value', `${key} requires a valid value`)
    }
    seen.set(key, value)
  }
  const profile = seen.get('--profile'), service = seen.get('--service'), model = seen.get('--model')
  const instructionsFile = seen.get('--instructions-file'), executable = seen.get('--codex-executable')
  const help = seen.has('--help') || seen.has('-h'), list = seen.has('--list')
  const client = positionals[0] ?? 'codex'
  if (!['codex', 'claude-code'].includes(client) || positionals.length > 1) {
    throw new CordisXCliParseError(
      'unexpected-positional',
      'CLI client must be codex or claude-code; use --profile for CordisX profile',
    )
  }
  if (profile !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile)) {
    throw new CordisXCliParseError('invalid-option-value', 'Invalid CordisX profile ID')
  }
  if (!help && (service === undefined) !== (model === undefined)) {
    throw new CordisXCliParseError('conflicting-options', '--service and --model must be selected together')
  }
  if (list && (service || model || instructionsFile || executable || codexArgs.length)) {
    throw new CordisXCliParseError('conflicting-options', '--list accepts only --profile')
  }
  return {
    action: 'terminal',
    help,
    list,
    codexArgs,
    ...(client === 'codex' ? {} : { client: 'claude-code' as const }),
    ...(profile === undefined ? {} : { profile }),
    ...(service === undefined ? {} : { service }),
    ...(model === undefined ? {} : { model }),
    ...(instructionsFile === undefined ? {} : { instructionsFile }),
    ...(executable === undefined ? {} : { executable }),
  }
}
