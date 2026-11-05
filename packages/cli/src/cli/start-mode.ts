import { CordisXCliParseError } from './parse-error.js'

/** Mode is a launch choice, never an app-server or supervisor action. */
export function normalizeStartMode(argv: readonly string[]): { argv: readonly string[]; service?: true } {
  const boundary = argv.indexOf('--')
  const head = [...(boundary < 0 ? argv : argv.slice(0, boundary))]
  const tail = boundary < 0 ? [] : argv.slice(boundary)
  let mode: string | undefined
  for (let i = 0; i < head.length; i++) {
    const token = head[i]!
    if (token !== '--mode' && token !== '-M' && !token.startsWith('--mode=') && !token.startsWith('-M=')) continue
    if (mode !== undefined) throw new CordisXCliParseError('duplicate-option', '--mode may only be specified once')
    const inline = token.includes('=')
    mode = inline ? token.slice(token.indexOf('=') + 1) : head[i + 1]
    if (mode !== 'app' && mode !== 'cli' && mode !== 'service') {
      throw new CordisXCliParseError('invalid-option-value', '--mode must be app, cli, or service')
    }
    head.splice(i, inline ? 1 : 2)
    i--
  }
  if (mode === undefined) return { argv }
  if (mode === 'service' && ['start', 'status', 'logs', 'stop', 'restart'].includes(head[0] ?? '')) {
    return { argv: [...head, ...tail], service: true }
  }
  if (head[0] !== 'start' || mode === 'service') {
    throw new CordisXCliParseError(
      'unsupported-option',
      '--mode requires start, or a service lifecycle command with --mode service',
    )
  }
  return { argv: [...(mode === 'cli' ? ['cli', ...head.slice(1)] : head), ...tail] }
}
