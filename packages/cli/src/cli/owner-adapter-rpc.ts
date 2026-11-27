import type { OwnerAdapterSessionOperation, OwnerAdapterSessions } from './owner-adapter-sessions.js'

export type OwnerAdapterRpcOperation = OwnerAdapterSessionOperation & { readonly kind: 'owner-adapter' }

/** Parse only the owner-private adapter protocol, after the management endpoint authenticates its caller. */
export function parseOwnerAdapterRpcOperation(value: unknown): OwnerAdapterRpcOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adapter-request-invalid')
  const input = value as Record<string, unknown>
  const action = input.action
  const keys = action === 'open'
    ? ['kind', 'action', 'pid', 'processStartedAt']
    : action === 'poll'
    ? ['kind', 'action', 'sessionId', 'grant', 'timeoutMs']
    : action === 'acknowledge'
    ? ['kind', 'action', 'sessionId', 'grant', 'receipt']
    : action === 'lifecycle' || action === 'management' || action === 'document' || action === 'artifact'
    ? ['kind', 'action', 'sessionId', 'grant', 'payload']
    : action === 'admit' || action === 'close'
    ? ['kind', 'action', 'sessionId', 'grant']
    : []
  if (
    input.kind !== 'owner-adapter' || keys.length === 0 || Object.keys(input).length !== keys.length
    || Object.keys(input).some(key => !keys.includes(key))
  ) throw new Error('adapter-request-invalid')
  if (action === 'open') {
    if (
      !Number.isSafeInteger(input.pid) || (input.pid as number) <= 0
      || typeof input.processStartedAt !== 'string' || input.processStartedAt.length === 0
      || input.processStartedAt.length > 256
    ) throw new Error('adapter-request-invalid')
  } else if (
    typeof input.sessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sessionId)
    || typeof input.grant !== 'string' || !/^[a-f0-9]{64}$/u.test(input.grant)
    || action === 'poll' && (!Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < 1
        || (input.timeoutMs as number) > 30_000)
  ) throw new Error('adapter-request-invalid')
  return input as unknown as OwnerAdapterRpcOperation
}

export async function dispatchOwnerAdapterRpcOperation(
  sessions: OwnerAdapterSessions,
  operation: OwnerAdapterRpcOperation,
): Promise<{ readonly status: 'ok'; readonly value?: unknown } | { readonly status: 'unavailable' }> {
  if (operation.action === 'open') {
    const value = await sessions.open(operation)
    return value ? { status: 'ok', value } : { status: 'unavailable' }
  }
  if (operation.action === 'poll') {
    const value = await sessions.poll(operation.sessionId, operation.grant, operation.timeoutMs)
    return value ? { status: 'ok', value } : { status: 'unavailable' }
  }
  if (operation.action === 'lifecycle') {
    const result = await sessions.requestLifecycle(operation.sessionId, operation.grant, operation.payload)
    return result.available ? { status: 'ok', value: result.value } : { status: 'unavailable' }
  }
  if (operation.action === 'management') {
    const result = await sessions.requestManagement(operation.sessionId, operation.grant, operation.payload)
    return result.available ? { status: 'ok', value: result.value } : { status: 'unavailable' }
  }
  if (operation.action === 'document') {
    const result = await sessions.requestDocument(operation.sessionId, operation.grant, operation.payload)
    return result.available ? { status: 'ok', value: result.value } : { status: 'unavailable' }
  }
  if (operation.action === 'artifact') {
    const result = await sessions.requestArtifact(operation.sessionId, operation.grant, operation.payload)
    return result.available ? { status: 'ok', value: result.value } : { status: 'unavailable' }
  }
  const completed = operation.action === 'admit'
    ? await sessions.admit(operation.sessionId, operation.grant)
    : operation.action === 'acknowledge'
    ? await sessions.acknowledge(operation.sessionId, operation.grant, operation.receipt)
    : await sessions.end(operation.sessionId, operation.grant)
  return completed ? { status: 'ok' } : { status: 'unavailable' }
}
