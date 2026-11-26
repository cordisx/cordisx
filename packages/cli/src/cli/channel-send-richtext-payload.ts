import type { ChannelOutboundContentV3 } from '@cordisx/channel-runtime'

export function validateLegacyRichtextPayload(payload: Record<string, unknown>): ChannelOutboundContentV3 {
  keys(payload, ['type', 'blocks'])
  if (!Array.isArray(payload.blocks) || !payload.blocks.length || payload.blocks.length > 128) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  const blocks = payload.blocks.map(value => {
    const block = record(value)
    if (block.type === 'paragraph') {
      keys(block, ['type', 'nodes'])
      if (!Array.isArray(block.nodes) || !block.nodes.length || block.nodes.length > 128) {
        throw new Error('INVALID_CHANNEL_PAYLOAD')
      }
      const nodes = block.nodes.map(value => {
        const node = record(value)
        if (node.type === 'mention') {
          keys(node, ['type', 'userId'])
          if (
            typeof node.userId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(node.userId)
            || /^(?:all|everyone|here)$/iu.test(node.userId)
          ) throw new Error('INVALID_CHANNEL_PAYLOAD')
          return { type: 'mention' as const, userId: node.userId }
        }
        keys(node, ['type', 'text', 'style'])
        if (node.type !== 'text' || !['plain', 'strong', 'emphasis'].includes(String(node.style))) {
          throw new Error('INVALID_CHANNEL_PAYLOAD')
        }
        if (typeof node.text !== 'string' || !node.text.length || Array.from(node.text).length > 4096) {
          throw new Error('INVALID_CHANNEL_PAYLOAD')
        }
        return { type: 'text' as const, text: node.text, style: node.style as 'plain' | 'strong' | 'emphasis' }
      })
      return { type: 'paragraph' as const, nodes }
    }
    keys(block, ['text', 'style'])
    if (!['plain', 'strong', 'emphasis', 'code'].includes(String(block.style))) {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
    return { text: boundedText(block.text, 4096), style: block.style as 'plain' | 'strong' | 'emphasis' | 'code' }
  })
  return { type: 'richtext', blocks }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CHANNEL_PAYLOAD')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_CHANNEL_PAYLOAD')
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  return value
}
