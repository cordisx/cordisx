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
