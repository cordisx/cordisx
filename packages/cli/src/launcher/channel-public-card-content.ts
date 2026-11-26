export function channelPublicCardContent(type: unknown, content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined
  if (type !== 'interactive') return content
  if (Buffer.byteLength(content) > 64000) return undefined
  let visited = 0
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 32 || ++visited > 4096) throw new Error('CHANNEL_CARD_CONTENT_LIMIT')
    if (Array.isArray(value)) return value.some(entry => inspect(entry, depth + 1))
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    if (Object.hasOwn(record, 'channelGenericAction')) return true
    return Object.values(record).some(entry => inspect(entry, depth + 1))
  }
  const redact = (value: unknown, depth: number): unknown => {
    if (depth > 32 || ++visited > 4096) throw new Error('CHANNEL_CARD_CONTENT_LIMIT')
    if (Array.isArray(value)) return value.map(entry => redact(entry, depth + 1))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'value' && key !== 'channelGenericAction')
        .map(([key, entry]) => [key, redact(entry, depth + 1)]),
    )
  }
  try {
    const card: unknown = JSON.parse(content)
    if (!inspect(card, 0)) return content
    visited = 0
    return JSON.stringify(redact(card, 0))
  } catch {
    return undefined
  }
}
