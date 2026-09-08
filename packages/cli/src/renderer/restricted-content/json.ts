export type RestrictedJson = null | boolean | number | string | readonly RestrictedJson[] | {
  readonly [key: string]: RestrictedJson
}

export const RESTRICTED_LIMITS = Object.freeze({
  sceneBytes: 64 * 1024,
  actionBytes: 4 * 1024,
  publishesPerSecond: 30,
  depth: 16,
  nodes: 65_536,
  sceneNodes: 1024,
  children: 400,
  textLength: 2048,
})

/** Validate before serialization: reject getters, cycles, non-JSON values and excessive nesting. */
export function encodeRestrictedJson(
  value: unknown,
  maxBytes: number,
  maxDepth: number = RESTRICTED_LIMITS.depth,
): string {
  let nodes = 0
  let roughBytes = 0
  const seen = new Set<object>()
  function visit(item: unknown, depth: number): void {
    if (++nodes > RESTRICTED_LIMITS.nodes || depth > maxDepth) throw new Error('JSON complexity limit')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') {
      roughBytes += item.length
      if (roughBytes > maxBytes) throw new Error('JSON size limit')
      return
    }
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || item === null) throw new Error('Expected JSON')
    if (seen.has(item)) throw new Error('Cyclic JSON')
    const proto = Object.getPrototypeOf(item)
    if (Array.isArray(item) && proto !== Array.prototype) throw new Error('Expected JSON array prototype')
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('Expected JSON object')
    seen.add(item)
    const keys = Reflect.ownKeys(item)
    if (keys.length > RESTRICTED_LIMITS.nodes) throw new Error('JSON complexity limit')
    if (Array.isArray(item) && (item.length > RESTRICTED_LIMITS.nodes || keys.length !== item.length + 1)) {
      throw new Error('Expected dense JSON array')
    }
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string') throw new Error('Expected JSON key')
      if (!Array.isArray(item)) {
        roughBytes += key.length
        if (roughBytes > maxBytes) throw new Error('JSON size limit')
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('Unsafe JSON key')
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) {
        throw new Error('Expected JSON array index')
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Expected JSON data property')
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 1)
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error('JSON size limit')
  return encoded
}

export function decodeRestrictedJson(value: unknown, maxBytes: number): RestrictedJson {
  if (typeof value !== 'string' || value.length > maxBytes) throw new Error('Expected bounded JSON string')
  const decoded: unknown = JSON.parse(value)
  encodeRestrictedJson(decoded, maxBytes)
  return decoded as RestrictedJson
}
