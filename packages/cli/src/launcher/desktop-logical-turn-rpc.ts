import type { DesktopLogicalTurnAuthority } from './desktop-logical-turn-authority.js'

export const unavailableLogicalHistory = () => ({
  success: false,
  contentItems: [{ type: 'inputText', text: '{"status":"unavailable"}' }],
})
export async function callLogicalHistory(
  handler: ((params: unknown) => Promise<unknown>) | undefined,
  params: unknown,
) {
  return handler
    ? await Promise.resolve().then(() => handler(params)).catch(unavailableLogicalHistory)
    : unavailableLogicalHistory()
}

/** The caller has already authenticated the private peer and validated token and request id. */
export async function desktopLogicalTurnRpc(
  authority: DesktopLogicalTurnAuthority,
  value: Record<string, unknown> & { token: string; requestId: string | number },
) {
  if (value.type === 'consume') {
    return value.method === 'turn/start' && typeof value.threadId === 'string'
        && await authority.begin(value.token, value.threadId, value.requestId)
      ? { kind: 'logical-turn' as const }
      : { kind: 'reject' as const, reason: 'request-mismatch' as const }
  }
  if (value.type === 'authorize') return await authority.authorize(value.token, value.requestId)
  if (value.type === 'complete' && typeof value.succeeded === 'boolean') {
    if (value.succeeded && typeof value.threadId === 'string' && typeof value.turnId === 'string') {
      authority.confirm(value.token, value.threadId, value.turnId, value.requestId)
    } else authority.cancel(value.token)
    return undefined
  }
  throw new Error('Unknown logical turn command')
}
