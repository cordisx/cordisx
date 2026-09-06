import type { CordisXConfigFieldPath, CordisXStandardSchema } from '../../contracts.js'
import type { SchemaNode } from './model.js'

const RESERVED_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

function isReservedConfigRole(role: string): boolean {
  return RESERVED_ROLES.has(role)
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen)
  return Object.freeze(value)
}

function immutable<T>(value: T): T {
  return freeze(clone(value))
}

function ownValue(value: unknown, path: CordisXConfigFieldPath): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function pathStartsWith(path: CordisXConfigFieldPath, prefix: CordisXConfigFieldPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}

function assertPath(path: CordisXConfigFieldPath): void {
  if (!Array.isArray(path) || path.length === 0 || path.length > 32) {
    throw new Error('config field path must contain 1 to 32 segments')
  }
  for (const segment of path) {
    if (
      typeof segment !== 'string' || segment.length === 0 || segment.length > 128
      || ['__proto__', 'prototype', 'constructor'].includes(segment)
    ) {
      throw new Error(`invalid config field path segment: ${segment}`)
    }
  }
}

function setAtPath(input: unknown, path: CordisXConfigFieldPath, value: unknown, unset: boolean): unknown {
  const root = clone(input)
  if (root === null || typeof root !== 'object') throw new Error('config mutation requires an object or array root')
  let current = root as Record<PropertyKey, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!
    const next = current[segment]
    if (next === null || typeof next !== 'object') current[segment] = {}
    current = current[segment] as Record<PropertyKey, unknown>
  }
  const last = path[path.length - 1]!
  if (unset) {
    delete current[last]
  } else {
    current[last] = clone(value)
  }
  return root
}

function sensitiveNodes(
  schema: SchemaNode | undefined,
  path: CordisXConfigFieldPath = [],
): { readonly path: CordisXConfigFieldPath; readonly node: SchemaNode }[] {
  if (schema === undefined) return []
  if (schema.meta?.role !== undefined && isReservedConfigRole(schema.meta.role)) return [{ path, node: schema }]
  if (schema.type === 'lazy') {
    throw new Error(`cannot prove secret positions in unresolved lazy Schemastery field ${path.join('.') || '<root>'}`)
  }
  if (schema.type === 'object' && schema.dict !== undefined) {
    return Object.entries(schema.dict).flatMap(([key, child]) => sensitiveNodes(child, [...path, key]))
  }
  return [
    ...(schema.inner === undefined ? [] : sensitiveNodes(schema.inner, path)),
    ...(schema.list ?? []).flatMap(child => sensitiveNodes(child, path)),
  ]
}

function jsonCompatible(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => jsonCompatible(entry, `${label}[${index}]`, seen))
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be a plain JSON object`)
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      jsonCompatible(entry, `${label}.${key}`, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function sensitiveDefaultPath(
  schema: SchemaNode,
  value: unknown,
  path: CordisXConfigFieldPath = [],
): CordisXConfigFieldPath | undefined {
  if (schema.meta?.role !== undefined && isReservedConfigRole(schema.meta.role)) return path
  if (
    schema.type === 'object' && schema.dict !== undefined && value !== null && typeof value === 'object'
    && !Array.isArray(value)
  ) {
    for (const [key, child] of Object.entries(schema.dict)) {
      if (!Object.hasOwn(value, key)) continue
      const nested = sensitiveDefaultPath(child, (value as Record<string, unknown>)[key], [...path, key])
      if (nested !== undefined) return nested
    }
  }
  if (schema.type === 'array' && schema.inner !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = sensitiveDefaultPath(schema.inner, item, [...path, String(index)])
      if (nested !== undefined) return nested
    }
  } else if (schema.inner !== undefined) {
    const nested = sensitiveDefaultPath(schema.inner, value, path)
    if (nested !== undefined) return nested
  }
  for (const child of schema.list ?? []) {
    const nested = sensitiveDefaultPath(child, value, path)
    if (nested !== undefined) return nested
  }
  return undefined
}

function validateSchemaDefaults(
  schema: SchemaNode | undefined,
  path: CordisXConfigFieldPath = [],
  seen = new Set<SchemaNode>(),
): void {
  if (schema === undefined || seen.has(schema)) return
  seen.add(schema)
  if (Object.hasOwn(schema.meta ?? {}, 'default')) {
    const value = schema.meta?.default
    jsonCompatible(value, `config schema default ${path.join('.') || '<root>'}`)
    const sensitivePath = sensitiveDefaultPath(schema, value)
    if (sensitivePath !== undefined) {
      throw new Error(
        `secret config field ${[...path, ...sensitivePath].join('.') || '<root>'} must not declare a JSON default`,
      )
    }
  }
  if (schema.type === 'object' && schema.dict !== undefined) {
    for (const [key, child] of Object.entries(schema.dict)) validateSchemaDefaults(child, [...path, key], seen)
  }
  if (schema.inner !== undefined) validateSchemaDefaults(schema.inner, path, seen)
  for (const child of schema.list ?? []) validateSchemaDefaults(child, path, seen)
}

function removePaths(value: unknown, paths: readonly CordisXConfigFieldPath[]): unknown {
  const result = clone(value)
  const removePath = (current: unknown, path: CordisXConfigFieldPath, index: number): void => {
    if (current === null || typeof current !== 'object' || index >= path.length) return
    if (Array.isArray(current)) {
      for (const item of current) removePath(item, path, index)
      return
    }
    const segment = path[index]!
    const record = current as Record<string, unknown>
    if (index === path.length - 1) {
      delete record[segment]
      return
    }
    removePath(record[segment], path, index + 1)
  }
  for (const path of paths) {
    if (path.length === 0) return undefined
    removePath(result, path, 0)
  }
  return result
}

function validate(schema: CordisXStandardSchema | undefined, raw: unknown): unknown {
  if (schema === undefined) return immutable(raw)
  const result = schema['~standard'].validate(clone(raw))
  if (result instanceof Promise) throw new Error('CordisX plugin Config validators must be synchronous')
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new Error(result.issues.map(issue => issue.message).join('; '))
  }
  if (!Object.hasOwn(result, 'value')) throw new Error('Standard Schema returned neither value nor issues')
  return immutable(result.value)
}

function hasOwnPath(value: unknown, path: CordisXConfigFieldPath): boolean {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return false
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return true
}

export {
  assertPath,
  hasOwnPath,
  immutable,
  isReservedConfigRole,
  jsonCompatible,
  ownValue,
  pathStartsWith,
  removePaths,
  sensitiveNodes,
  setAtPath,
  validate,
  validateSchemaDefaults,
}
