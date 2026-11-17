import {
  type ChatExecutionDefaults,
  mergeChatExecutionSettings,
  parseChatExecutionSettings,
} from '../chat-execution-settings.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'

/** The Channel owns only its sparse creation layer; general profile defaults remain a separate owner. */
export class ChannelCreationDefaults {
  constructor(private readonly store: ChannelConversationStore) {}

  read(): ChatExecutionDefaults {
    return this.store.snapshot().creationDefaults
  }

  async operation(operation: string, args: Record<string, unknown>) {
    if (operation === 'channel-execution-defaults') {
      if (Object.keys(args).length) throw new Error('INVALID_REQUEST')
      return { status: 'ok', ...this.read() }
    }
    if (
      operation !== 'channel-execution-defaults-set'
      || Object.keys(args).some(key => !['settings', 'expectedRevision'].includes(key))
      || !Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0
    ) throw new Error('INVALID_REQUEST')
    const settings = mergeChatExecutionSettings({}, parseChatExecutionSettings(args.settings))
    return this.store.mutate(state => {
      if (state.creationDefaults.revision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
      state.creationDefaults = { revision: Number(args.expectedRevision) + 1, settings }
      return { status: 'ok', ...state.creationDefaults }
    })
  }
}
