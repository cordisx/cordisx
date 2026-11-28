/** Only the outer sidecar classifies transport loss; the owner validates the complete request. */
export function managerDocumentWrite(payload: string): boolean | undefined {
  try {
    const value: unknown = JSON.parse(payload)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const operation = (value as Record<string, unknown>).operation
    return operation === 'load' ? false : operation === 'replace' ? true : undefined
  } catch {
    return undefined
  }
}

/** Check owner-issued grants against the candidate before forwarding them to a page. */
export function validManagerDocumentBindings(
  value: unknown,
  affected: readonly string[],
  plugins: readonly {
    readonly id: string
    readonly enabled: boolean
    readonly moduleGeneration: string
    readonly canonicalSource?: string
  }[],
): boolean {
  const expected = affected.filter(id => plugins.some(plugin => plugin.id === id && plugin.enabled))
  if (!Array.isArray(value) || value.length !== expected.length) return false
  const ids = new Set<string>()
  const tokens = new Set<string>()
  return value.every(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const binding = raw as Record<string, unknown>
    const item = plugins.find(plugin => plugin.id === binding.pluginId)
    if (
      Object.keys(binding).length !== 4
      || Object.keys(binding).some(key => !['source', 'pluginId', 'moduleGeneration', 'token'].includes(key))
      || typeof binding.pluginId !== 'string' || !expected.includes(binding.pluginId) || ids.has(binding.pluginId)
      || typeof binding.source !== 'string'
      || !/^https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}$/u.test(binding.source)
      || typeof binding.token !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.token) || tokens.has(binding.token)
      || !item || item.moduleGeneration !== binding.moduleGeneration
      || item.canonicalSource !== undefined && item.canonicalSource !== binding.source
    ) return false
    ids.add(binding.pluginId)
    tokens.add(binding.token)
    return true
  })
}
