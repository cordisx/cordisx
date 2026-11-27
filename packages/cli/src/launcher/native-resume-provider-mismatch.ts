import { JsonLineRpcError } from '../providers/json-line-rpc.js'

/** Read a precise native refusal; absence or transport uncertainty is not evidence of mismatch. */
export function nativeResumeProviderMismatch(error: unknown, requested: string): string | undefined {
  if (!(error instanceof JsonLineRpcError) || error.rpcCode !== -32600) return undefined
  const data = error.rpcData && typeof error.rpcData === 'object' && !Array.isArray(error.rpcData)
    ? error.rpcData as Record<string, unknown>
    : undefined
  let source: unknown, target: unknown
  if (data?.type === 'modelProviderMismatch') {
    source = data.modelProvider
    target = data.currentModelProvider
  } else {
    const match = /cannot change this thread['’]s model provider from (.+?) to (.+?) on resume/iu.exec(error.message)
    const unquote = (value: string) => value.replace(/^[`'"“”]+|[`'"“”]+$/gu, '')
    source = match && unquote(match[1]!)
    target = match && unquote(match[2]!)
  }
  if (
    typeof source !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(source)
    || target !== requested || source === requested
  ) return undefined
  return source
}
