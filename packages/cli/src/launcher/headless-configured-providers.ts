/** Explicit operator-provided catalog for a headless backend with external providers. */
export function headlessConfiguredProviders(
  environment: Readonly<Record<string, string | undefined>>,
  nativeModels: readonly { id: string; label: string; aliases: string[]; supportsFastMode: boolean }[],
) {
  const primary = environment.CORDISX_HEADLESS_PROVIDER_ID, model = environment.CORDISX_HEADLESS_MODEL_ID
  const extra = environment.CORDISX_HEADLESS_EXTRA_PROVIDER, models = environment.CORDISX_HEADLESS_EXTRA_MODELS
  if (!primary && !model && !extra && !models) return undefined
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
  return [
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
}
