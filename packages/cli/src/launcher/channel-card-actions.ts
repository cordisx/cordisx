import { createHash } from 'node:crypto'
import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { CardActionEvent } from '@larksuiteoapi/node-sdk'
import type { ChannelChatBinding } from './channel-conversation-store.js'
import type { ChannelTaskSettings } from './channel-task-settings.js'
import type { ChannelNativeApprovals } from './channel-native-approvals.js'

const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Normalize verified adapter callbacks once; card values cannot impersonate an actor or retarget approval. */
export async function channelCardAction(
  input: {
    bindings(): readonly ChannelChatBinding[]
    tasks: ChannelTaskSettings
    approvals: ChannelNativeApprovals
    reply(operationId: string, event: ChannelEventRef, text: string): Promise<unknown>
  },
  ref: ChannelTenantRef,
  action: CardActionEvent,
) {
  const value = action.action.value as { channelApproval?: unknown; decision?: unknown } | undefined
  if (
    !value || typeof value.channelApproval !== 'string'
    || !['accept', 'acceptForSession', 'decline'].includes(String(value.decision))
  ) return
  const channel = input.bindings().find(binding =>
    binding.channel.adapterId === ref.adapterId && binding.channel.accountId === ref.accountId
    && binding.channel.tenantId === ref.tenantId && binding.channel.conversationId === action.chatId
  )?.channel
  if (!channel) return
  const event: ChannelEventRef = {
    ...ref,
    conversationId: action.chatId,
    kind: channel.kind,
    threadId: channel.threadId,
    semantics: 'conversation',
    eventId: action.messageId,
    messageId: action.messageId,
    actor: { ...ref, userId: action.operator.openId },
  }
  const taskApproval = value.channelApproval.startsWith('task:')
  const result = taskApproval
    ? await input.tasks.answer(
      event,
      value.channelApproval.slice(5),
      value.decision === 'decline' ? 'decline' : 'accept',
      action.messageId,
    )
    : await input.approvals.answer(event, value.channelApproval, String(value.decision), action.messageId)
  await input.reply(
    `card-action:${identity([value.channelApproval, action.operator.openId, value.decision])}`,
    event,
    result,
  )
  if (!taskApproval) await input.approvals.synchronizeCard(event, value.channelApproval, action.messageId)
}
