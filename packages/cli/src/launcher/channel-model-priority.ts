import { channelExact, channelRecord, channelText } from './channel-conversation-policy.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import type { ChannelModelPriorityV1 } from '@cordisx/protocol/channel-model-priority/v1'

export type ChannelModelPriority = ChannelModelPriorityV1
export type ChannelModelCandidate = ChannelModelPriorityV1['candidates'][number]

export function parseChannelModelPriority(value: unknown): ChannelModelPriority {
  const row = channelRecord(value)
  channelExact(row, ['revision', 'candidates'])
  if (
    !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !Array.isArray(row.candidates)
    || row.candidates.length > 8
  ) throw new Error('INVALID_MODEL_PRIORITY')
  const candidates = row.candidates.map(value => {
    const candidate = channelRecord(value)
    channelExact(candidate, ['providerId', 'model'])
    return { providerId: channelText(candidate.providerId, 128), model: channelText(candidate.model, 512) }
  })
  if (new Set(candidates.map(candidate => JSON.stringify(candidate))).size !== candidates.length) {
    throw new Error('INVALID_MODEL_PRIORITY')
  }
  return { revision: Number(row.revision), candidates }
}

/** Local profile settings: the whole ordered list is changed with revision fencing. */
export async function channelModelPriorityOperation(
  store: ChannelConversationStore,
  operation: string,
  value: Record<string, unknown>,
) {
  if (operation === 'model-priority') {
    channelExact(value, [])
    return { status: 'ok', ...store.snapshot().modelPriority }
  }
  channelExact(value, ['expectedRevision', 'candidates'])
  const priority = parseChannelModelPriority({ revision: value.expectedRevision, candidates: value.candidates })
  return store.mutate(state => {
    if (state.modelPriority.revision !== priority.revision) throw new Error('REVISION_CONFLICT')
    state.modelPriority = { revision: priority.revision + 1, candidates: priority.candidates }
    return { status: 'ok', ...state.modelPriority }
  })
}

export async function channelModelPriorityLocal(
  consumer: ChannelConversationConsumer | undefined,
  operation: string,
  value: unknown,
  metadata: unknown,
) {
  if (metadata !== undefined) return { status: 'rejected', code: 'LOCAL_USER_REQUIRED' }
  if (!consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
  try {
    return await consumer.modelPriorityOperation(operation, channelRecord(value))
  } catch (error) {
    return {
      status: 'rejected',
      code: error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'INVALID_REQUEST',
    }
  }
}
