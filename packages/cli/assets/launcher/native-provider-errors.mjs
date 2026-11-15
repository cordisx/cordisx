/** Native structured provider failures occur before a model turn is accepted. */
export function nativeProviderFailure(message) {
  if (message?.error?.code !== -32600) return undefined
  const data = message.error.data
  if (!['modelProviderNotConfigured', 'modelProviderMismatch'].includes(data?.type)) return undefined
  if (typeof data.modelProvider !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(data.modelProvider)) return undefined
  if (
    data.type === 'modelProviderMismatch'
    && (typeof data.currentModelProvider !== 'string' || data.currentModelProvider === data.modelProvider)
  ) return undefined
  return data.modelProvider
}

/** Compatibility for native versions that expose a missing provider as plain configuration text. */
export function missingManagedProvider(message) {
  const structured = nativeProviderFailure(message)
  if (structured !== undefined) return structured
  if (message?.error?.code !== -32600 || typeof message.error.message !== 'string') return undefined
  const match = /^failed to load configuration: Model provider `([^`\0\r\n]{1,128})` not found$/u.exec(
    message.error.message,
  )
  return match?.[1]
}
