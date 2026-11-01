import { CordisXCliParseError } from './parse-error.js'

export interface ModelExportRequest {
  readonly list: boolean
  readonly all: boolean
  readonly services: readonly string[]
  readonly modelIds: readonly string[]
  readonly includeValues?: boolean
  readonly expectedVariables?: readonly string[]
}
export interface ModelExportInvocation extends ModelExportRequest {
  readonly action: 'model-export'
  readonly help: boolean
  readonly profile?: string
  readonly output?: string
  readonly force: boolean
}

export const MODEL_EXPORT_HELP = `Usage:
  cordisx model export --list [--profile ID]
  cordisx model export --all [--profile ID] [--output PATH|-]
  cordisx model export --service ID [--service ID...] [--model ID...] [options]

Options:
  --profile ID        Existing Codex profile (default: configured default)
  --list              Print service binding IDs and exact model IDs as JSON
  --all               Export the complete current catalog; rejects nonportable services
  --service ID        Binding ID or unambiguous provider ID from --list (repeatable)
  --model ID          Exact model ID (repeatable; requires exactly one --service)
  --include-values    Choose A: saved, enabled, referenced user values; UNENCRYPTED
  --exclude-values    Choose B: omit values; complete them on the target
  --output PATH|-     Private atomic file, or portable text on stdout (default: -)
  --force             Replace an existing regular output file
  -h, --help          Show this help

With variable dependencies and no explicit value flag, interactive terminals ask A/B
before any final output. Noninteractive/AI calls return choice-required on stderr,
write no output/file, and require --include-values or --exclude-values after a choice.
Without an active compatible runtime, only explicit codex-config: service selections
are exportable offline. --list then describes an incomplete, config-only inventory.
Plugin-managed services such as Aiden/TraeX cannot be transferred: install their
plugin and log in on the target machine. No CLI import command is provided.
Copy the output into the target Manager > Model services > Import. Complete missing
variables there, then check the imported services and exact model list.`

export function parseModelExport(argv: readonly string[]): ModelExportInvocation {
  if (argv[1] === '--help' || argv[1] === '-h' || argv[1] === 'help') {
    return {
      action: 'model-export',
      help: true,
      list: false,
      all: false,
      services: [],
      modelIds: [],
      force: false,
    }
  }
  if (argv[1] !== 'export') {
    throw new CordisXCliParseError('unexpected-positional', 'model requires export; use model export --help')
  }
  const flags = new Set(['--list', '--all', '--include-values', '--exclude-values', '--force', '--help', '-h'])
  const values = new Set(['--profile', '--output', '--service', '--model'])
  const seen = new Map<string, string[]>()
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!
    const equal = token.indexOf('=')
    const key = equal < 0 ? token : token.slice(0, equal)
    if (!flags.has(key) && !values.has(key)) {
      throw new CordisXCliParseError('unknown-option', `unknown model export option: ${key}`)
    }
    if (seen.has(key) && key !== '--service' && key !== '--model') {
      throw new CordisXCliParseError('duplicate-option', `${key} may only be specified once`)
    }
    let value = ''
    if (flags.has(key)) {
      if (equal >= 0) throw new CordisXCliParseError('invalid-option-value', `${key} does not accept a value`)
    } else {
      value = equal < 0 ? argv[++i] ?? '' : token.slice(equal + 1)
      if (!value || equal < 0 && value.startsWith('-') && !(key === '--output' && value === '-')) {
        throw new CordisXCliParseError('missing-option-value', `${key} requires a value`)
      }
      if (value.length > 4096 || /[\0\r\n]/u.test(value)) {
        throw new CordisXCliParseError('invalid-option-value', `${key} value is invalid`)
      }
    }
    seen.set(key, [...seen.get(key) ?? [], value])
  }
  const help = seen.has('--help') || seen.has('-h')
  const list = seen.has('--list'), all = seen.has('--all')
  const services = seen.get('--service') ?? [], modelIds = seen.get('--model') ?? []
  const profile = seen.get('--profile')?.[0], output = seen.get('--output')?.[0]
  if (profile !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile)) {
    throw new CordisXCliParseError('invalid-option-value', 'invalid profile ID')
  }
  if (
    !help
    && (Number(list) + Number(all) + Number(services.length > 0) !== 1 || modelIds.length > 0 && services.length !== 1)
  ) {
    throw new CordisXCliParseError(
      'conflicting-options',
      'choose --list, --all, or --service; --model requires exactly one --service',
    )
  }
  if (
    list
    && (output !== undefined || seen.has('--include-values') || seen.has('--exclude-values') || seen.has('--force')
      || modelIds.length > 0)
  ) {
    throw new CordisXCliParseError('conflicting-options', '--list accepts only --profile')
  }
  if (seen.has('--include-values') && seen.has('--exclude-values')) {
    throw new CordisXCliParseError('conflicting-options', '--include-values and --exclude-values cannot be combined')
  }
  if (seen.has('--force') && (output === undefined || output === '-')) {
    throw new CordisXCliParseError('conflicting-options', '--force requires an output file')
  }
  if (new Set(services).size !== services.length || new Set(modelIds).size !== modelIds.length) {
    throw new CordisXCliParseError('duplicate-option', 'service and model IDs must be unique')
  }
  return {
    action: 'model-export',
    help,
    list,
    all,
    services,
    modelIds,
    ...(seen.has('--include-values') || seen.has('--exclude-values')
      ? { includeValues: seen.has('--include-values') }
      : {}),
    force: seen.has('--force'),
    ...(profile === undefined ? {} : { profile }),
    ...(output === undefined ? {} : { output }),
  }
}
