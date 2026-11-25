import { isDeepStrictEqual } from 'node:util'
import {
  type LogicalContinuationState,
  type LogicalTransactionStore,
  parseLogicalContinuationState,
} from './logical-continuation-control.js'
import { type ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'

const empty = (): LogicalContinuationState => ({ revision: 0, intents: {}, relations: {} })

/** Upgrade only on the first committed logical change. Older Hosts reject schema 2 before dispatch. */
export function channelLogicalTransactionStore(
  store: ChannelConversationStore,
): LogicalTransactionStore<ChannelConversationState> {
  return {
    snapshot: () => {
      const value = store.snapshot()
      value.logicalContinuations ??= empty()
      return value
    },
    mutate: update =>
      store.mutate(value => {
        const original = value.logicalContinuations
        value.logicalContinuations ??= empty()
        const before = structuredClone(value.logicalContinuations)
        const result = update(value)
        if (original === undefined && isDeepStrictEqual(before, value.logicalContinuations)) {
          delete value.logicalContinuations
        } else {
          value.logicalContinuations = parseLogicalContinuationState(value.logicalContinuations)
          if (value.schemaVersion !== 3) value.schemaVersion = 2
        }
        return result
      }),
  }
}
