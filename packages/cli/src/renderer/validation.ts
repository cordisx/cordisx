import type { CordisXJsonScalar, CordisXLocalizedText, CordisXWhen } from '../contracts.js'

export const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
export const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/
export const ICON_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9.-]{0,63}$/

export function assertLocalId(value: string, label: string): void {
  if (!LOCAL_ID_PATTERN.test(value)) throw new Error(`invalid ${label}: ${value}`)
}

export function assertReference(value: string, label: string): void {
  if (!REFERENCE_PATTERN.test(value)) throw new Error(`invalid ${label}: ${value}`)
}

export function assertLocalizedText(value: unknown, label: string): asserts value is CordisXLocalizedText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be LocalizedText`)
  }
  const message = value as Partial<CordisXLocalizedText>
  const unknown = Object.keys(value).find(key => !['namespace', 'key', 'params', 'fallback'].includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
  if (typeof message.key !== 'string') throw new Error(`${label}.key is required`)
  assertLocalId(message.key, `${label}.key`)
  if (message.namespace !== undefined) assertReference(message.namespace, `${label}.namespace`)
  if (message.fallback !== undefined && (typeof message.fallback !== 'string' || message.fallback.length === 0)) {
    throw new Error(`${label}.fallback must be a non-empty string`)
  }
  if (message.params !== undefined) {
    if (message.params === null || typeof message.params !== 'object' || Array.isArray(message.params)) {
      throw new Error(`${label}.params must be an object`)
    }
    for (const [key, item] of Object.entries(message.params)) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) throw new Error(`${label}.params has invalid key ${key}`)
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
        throw new Error(`${label}.params.${key} must be a scalar`)
      }
    }
  }
}

function cloneValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (typeof value !== 'object') throw new Error('structured contribution contains a non-serializable value')
  if (seen.has(value)) throw new Error('structured contribution contains a cycle')
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map(item => cloneValue(item, seen))
    seen.delete(value)
    return Object.freeze(result)
  }
  const prototype = Object.getPrototypeOf(value)
  const constructor = prototype === null ? undefined : Object.prototype.hasOwnProperty.call(prototype, 'constructor')
    ? (prototype as { constructor?: unknown }).constructor
    : undefined
  if (
    Object.prototype.toString.call(value) !== '[object Object]'
    || (constructor !== undefined && (typeof constructor !== 'function' || constructor.name !== 'Object'))
  ) {
    throw new Error('structured contribution must contain plain objects only')
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item, seen)
  seen.delete(value)
  return Object.freeze(result)
}

export function immutableSnapshot<Value>(value: Value): Value {
  return cloneValue(value, new Set()) as Value
}

export type CordisXContextValues = Readonly<Record<string, CordisXJsonScalar | undefined>>

export function evaluateWhen(condition: CordisXWhen | undefined, values: CordisXContextValues): boolean {
  if (condition === undefined) return true
  if ('key' in condition) {
    const known = Object.hasOwn(values, condition.key)
    const value = values[condition.key]
    if ('exists' in condition) return condition.exists ? known : !known
    if (!known) return false
    if ('equals' in condition) return Object.is(value, condition.equals)
    return !Object.is(value, condition.notEquals)
  }
  if ('all' in condition) return condition.all.length > 0 && condition.all.every(item => evaluateWhen(item, values))
  if ('any' in condition) return condition.any.length > 0 && condition.any.some(item => evaluateWhen(item, values))
  return !evaluateWhen(condition.not, values)
}

export function assertWhenExpression(condition: CordisXWhen | undefined): void {
  if (condition === undefined) return
  immutableSnapshot(condition)
  if ('key' in condition) {
    assertLocalId(condition.key, 'when context key')
    const operator = ['exists', 'equals', 'notEquals'].filter(key => key in condition)
    if (operator.length !== 1 || Object.keys(condition).length !== 2) {
      throw new Error('when key condition must contain exactly one operator')
    }
  }
  if ('all' in condition) {
    if (Object.keys(condition).length !== 1) throw new Error('when.all has unknown fields')
    if (condition.all.length === 0) throw new Error('when.all cannot be empty')
    for (const item of condition.all) assertWhenExpression(item)
  }
  if ('any' in condition) {
    if (Object.keys(condition).length !== 1) throw new Error('when.any has unknown fields')
    if (condition.any.length === 0) throw new Error('when.any cannot be empty')
    for (const item of condition.any) assertWhenExpression(item)
  }
  if ('not' in condition) {
    if (Object.keys(condition).length !== 1) throw new Error('when.not has unknown fields')
    assertWhenExpression(condition.not)
  }
}

export function whenContextKeys(condition: CordisXWhen | undefined): readonly string[] {
  if (condition === undefined) return []
  if ('key' in condition) return [condition.key]
  if ('all' in condition) return condition.all.flatMap(whenContextKeys)
  if ('any' in condition) return condition.any.flatMap(whenContextKeys)
  return whenContextKeys(condition.not)
}

export class HostContextStore {
  private readonly listeners = new Set<() => void>()
  private values: Record<string, CordisXJsonScalar | undefined> = {}

  getSnapshot(): CordisXContextValues {
    return Object.freeze({ ...this.values })
  }

  replace(values: Record<string, CordisXJsonScalar | undefined>): void {
    if (JSON.stringify(values) === JSON.stringify(this.values)) return
    this.values = { ...values }
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
    this.values = {}
  }
}
