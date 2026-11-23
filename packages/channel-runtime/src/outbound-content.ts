import { ChannelIntegrityError } from './runtime-validation.js'

export type ChannelOutboundType = 'text' | 'image' | 'audio' | 'file' | 'video' | 'richtext' | 'card'
export type ChannelRichtextInline =
  | { readonly type: 'text'; readonly text: string; readonly style: 'plain' | 'strong' | 'emphasis' }
  | { readonly type: 'mention'; readonly userId: string }
export type ChannelRichtextBlock =
  | { readonly text: string; readonly style: 'plain' | 'strong' | 'emphasis' | 'code' }
  | { readonly type: 'paragraph'; readonly nodes: readonly ChannelRichtextInline[] }
export type ChannelOutboundContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image' | 'audio' | 'file' | 'video'; readonly handle: string }
  | {
    readonly type: 'richtext'
    readonly blocks: readonly ChannelRichtextBlock[]
  }
  | { readonly type: 'card'; readonly title: string; readonly body: string }
export type ChannelOutboundFallback = { readonly mode: 'reject' } | { readonly mode: 'text'; readonly text: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelIntegrityError('Invalid outbound content')
  }
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ChannelIntegrityError('Invalid outbound content fields')
  }
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > maximum) {
    throw new ChannelIntegrityError('Invalid outbound text')
  }
  return value as string
}
export function validateOutboundContent(value: unknown): ChannelOutboundContent {
  const content = object(value)
  switch (content.type) {
    case 'text':
      keys(content, ['type', 'text'])
      return { type: 'text', text: text(content.text, 65536) }
    case 'image':
    case 'audio':
    case 'file':
    case 'video':
      keys(content, ['type', 'handle'])
      if (
        typeof content.handle !== 'string' || content.handle.length > 512
        || !/^media:[A-Za-z0-9_-]+$/u.test(content.handle)
      ) throw new ChannelIntegrityError('Invalid outbound handle')
      return { type: content.type, handle: content.handle }
    case 'card':
      keys(content, ['type', 'title', 'body'])
      return { type: 'card', title: text(content.title, 256), body: text(content.body, 16384) }
    case 'richtext': {
      keys(content, ['type', 'blocks'])
      if (!Array.isArray(content.blocks) || content.blocks.length === 0 || content.blocks.length > 128) {
        throw new ChannelIntegrityError('Invalid richtext blocks')
      }
      const blocks = content.blocks.map(value => {
        const block = object(value)
        if (block.type === 'paragraph') {
          keys(block, ['type', 'nodes'])
          if (!Array.isArray(block.nodes) || block.nodes.length === 0 || block.nodes.length > 128) {
            throw new ChannelIntegrityError('Invalid richtext nodes')
          }
          const nodes: ChannelRichtextInline[] = block.nodes.map(value => {
            const node = object(value)
            if (node.type === 'mention') {
              keys(node, ['type', 'userId'])
              if (!validMentionUserId(node.userId)) throw new ChannelIntegrityError('Invalid mention identity')
              return { type: 'mention', userId: node.userId }
            }
            keys(node, ['type', 'text', 'style'])
            if (node.type !== 'text' || !['plain', 'strong', 'emphasis'].includes(String(node.style))) {
              throw new ChannelIntegrityError('Invalid richtext inline text')
            }
            return { type: 'text', text: text(node.text, 4096), style: node.style as 'plain' | 'strong' | 'emphasis' }
          })
          return { type: 'paragraph' as const, nodes }
        }
        keys(block, ['text', 'style'])
        if (!['plain', 'strong', 'emphasis', 'code'].includes(String(block.style))) {
          throw new ChannelIntegrityError('Invalid richtext style')
        }
        return { text: text(block.text, 4096), style: block.style as 'plain' | 'strong' | 'emphasis' | 'code' }
      })
      return { type: 'richtext', blocks }
    }
    default:
      throw new ChannelIntegrityError('Invalid outbound type')
  }
}
export function validMentionUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value)
    && !/^(?:all|everyone|here)$/iu.test(value)
}
export function richtextRequirements(content: ChannelOutboundContent): { paragraphs: boolean; userIds: string[] } {
  if (content.type !== 'richtext') return { paragraphs: false, userIds: [] }
  const paragraphs = content.blocks.filter(block => 'type' in block)
  return {
    paragraphs: paragraphs.length > 0,
    userIds: [
      ...new Set(
        paragraphs.flatMap(block => block.nodes.flatMap(node => node.type === 'mention' ? [node.userId] : [])),
      ),
    ],
  }
}
export function validateOutboundFallback(value: unknown): ChannelOutboundFallback {
  const fallback = object(value)
  if (fallback.mode === 'reject') {
    keys(fallback, ['mode'])
    return { mode: 'reject' }
  }
  if (fallback.mode === 'text') {
    keys(fallback, ['mode', 'text'])
    return { mode: 'text', text: text(fallback.text, 65536) }
  }
  throw new ChannelIntegrityError('Invalid outbound fallback')
}
