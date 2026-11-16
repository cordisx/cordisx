import { diagnostic, diagnosticRef } from '../diagnostics/context.js'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { feishuFailureDiagnostic } from './feishu-operation-error.js'

class FeishuCardUpdateError extends Error {
  constructor(readonly code?: number) {
    super('CHANNEL_APPROVAL_CARD_UPDATE_FAILED')
    this.name = 'FeishuCardUpdateError'
  }
}

/** The SDK's updateCard discards the API business result. Check it before acknowledging a replace. */
export async function updateFeishuCard(
  channel: FeishuSdkChannel,
  accountId: string,
  messageId: string,
  card: object,
): Promise<void> {
  const fields = { serviceRef: diagnosticRef(accountId), requestRef: diagnosticRef(messageId) }
  try {
    if (!channel.rawClient) throw new FeishuCardUpdateError()
    const result = await channel.rawClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
    if (result.code !== 0) {
      throw new FeishuCardUpdateError(Number.isSafeInteger(result.code) ? result.code : undefined)
    }
    diagnostic({ event: 'channel-feishu', phase: 'card-updated', ...fields })
  } catch (error) {
    const detail = feishuFailureDiagnostic('card-update', error)
    diagnostic({
      event: 'channel-feishu',
      phase: 'card-update-failed',
      ...fields,
      ...(detail.httpStatus === undefined ? {} : { statusCode: detail.httpStatus }),
      ...(detail.platformCode === undefined ? {} : { errorCode: String(detail.platformCode) }),
    })
    // Never propagate Axios messages, response bodies, headers or native commands.
    throw error instanceof FeishuCardUpdateError ? error : new FeishuCardUpdateError(detail.platformCode)
  }
}
