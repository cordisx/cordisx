import type { ChannelOutboundDelivery } from '@cordisx/channel-runtime'

/** Only the stored token and an index return from the platform; values stay Host-side. */
export function channelQuestionCard(card: NonNullable<ChannelOutboundDelivery['questionCard']>): object {
  const buttons = card.options.map((label, index) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    value: { channelQuestion: card.token, option: index },
  }))
  return {
    config: { wide_screen_mode: false },
    header: { template: 'blue', title: { tag: 'plain_text', content: '请选择或直接回复' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: card.question } },
      ...buttons.filter((_, index) => index % 2 === 0).map((_, index) => ({
        tag: 'action',
        actions: buttons.slice(index * 2, index * 2 + 2),
      })),
      {
        tag: 'form',
        name: 'channel_question_form',
        elements: [
          {
            tag: 'input',
            name: 'answer',
            placeholder: { tag: 'plain_text', content: '或输入自己的回答' },
            max_length: 1000,
            required: true,
          },
          {
            tag: 'button',
            name: 'channel_question_submit',
            action_type: 'form_submit',
            text: { tag: 'plain_text', content: '提交回答' },
            value: { channelQuestion: card.token },
          },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '也可发送文字消息；群聊请 @机器人或使用唤醒词。' }] },
    ],
  }
}
