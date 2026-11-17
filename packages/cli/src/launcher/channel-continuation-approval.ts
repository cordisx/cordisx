import { continuationCheckpoint } from './channel-continuation.js'
import type { ChannelCliApprovalOperation } from './channel-cli-approval.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'

/** Only this task's exact active context can use the bounded checkpoint/history commands routinely. */
export function continuationRoutine(
  operation: ChannelCliApprovalOperation,
  threadId: string,
  turnId: string,
  native: ChannelNativeSessions | undefined,
): boolean | undefined {
  if (
    !['continuation-checkpoint', 'continuation-checkpoint-set', 'continuation-history', 'continuation-takeover-ready']
      .includes(operation.operation)
  ) {
    return undefined
  }
  if (!operation.context) return false
  const entry = native?.contextFor(operation.context)
  if (entry?.threadId !== threadId || entry.turnId !== turnId) return false
  const input = operation.input
  if (operation.operation === 'continuation-takeover-ready') {
    return Object.keys(input).length === 1 && typeof input.token === 'string' && /^[a-f0-9]{64}$/u.test(input.token)
  }
  if (operation.operation === 'continuation-checkpoint') return Object.keys(input).length === 0
  if (operation.operation === 'continuation-history') {
    return Object.keys(input).every(key => ['limit', 'cursor'].includes(key))
      && (input.limit === undefined
        || Number.isInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 32)
      && (input.cursor === undefined || typeof input.cursor === 'string' && input.cursor.length <= 16_384)
  }
  if (
    Object.keys(input).some(key => !['expectedRevision', 'checkpoint'].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
  ) return false
  try {
    continuationCheckpoint(input.checkpoint, threadId, Number(input.expectedRevision) + 1)
    return true
  } catch {
    return false
  }
}
