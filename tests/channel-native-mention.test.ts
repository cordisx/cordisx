import { expect, it } from 'vitest'
import { richtextRequirements, validateOutboundContent } from '../packages/channel-runtime/src/outbound-content.js'
import { validateChannelSendPayload } from '../packages/cli/src/cli/channel-send-payload.js'
import { renderFeishuTypedContent } from '../packages/cli/src/launcher/feishu-outbound-media.js'

const content = {
  type: 'richtext',
  blocks: [
    {
      type: 'paragraph',
      nodes: [{ type: 'mention', userId: 'ou_user' }, { type: 'text', text: ' please review', style: 'strong' }],
    },
    { text: 'legacy line', style: 'plain' },
  ],
}
it('renders native mention and explanation on one line without changing legacy block lines', () => {
  expect(validateChannelSendPayload(content)).toEqual(content)
  const validated = validateOutboundContent(content)
  expect(richtextRequirements(validated)).toEqual({ paragraphs: true, userIds: ['ou_user'] })
  expect(renderFeishuTypedContent(validated)).toEqual({
    msg_type: 'post',
    content: {
      en_us: {
        title: '',
        content: [
          [{ tag: 'at', user_id: 'ou_user' }, { tag: 'text', text: ' please review', style: ['bold'] }],
          [{ tag: 'text', text: 'legacy line' }],
        ],
      },
    },
  })
})
it.each(['all', 'ALL', 'everyone', 'here', 'Display Name', '', 'a'.repeat(257)])(
  'rejects invalid mention %s in both CLI and Host',
  userId => {
    const invalid = { type: 'richtext', blocks: [{ type: 'paragraph', nodes: [{ type: 'mention', userId }] }] }
    expect(() => validateOutboundContent(invalid)).toThrow()
    expect(() => validateChannelSendPayload(invalid)).toThrow()
  },
)
it('rejects caller verification assertions and unsupported inline code', () => {
  for (
    const node of [{ type: 'mention', userId: 'ou_user', verified: true }, {
      type: 'text',
      text: 'code',
      style: 'code',
    }]
  ) {
    const invalid = { type: 'richtext', blocks: [{ type: 'paragraph', nodes: [node] }] }
    expect(() => validateOutboundContent(invalid)).toThrow()
    expect(() => validateChannelSendPayload(invalid)).toThrow()
  }
})
