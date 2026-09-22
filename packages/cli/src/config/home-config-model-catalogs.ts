/** Host-only model membership; never an endpoint, authentication or native-profile override. */
export function parseDefaultModelProvider(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}.defaultModelProvider is invalid`)
  }
  return value.trim()
}

export function parseConfigModelCatalogs(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('configModelCatalogs must be a provider-to-local-path object')
  }
  const entries = Object.entries(value)
  if (entries.length > 128) throw new Error('configModelCatalogs has too many providers')
  const result: Record<string, string> = Object.create(null)
  for (const [id, file] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || id === 'openai') {
      throw new Error('configModelCatalogs has an invalid or reserved provider ID')
    }
    if (
      typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\0\r\n]/u.test(file)
      || /^[a-z][a-z0-9+.-]*:\/\//iu.test(file)
    ) {
      throw new Error('configModelCatalogs requires bounded local file paths')
    }
    result[id] = file
  }
  return Object.freeze(result)
}

export function parseProfileModelOptions(profile: Record<string, unknown>, label: string) {
  const defaultModelProvider = parseDefaultModelProvider(profile.defaultModelProvider, label)
  const configModelCatalogs = parseConfigModelCatalogs(profile.configModelCatalogs)
  return {
    ...(defaultModelProvider === undefined ? {} : { defaultModelProvider }),
    ...(configModelCatalogs === undefined ? {} : { configModelCatalogs }),
  }
}
