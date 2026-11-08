export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue
}

export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function jsonValue(value: unknown, label: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`)
    return value
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, seen))
    }
    const source = value as Record<string, unknown>
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, entry] of Object.entries(source)) {
      result[key] = jsonValue(entry, `${label}.${key}`, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function parseManagedServiceStartupConfig(
  value: unknown,
  label: string,
): Readonly<Record<string, JsonValue>> {
  const entries = Object.entries(record(value, label))
  const result: Record<string, JsonValue> = Object.create(null)
  for (const [pluginId, config] of entries) {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`${label} has an invalid plugin id`)
    if (Object.keys(record(config, label)).length === 0) {
      throw new Error(`${label} requires a nonempty configuration object per plugin`)
    }
    result[pluginId] = jsonValue(config, label)
  }
  return result
}
