import type { ChannelUserInput } from '@cordisx/channel-runtime'
import type { ChannelCommandAddressing } from './channel-command-users.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import { CALLER } from './channel-conversation-consumer-contract.js'

/** Persist incoming input before dispatch, retaining existing acceptance state. */
export async function storeChannelInput(store: ChannelConversationStore, input: {
  recordId: string
  message: ChannelUserInput
  mentionedBot: boolean
  persisted: boolean
  addressing?: ChannelCommandAddressing | undefined
}) {
  const { recordId, message, mentionedBot, persisted, addressing } = input
  return await store.mutate(state => {
    const prior = state.inputs[recordId]
    if (prior) {
      state.inputs[recordId] = {
        ...prior,
        mentionedBot: prior.mentionedBot || mentionedBot,
        persisted: prior.persisted || persisted,
        ...(addressing === undefined ? {} : { addressing: structuredClone(addressing) }),
      }
      return
    }
    state.inputs[recordId] = {
      recordId,
      input: structuredClone(message),
      mentionedBot,
      sequence: state.nextSequence++,
      persisted,
      ...(addressing === undefined ? {} : { addressing: structuredClone(addressing) }),
      accepted: false,
      routed: false,
    }
    return true
  })
}

/** Restore durable input records without changing the cursor until they are received. */
export async function catchupChannelInputs(
  store: ChannelConversationStore,
  access: import('./channel-conversation-tools.js').ChannelConversationAccess | undefined,
  signal: AbortSignal,
  receive: (recordId: string, input: ChannelUserInput) => Promise<void>,
) {
  if (!access) return
  const accounts = access.accounts()
  if (!accounts.length) return
  const cursor = store.snapshot().inputCursor
  const read = await access.runtime.inputsSince(
    CALLER,
    accounts.map(account => ({ account: account.ref })),
    cursor,
    100,
  )
  if (signal.aborted) return
  for (const message of read.messages) await receive(message.recordId, message.input)
  if (read.cursor !== cursor) {
    await store.mutate(state => {
      state.inputCursor = read.cursor
    })
  }
}
