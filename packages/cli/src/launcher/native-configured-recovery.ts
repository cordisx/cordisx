export type ConfiguredProviderPreparation = (
  providerId?: string,
  nativeAccount?: unknown,
) => Promise<Readonly<Record<string, unknown>>>

/** Preserve the existing single-argument call when no native account is supplied. */
export async function callConfiguredProvider(
  prepare: ConfiguredProviderPreparation | undefined,
  value: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const providerId = typeof value.providerId === 'string' ? value.providerId : undefined
  return value.nativeAccount === undefined
    ? await prepare?.(providerId) ?? {}
    : await prepare?.(providerId, value.nativeAccount) ?? {}
}
