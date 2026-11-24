import { channelExact, channelRecord } from './channel-conversation-policy.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelFailureNoticesV1 } from '@cordisx/protocol/channel-model-priority/v1'

export type ChannelFailureNoticeConfig = ChannelFailureNoticesV1
export function parseChannelFailureNoticeConfig(value: unknown): ChannelFailureNoticeConfig {
  const row = channelRecord(value)
  channelExact(row, ['revision', 'enabled'])
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || typeof row.enabled !== 'boolean') {
    throw new Error('INVALID_FAILURE_NOTICE_CONFIG')
  }
  return { revision: Number(row.revision), enabled: row.enabled }
}
export async function channelFailureNoticeConfigOperation(
  store: ChannelConversationStore,
  operation: string,
  args: Record<string, unknown>,
) {
  if (operation === 'failure-notices') {
    channelExact(args, [])
    return { status: 'ok', ...store.snapshot().failureNotices }
  }
  channelExact(args, ['expectedRevision', 'enabled'])
  const config = parseChannelFailureNoticeConfig({ revision: args.expectedRevision, enabled: args.enabled })
  return store.mutate(state => {
    if (state.failureNotices.revision !== config.revision) throw new Error('REVISION_CONFLICT')
    state.failureNotices = { revision: config.revision + 1, enabled: config.enabled }
    return { status: 'ok', ...state.failureNotices }
  })
}
