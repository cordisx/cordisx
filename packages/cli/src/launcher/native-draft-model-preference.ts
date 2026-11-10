import type { NativeProviderSelection } from '../renderer/native-provider-submission-policy.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

export type NativeDraftModelPreferenceValue = Readonly<{ providerId: string; model?: string; generation: number }>

/** Launch-scoped user preference; catalog membership is rechecked for each new draft. */
export class NativeDraftModelPreference {
  private remembered: NativeProviderSelection | undefined
  private nextGeneration = 1
  private nextSelectionOrder = 1
  private rememberedOrder = 0

  constructor(
    private readonly options: Readonly<{
      catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
      defaultProviderId?: string
      defaultModelId?: string
      isStartupProvider?(providerId: string): boolean
    }>,
  ) {}

  beginSelection(): number {
    return this.nextSelectionOrder++
  }

  remember(selection: NativeProviderSelection, order = this.beginSelection()): void {
    if (order < this.rememberedOrder) return
    this.rememberedOrder = order
    this.remembered = Object.freeze({ ...selection })
  }

  async read(): Promise<NativeDraftModelPreferenceValue | undefined> {
    if (this.remembered === undefined && this.options.defaultProviderId === undefined) return undefined
    let catalog: readonly NativeModelProviderCatalogEntry[]
    try {
      catalog = await this.options.catalog()
    } catch {
      catalog = []
    }
    // Read the latest explicit choice after the catalog await, so an older read
    // cannot restore the model that the user has just replaced.
    const remembered = this.remembered
    const { defaultProviderId, defaultModelId } = this.options
    const candidates = [
      ...new Set([remembered?.providerId, defaultProviderId].filter(
        (candidate): candidate is string => candidate !== undefined,
      )),
    ]
    const explicitStartupModel = defaultProviderId !== undefined && defaultModelId !== undefined
      && this.options.isStartupProvider?.(defaultProviderId) === true
    const providerId = candidates.find(candidate =>
      candidate === 'openai'
      || explicitStartupModel && candidate === defaultProviderId
      || catalog.some(provider => provider.providerId === candidate && provider.models.length > 0)
    )
    if (providerId === undefined) return undefined

    const entry = catalog.find(provider => provider.providerId === providerId)
    let model: string | undefined
    if (remembered?.providerId === providerId) {
      if (
        providerId === 'openai' || entry?.models.some(candidate => candidate.id === remembered.model)
        || explicitStartupModel && providerId === defaultProviderId && (!entry || entry.models.length === 0)
      ) model = remembered.model
    } else if (
      providerId === defaultProviderId && defaultModelId !== undefined
      && (explicitStartupModel || entry?.models.some(candidate => candidate.id === defaultModelId))
    ) model = defaultModelId
    return Object.freeze({ providerId, generation: this.nextGeneration++, ...(model === undefined ? {} : { model }) })
  }
}
