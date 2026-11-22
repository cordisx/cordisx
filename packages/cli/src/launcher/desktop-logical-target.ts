import type { ModelReasoningEffort } from '../model-reasoning-capabilities.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { nativeTaskSelectionAllowed } from './native-agent-task-effort.js'

/** A target model and any explicit effort must remain admitted at each migration preflight. */
export function desktopLogicalTargetAdmission(
  sources: {
    source(providerId: string): string | undefined
    validate(selection: { providerId: string; model: string }): Promise<boolean>
  },
  catalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>,
) {
  return async (providerId: string, model: string, effort?: ModelReasoningEffort): Promise<boolean> => {
    if (sources.source(providerId) === 'remote' || !await sources.validate({ providerId, model })) return false
    return effort === undefined || nativeTaskSelectionAllowed(await catalog(), {
      providerId,
      model,
      reasoningEffort: effort,
      reasoningExplicit: true,
    })
  }
}
