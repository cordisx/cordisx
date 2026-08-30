import type { CordisXConfigFormSchemaNode, CordisXJsonValue } from '../contracts.js'

function clone<T>(value: T): T {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T
}

function objectValue(value: CordisXJsonValue | undefined): value is Record<string, CordisXJsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Applies nested field defaults first, then overlays an explicit parent object default. */
function mergeDefault(fallback: CordisXJsonValue, override: CordisXJsonValue): CordisXJsonValue {
  if (!objectValue(fallback) || !objectValue(override)) return clone(override)
  const result: Record<string, CordisXJsonValue> = clone(fallback)
  for (const [key, value] of Object.entries(override)) {
    result[key] = Object.hasOwn(result, key) ? mergeDefault(result[key]!, value) : clone(value)
  }
  return result
}

/** Resolves the JSON draft default represented by a projected Host form schema. */
export function formSchemaDefaultValue(schema: CordisXConfigFormSchemaNode): CordisXJsonValue | undefined {
  if (schema.type === 'array') {
    if (schema.hasDefault !== true || schema.defaultValue === undefined) return undefined
    if (!Array.isArray(schema.defaultValue) || schema.item === undefined) return clone(schema.defaultValue)
    const itemDefault = formSchemaDefaultValue(schema.item)
    return itemDefault === undefined
      ? clone(schema.defaultValue)
      : schema.defaultValue.map(item => mergeDefault(itemDefault, item))
  }
  if (schema.type !== 'object') {
    return schema.hasDefault === true && schema.defaultValue !== undefined
      ? clone(schema.defaultValue)
      : undefined
  }
  let result: CordisXJsonValue | undefined
  for (const child of schema.fields ?? []) {
    const value = formSchemaDefaultValue(child.schema)
    if (value === undefined) continue
    const childDefaults: CordisXJsonValue = { [child.key]: value }
    result = result === undefined ? childDefaults : mergeDefault(result, childDefaults)
  }
  if (schema.hasDefault === true && schema.defaultValue !== undefined) {
    result = result === undefined ? clone(schema.defaultValue) : mergeDefault(result, schema.defaultValue)
  }
  return result
}
