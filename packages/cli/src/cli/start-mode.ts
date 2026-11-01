import { CordisXCliParseError } from './parse-error.js'

/** Mode is a launch choice, never an app-server or supervisor action. */
export function normalizeStartMode(argv: readonly string[]): readonly string[] {
  const boundary = argv.indexOf('--')
  const head = [...(boundary < 0 ? argv : argv.slice(0, boundary))]
  const tail = boundary < 0 ? [] : argv.slice(boundary)
  let mode: string | undefined
  for (let i = 0; i < head.length; i++) {
    const token = head[i]!
    if (token !== '--mode' && !token.startsWith('--mode=')) continue
    if (mode !== undefined) throw new CordisXCliParseError('duplicate-option', '--mode may only be specified once')
    const inline = token.startsWith('--mode=')
    mode = inline ? token.slice(7) : head[i + 1]
    if (mode !== 'app' && mode !== 'cli') {
      throw new CordisXCliParseError('invalid-option-value', '--mode must be app or cli')
    }
    head.splice(i, inline ? 1 : 2)
    i--
  }
  if (mode === undefined) return argv
  if (head[0] !== 'start') {
    throw new CordisXCliParseError('unsupported-option', '--mode is only valid with cordisx start')
  }
  return [...(mode === 'cli' ? ['cli', ...head.slice(1)] : head), ...tail]
}
