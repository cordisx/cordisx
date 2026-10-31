import { CordisXCliParseError } from './parse-error.js'

export interface TerminalInvocation {
  readonly action: 'terminal'
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
  cordisx cli --list [--profile ID]
  cordisx cli --service PROVIDER --model MODEL [options] [-- codex-arguments...]
  cordisx cli [--instructions-file PATH] [-- codex-arguments...]

Options:
  --profile ID             Existing CordisX Codex profile
  --service PROVIDER       Exact provider ID from --list (requires a live compatible Host)
  --model MODEL            Exact model ID for the selected service
  --instructions-file PATH Replace Codex built-in instructions for this invocation
  --codex-executable PATH  Codex CLI executable (default: codex on PATH)
  --list                   Print the live services/models as JSON; starts no CLI/App
  -h, --help               Show this help

The original Codex terminal UI and commands run with inherited stdio.
Arguments after -- belong to Codex, including exec/resume/fork and native
provider configuration. --profile above selects CordisX; Codex --profile goes
after --. A selected CordisX service/model cannot be overridden after --.
Plugin and Manager-managed services reuse the existing Host and login; no App
is started, stopped or restarted. The Host must remain running. Ordinary Codex
providers work without a Host when --service/--list are omitted.
No global Codex config is rewritten. Instructions apply only to this invocation;
changing an already-loaded thread remains dependent on the Codex CLI version.`

export function parseTerminalCli(argv: readonly string[]): TerminalInvocation {
  const boundary = argv.indexOf('--')
  const options = boundary < 0 ? argv.slice(1) : argv.slice(1, boundary)
  const codexArgs = boundary < 0 ? [] : argv.slice(boundary + 1)
  const flags = new Set(['--list', '--help', '-h'])
  const values = new Set(['--profile', '--service', '--model', '--instructions-file', '--codex-executable'])
  const seen = new Map<string, string>()
  for (let i = 0; i < options.length; i++) {
    const token = options[i]!
    const equal = token.indexOf('=')
    const key = equal < 0 ? token : token.slice(0, equal)
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
    ...(profile === undefined ? {} : { profile }),
    ...(service === undefined ? {} : { service }),
    ...(model === undefined ? {} : { model }),
    ...(instructionsFile === undefined ? {} : { instructionsFile }),
    ...(executable === undefined ? {} : { executable }),
  }
}
