export interface HomeConfigEnvironmentVariable {
  readonly name: string
  readonly value: string
  readonly enabled: boolean
  readonly description?: string
  readonly generator?: HomeConfigEnvironmentGenerator
}

export interface HomeConfigEnvironmentGenerator {
  readonly kind: 'shell'
  readonly script: string
}

export const HOME_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u

export function parseHomeConfigEnvironmentVariables(value: unknown): readonly HomeConfigEnvironmentVariable[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error('config.environmentVariables must be an array')
  if ((value?.length ?? 0) > 128) throw new Error('config.environmentVariables must contain at most 128 entries')
  const names = new Set<string>()
  return Object.freeze((value ?? []).map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`config.environmentVariables[${index}] must be an object`)
    }
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).some(key => !['name', 'value', 'enabled', 'description', 'generator'].includes(key))) {
      throw new Error(`config.environmentVariables[${index}] contains unknown fields`)
    }
    if (typeof entry.name !== 'string' || !HOME_ENVIRONMENT_NAME.test(entry.name) || names.has(entry.name)) {
      throw new Error(`config.environmentVariables[${index}].name is invalid or duplicated`)
    }
    if (typeof entry.value !== 'string' || entry.value.length > 16_384 || entry.value.includes('\0')) {
      throw new Error(`config.environmentVariables[${index}].value is invalid`)
    }
    if (typeof entry.enabled !== 'boolean') {
      throw new Error(`config.environmentVariables[${index}].enabled must be boolean`)
    }
    if (
      entry.description !== undefined
      && (typeof entry.description !== 'string' || entry.description.length > 512 || entry.description.includes('\0'))
    ) throw new Error(`config.environmentVariables[${index}].description is invalid`)
    const generator = entry.generator
    if (
      generator !== undefined
      && (generator === null || typeof generator !== 'object' || Array.isArray(generator)
        || Object.keys(generator).sort().join(',') !== 'kind,script'
        || (generator as Record<string, unknown>).kind !== 'shell'
        || typeof (generator as Record<string, unknown>).script !== 'string'
        || ((generator as Record<string, unknown>).script as string).length > 16_384
        || ((generator as Record<string, unknown>).script as string).includes('\0'))
    ) throw new Error(`config.environmentVariables[${index}].generator is invalid`)
    names.add(entry.name)
    return Object.freeze({
      name: entry.name,
      value: entry.value,
      enabled: entry.enabled,
      ...(entry.description === undefined || entry.description === '' ? {} : { description: entry.description }),
      ...(generator === undefined
        ? {}
        : { generator: Object.freeze({ kind: 'shell' as const, script: (generator as { script: string }).script }) }),
    })
  }))
}

export function enabledHomeEnvironment(
  entries: readonly HomeConfigEnvironmentVariable[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(entries.filter(entry => entry.enabled).map(entry => [entry.name, entry.value])),
  )
}

export function mergeHomeEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  entries: readonly HomeConfigEnvironmentVariable[],
  overrides?: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  const environment = { ...base, ...(overrides ?? {}) }
  for (const entry of entries) {
    if (entry.enabled) environment[entry.name] = entry.value
    else environment[entry.name] = undefined
  }
  return Object.freeze(environment)
}
