import { createHash } from 'node:crypto'
import { NATIVE_OPERATION_REQUEST_TRANSFORM } from '../renderer/adapter/native-operation-request-transform.js'
import { NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM } from '../renderer/adapter/native-submit-orchestrator-transform.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'

/** Preserve the older two-stage structure only when its complete audited bytes still match. */
export function legacyNativeSubmissionResources(
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] | undefined {
  const recipes = [NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM, NATIVE_OPERATION_REQUEST_TRANSFORM]
  const selected: NativeResourceTransform[] = []
  for (const recipe of recipes) {
    const matches = resources.filter(resource =>
      createHash('sha256').update(resource.source).digest('hex') === recipe.sha256
    )
    if (matches.length !== 1) return undefined
    const resource = matches[0]!
    recipe.transform(resource.source)
    selected.push(Object.freeze({ ...recipe, url: resource.url }))
  }
  return selected
}
