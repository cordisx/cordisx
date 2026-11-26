export function safeCardBody(body: string | undefined): boolean {
  if (!body) return false
  try {
    const value = JSON.parse(body) as { elements?: { tag?: string; text?: { tag?: string } }[] }
    return Array.isArray(value.elements) && value.elements.length > 0
      && value.elements.every(element => element.tag === 'div' && element.text?.tag === 'plain_text')
  } catch {
    return false
  }
}

export function strictPlainCardBody(body: string | undefined): boolean {
  if (!body || Buffer.byteLength(body) > 30000) return false
  const exact = (value: unknown, expected: readonly string[]): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
  const plain = (value: unknown) =>
    exact(value, ['tag', 'content']) && value.tag === 'plain_text'
    && typeof value.content === 'string' && !/\0/u.test(value.content)
  try {
    const value: unknown = JSON.parse(body)
    if (
      !exact(value, ['config', 'header', 'elements']) || !exact(value.config, ['wide_screen_mode'])
      || value.config.wide_screen_mode !== true || !exact(value.header, ['title']) || !plain(value.header.title)
      || !Array.isArray(value.elements) || value.elements.length !== 1
    ) return false
    const element: unknown = value.elements[0]
    return exact(element, ['tag', 'text']) && element.tag === 'div' && plain(element.text)
  } catch {
    return false
  }
}
