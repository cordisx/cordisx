import { fixedNativeTransform } from './fixed-transform.js'
import { createHash } from 'node:crypto'
import { NATIVE_OPERATION_REQUEST_TRANSFORM } from './native-operation-request-transform.js'
import { NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM } from './native-submit-orchestrator-transform.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeResourceTransform } from './contracts.js'

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
    const transform = fixedNativeTransform({ ...recipe, url: resource.url })
    transform.transform(resource.source)
    selected.push(transform)
  }
  return selected
}
