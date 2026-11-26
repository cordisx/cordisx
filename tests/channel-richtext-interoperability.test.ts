import { expect, it } from 'vitest'
import { renderFeishuRichtextV3 } from '../packages/cli/src/launcher/feishu-richtext-v3.js'
import { feishuHistoricalResourceDescriptors } from '../packages/cli/src/launcher/feishu-historical-resource-descriptors.js'
import { channelPublicCardContent } from '../packages/cli/src/launcher/channel-public-card-content.js'
import { parseMessageOperation } from '../packages/cli/src/launcher/channel-message-operation-request.js'
import { CHANNEL_MESSAGE_CAPABILITY_INVENTORY } from '../packages/cli/src/launcher/channel-message-capability-inventory.js'

const content = {
  type: 'richtext',
  blocks: [
    {
      type: 'paragraph',
      nodes: [{ type: 'link', text: '**literal**', url: 'https://example.org' }, {
        type: 'image',
        handle: 'media:prepared',
      }],
    },
    { type: 'inline-code', text: '<at user_id="all">literal</at>' },
    { type: 'code', text: 'return 42', language: 'GO' },
  ],
}

it('preserves rendered posts and associates their image only with the authoritative source', () => {
  const rendered = renderFeishuRichtextV3(content, new Map([['media:prepared', 'img_verified']]))
  const serialized = JSON.stringify(rendered)
  const message = {
    message_id: 'om_message',
    chat_id: 'oc_chat',
    msg_type: 'post',
    body: { content: serialized },
  }
  expect(channelPublicCardContent('post', serialized)).toBe(serialized)
  expect(feishuHistoricalResourceDescriptors(message, 'oc_chat', 'om_message')).toEqual([
    { type: 'image', fileKey: 'img_verified' },
  ])
  for (const invalid of [{ ...message, message_id: 'om_other' }, { ...message, chat_id: 'oc_other' }]) {
    expect(() => feishuHistoricalResourceDescriptors(invalid, 'oc_chat', 'om_message'))
      .toThrow('HISTORICAL_RESOURCE_SOURCE_MISMATCH')
  }
})

it('keeps private interactive callbacks redacted without interpreting literal post code', () => {
  const card = JSON.stringify({
    elements: [{
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: 'Review' },
        value: { nested: { channelGenericAction: 'private-token', value: 'private-value' } },
      }],
    }],
  })
  const publicCard = channelPublicCardContent('interactive', card)
  expect(publicCard).toContain('Review')
  expect(publicCard).not.toContain('private-token')
  expect(publicCard).not.toContain('private-value')
  expect(publicCard).not.toContain('channelGenericAction')
})

it('preserves all integrated capabilities while the actual edit parser remains frozen', () => {
  for (
    const capability of [
      'historical-resource-refetch',
      'generic-card-actions',
      'richtext-links-inline-images-code-language',
    ]
  ) {
    expect(CHANNEL_MESSAGE_CAPABILITY_INVENTORY.find(item => item.capability === capability))
      .toMatchObject({ implementation: 'supported' })
  }
  const base = {
    account: { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' },
    conversationId: 'oc_chat',
    kind: 'group',
    messageId: 'om_message',
    operationId: 'edit',
  }
  expect(() => parseMessageOperation('message-edit', { ...base, content })).toThrow()
  expect(() =>
    parseMessageOperation('message-edit', {
      ...base,
      content: { type: 'text', text: '<at user_id="ou_verified">name</at>' },
    })
  ).toThrow('CHANNEL_EDIT_MENTION_UNSUPPORTED')
})
