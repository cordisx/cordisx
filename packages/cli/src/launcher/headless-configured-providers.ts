import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

/** Merge the legacy operator selection with every admitted shared model service. */
export function headlessConfiguredProviders(
  environment: Readonly<Record<string, string | undefined>>,
  nativeModels: NativeModelProviderCatalogEntry['models'],
  declared: readonly NativeModelProviderCatalogEntry[] = [],
  nativeDefault?: string,
): readonly NativeModelProviderCatalogEntry[] | undefined {
  const primary = environment.CORDISX_HEADLESS_PROVIDER_ID, model = environment.CORDISX_HEADLESS_MODEL_ID
  const extra = environment.CORDISX_HEADLESS_EXTRA_PROVIDER, models = environment.CORDISX_HEADLESS_EXTRA_MODELS
  if (!primary && !model && !extra && !models) {
    if (declared.length === 0) return undefined
    return [
      ...(declared.some(provider => provider.providerId === 'openai') ? [] : [{
        providerId: 'openai',
        pluginId: 'codex',
        models: nativeModels,
        ...(nativeDefault === undefined ? {} : { defaultModelId: nativeDefault }),
      }]),
      ...declared,
    ]
  }
  const valid = (value: string | undefined): value is string =>
    !!value && value.length <= 512 && !/[\x00-\x1f\x7f,]/u.test(value)
  if (!valid(primary) || !valid(model) || (!!extra !== !!models) || extra && (!valid(extra) || extra === primary)) {
    throw new Error('HEADLESS_MODEL_CATALOG_INVALID')
  }
  const extraModels = models?.split(',') ?? []
  if (
    extraModels.length > 512 || extraModels.some(id => !valid(id)) || new Set(extraModels).size !== extraModels.length
  ) {
    throw new Error('HEADLESS_MODEL_CATALOG_INVALID')
  }
  const selected = (provider: string, id: string) =>
    (provider === 'openai' ? nativeModels.find(item => item.id === id) : undefined)
      ?? { id, label: id, aliases: [], supportsFastMode: false }
  const legacy: NativeModelProviderCatalogEntry[] = [
    { providerId: primary, pluginId: 'codex-config', models: [selected(primary, model)], defaultModelId: model },
    ...(extra
      ? [{
        providerId: extra,
        pluginId: 'codex-config',
        models: extraModels.map(id => selected(extra, id)),
        defaultModelId: extraModels[0]!,
      }]
      : []),
  ]
  return [
    ...legacy.map(provider => {
      const service = declared.find(item => item.providerId === provider.providerId)
      if (!service) return provider
      const models = new Map(provider.models.map(model => [
        model.id,
        service.models.find(item => item.id === model.id) ?? model,
      ]))
      for (const model of service.models) if (!models.has(model.id)) models.set(model.id, model)
      return {
        ...service,
        models: [...models.values()],
        ...(provider.defaultModelId === undefined ? {} : { defaultModelId: provider.defaultModelId }),
      }
    }),
    ...declared.filter(provider => !legacy.some(item => item.providerId === provider.providerId)),
  ]
}
