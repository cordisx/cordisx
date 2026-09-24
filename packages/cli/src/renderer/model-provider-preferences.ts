export interface PreferenceProviderModel {
  readonly id: string
}

export interface PreferenceProvider<Model extends PreferenceProviderModel = PreferenceProviderModel> {
  readonly providerId: string
  readonly pluginId: string
  readonly managementBindingRef?: string
  readonly models: readonly Model[]
  readonly defaultModelId?: string
}

export interface PreferenceManagementView {
  readonly bindingRef: string
  readonly providerId: string
  readonly sourceKind: 'native' | 'plugin' | 'auto' | 'manual' | 'script'
  readonly rows: readonly {
    readonly id: string
    readonly present: boolean
    readonly compatibility?: 'supported' | 'unsupported' | 'unknown'
    readonly selectable: boolean
  }[]
}

/** Intersects source membership with the Host projection; preferences never create source members. */
export function applyCatalogManagementPreferences<Provider extends PreferenceProvider>(
  providers: readonly Provider[],
  management?: { readonly views: readonly PreferenceManagementView[]; readonly connected?: boolean },
): readonly Provider[] {
  if (management === undefined) return providers
  const views = management.connected === false ? [] : management.views
  return Object.freeze(providers.map(provider => {
    const view = provider.managementBindingRef === undefined
      ? views.find(view => view.sourceKind !== 'plugin' && view.providerId === provider.providerId)
      : views.find(view => view.sourceKind === 'plugin' && view.bindingRef === provider.managementBindingRef)
    if (!view) {
      const { defaultModelId: _sourceDefaultModelId, ...sourceProvider } = provider
      return Object.freeze({ ...sourceProvider, models: Object.freeze([]) }) as unknown as Provider
    }
    const source = new Map(provider.models.map(model => [model.id, model]))
    const models = view.rows.flatMap(row => {
      if (!row.present || row.compatibility !== 'supported' || !row.selectable) return []
      const model = source.get(row.id)
      return model === undefined ? [] : [model]
    })
    const defaultModelId = provider.defaultModelId !== undefined && models.some(model =>
        model.id === provider.defaultModelId
      )
      ? provider.defaultModelId
      : undefined
    const { defaultModelId: _sourceDefaultModelId, ...sourceProvider } = provider
    return Object.freeze({
      ...sourceProvider,
      models: Object.freeze(models),
      ...(defaultModelId === undefined ? {} : { defaultModelId }),
    }) as unknown as Provider
  }))
}
