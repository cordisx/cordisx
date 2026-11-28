const reserved = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Reject edits outside the published schema, sensitive roles and array identity changes. */
export function safeServiceConfigEdit(envelope, before, after) {
  if (!record(envelope) || !record(envelope.refs) || envelope.uid === undefined) return false
  const visit = (reference, original, next, depth) => {
    if (depth > 32) return false
    const schema = envelope.refs[String(reference)]
    if (!record(schema)) return equal(original, next)
    if (reserved.has(schema.meta?.role) || schema.type === 'const') return equal(original, next)
    if (schema.type === 'object') {
      if (!record(next) || !record(schema.dict)) return equal(original, next)
      const prior = record(original) ? original : {}
      const keys = new Set([...Object.keys(prior), ...Object.keys(next)])
      for (const key of keys) {
        if (!Object.hasOwn(schema.dict, key)) {
          if (!equal(prior[key], next[key])) return false
        } else if (!visit(schema.dict[key], prior[key], next[key], depth + 1)) return false
      }
      return true
    }
    if (schema.type === 'array') {
      if (!Array.isArray(original) || !Array.isArray(next) || original.length !== next.length) {
        return equal(original, next)
      }
      return original.every((item, index) => {
        const replacement = next[index]
        if (record(item) && Object.hasOwn(item, 'id') && item.id !== replacement?.id) return false
        return visit(schema.inner, item, replacement, depth + 1)
      })
    }
    if (next === undefined) return true
    if (schema.type === 'string') return typeof next === 'string'
    if (schema.type === 'number' || schema.type === 'natural') return typeof next === 'number' && Number.isFinite(next)
    if (schema.type === 'boolean') return typeof next === 'boolean'
    return equal(original, next)
  }
  return visit(envelope.uid, before, after, 0)
}
