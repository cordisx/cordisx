import { ChannelIntegrityError } from './runtime-validation.js'

export type ChannelOutboundType = 'text' | 'image' | 'audio' | 'file' | 'video' | 'richtext' | 'card'
export type ChannelOutboundContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image' | 'audio' | 'file' | 'video'; readonly handle: string }
  | {
    readonly type: 'richtext'
    readonly blocks: readonly { readonly text: string; readonly style: 'plain' | 'strong' | 'emphasis' | 'code' }[]
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
