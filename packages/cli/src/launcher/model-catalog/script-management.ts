import type { ScriptSourceRuntime } from './script-runtime.js'
import { safeScriptText } from './script-schema.js'
import { type ScriptIntent, ScriptSourceError } from './script-types.js'

/** Only install in the trusted Provider settings channel, never plugin/read-only catalog channels. */
export function createScriptManagementHandler(
  runtime: ScriptSourceRuntime,
  admit: (bindingRef: string, action: 'read' | 'run' | 'cancel') => boolean,
) {
  return async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScriptSourceError('script-scope-invalid')
    const input = value as Record<string, unknown>
    const kind = input.kind
    const keys = ['kind', 'bindingRef', 'scopeRevision', 'expectedRevision']
    if (
      !['read', 'run', 'cancel'].includes(String(kind)) || Object.keys(input).length !== keys.length
      || keys.some(key =>
        !Object.hasOwn(input, key) || (key !== 'expectedRevision' && !safeScriptText(input[key], 512))
      )
      || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
      || Object.keys(input).some(key => !keys.includes(key))
      || !admit(input.bindingRef as string, kind as 'read' | 'run' | 'cancel')
    ) throw new ScriptSourceError('script-scope-invalid')
    const intent = input as unknown as ScriptIntent
    if (kind === 'run') return runtime.run(intent)
    if (kind === 'cancel') return runtime.cancel(intent)
    const snapshot = runtime.readStatus(intent.bindingRef)
    if (!snapshot || snapshot.scopeRevision !== intent.scopeRevision) {
      throw new ScriptSourceError('script-scope-invalid')
    }
    return snapshot
  }
}
