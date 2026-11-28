import { isDeepStrictEqual } from 'node:util'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A Manager form may change only the name and reception selectors of one resolved connection. */
export function isManagerChannelFormMutation(current: unknown, candidate: unknown): boolean {
  const before = object(current), after = object(candidate)
  if (!before || !after || !Array.isArray(before.connections) || !Array.isArray(after.connections)) return false
  if (before.connections.length !== after.connections.length || before.connections.length > 64) return false
  const beforeRoot = { ...before }, afterRoot = { ...after }
  delete beforeRoot.connections
  delete afterRoot.connections
  // The existing connection form upgrades the original configuration format when it saves.
  if (before.schemaVersion === 1 && after.schemaVersion === 2) {
    beforeRoot.contract = 'cordisx.channel-service-config/v2'
    beforeRoot.schemaVersion = 2
  }
  if (!isDeepStrictEqual(beforeRoot, afterRoot)) return false
  let changed = 0
  for (let index = 0; index < before.connections.length; index++) {
    const previous = object(before.connections[index]), next = object(after.connections[index])
    if (!previous || !next) return false
    const previousFixed = { ...previous }, nextFixed = { ...next }
    delete previousFixed.displayName
    delete previousFixed.selectors
    delete nextFixed.displayName
    delete nextFixed.selectors
    if (!isDeepStrictEqual(previousFixed, nextFixed)) return false
    const nameChanged = !isDeepStrictEqual(previous.displayName, next.displayName)
    const selectorsChanged = !isDeepStrictEqual(previous.selectors, next.selectors)
    if (!nameChanged && !selectorsChanged) continue
    const ref = object(previous.ref)
    if (++changed > 1 || !ref || typeof ref.tenantId !== 'string' || !ref.tenantId.trim()) return false
    if (
      nameChanged && (typeof next.displayName !== 'string' || !next.displayName.trim()
        || next.displayName.length > 240 || /[\u0000-\u001f]/u.test(next.displayName))
    ) return false
    if (selectorsChanged) {
      const selectors = next.selectors
      if (
        !Array.isArray(selectors) || selectors.length < 1 || selectors.length > 4
        || new Set(selectors).size !== selectors.length
        || selectors.some(item =>
          typeof item !== 'string' || !['direct', 'group', 'mentions', 'replies'].includes(item)
        )
      ) return false
    }
  }
  return true
}
