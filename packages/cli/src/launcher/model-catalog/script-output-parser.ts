import { safeScriptText, validateScriptOutput } from './script-schema.js'
import { type ScriptMode, type ScriptModel, ScriptSourceError } from './script-types.js'

/** JSON.parse supplies grammar validation; the token pass rejects ambiguous duplicate property names. */
function rejectDuplicateKeys(source: string): void {
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/gsu) ?? []
  const stack: (Set<string> | undefined)[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : undefined)
      if (stack.length > 16) throw new ScriptSourceError('script-output-invalid')
    } else if (token === '}' || token === ']') stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1)
      const key = JSON.parse(token) as string
      if (!keys || keys.has(key)) throw new ScriptSourceError('script-output-invalid')
      keys.add(key)
    }
  }
}

export function parseScriptOutput(bytes: Uint8Array, mode: ScriptMode, maxModels = 1000): readonly ScriptModel[] {
  try {
    if (bytes.byteLength > 1_048_576 || !Number.isSafeInteger(maxModels) || maxModels < 1 || maxModels > 1000) {
      throw new ScriptSourceError('script-budget-exceeded')
    }
    // Fatal decoding rejects invalid UTF-8 instead of silently changing exact IDs.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    rejectDuplicateKeys(text)
    if (!validateScriptOutput(value)) throw new ScriptSourceError('script-output-invalid')
    const models = (value as { models: { id: string; label?: string }[] }).models
    if (models.length > maxModels) throw new ScriptSourceError('script-budget-exceeded')
    const seen = new Set<string>()
    return Object.freeze(models.flatMap(model => {
      if (!safeScriptText(model.id, 512) || (model.label !== undefined && !safeScriptText(model.label, 256))) {
        throw new ScriptSourceError('script-output-invalid')
      }
      if (seen.has(model.id)) return []
      seen.add(model.id)
      return [Object.freeze({
        id: model.id,
        label: model.label ?? model.id,
        aliases: Object.freeze([]),
        provenance: Object.freeze([mode === 'replace' ? 'script' : 'script-supplement'] as const),
      })]
    }))
  } catch (error) {
    throw error instanceof ScriptSourceError ? error : new ScriptSourceError('script-output-invalid')
  }
}
