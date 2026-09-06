export const PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE = 'debug:agent-loop/mock/v1' as const

export function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

export function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    )
  }
  return JSON.stringify(canonical(value))
}

export function redactedClone<Value>(value: Value): Value {
  const redact = (input: unknown): unknown => {
    if (typeof input === 'string') return sanitized(input)
    if (Array.isArray(input)) return input.map(redact)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, redact(child)]))
  }
  return freeze(redact(value) as Value)
}

export function sanitized(value: string): string {
  return value
    .replace(/\b(token|credential|password|api[-_]?key)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/(?:^|\s)(\/(?:[^\s/]+\/)*[^\s]+)/gu, match => `${match.startsWith(' ') ? ' ' : ''}[path redacted]`)
}

export const simulatorBindingId = (task: string) => `simulated-binding-${task.replace(/[^A-Za-z0-9._~-]/gu, '~')}`
