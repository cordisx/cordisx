import type { ChannelOutboundContent, ChannelRichtextBlock, ChannelRichtextInline } from './outbound-content.js'
import { validateOutboundContent } from './outbound-content.js'
import { ChannelIntegrityError } from './runtime-validation.js'

export const codeLanguagesV3 = [
  'PYTHON',
  'C',
  'CPP',
  'GO',
  'JAVA',
  'KOTLIN',
  'SWIFT',
  'PHP',
  'RUBY',
  'RUST',
  'JAVASCRIPT',
  'TYPESCRIPT',
  'BASH',
  'SHELL',
  'SQL',
  'JSON',
  'XML',
  'YAML',
  'HTML',
  'THRIFT',
] as const
export type ChannelCodeLanguageV3 = typeof codeLanguagesV3[number]
export type ChannelRichtextInlineV3 =
  | ChannelRichtextInline
  | { readonly type: 'link'; readonly text: string; readonly url: string }
  | { readonly type: 'image'; readonly handle: string }
export type ChannelRichtextBlockV3 =
  | Exclude<ChannelRichtextBlock, { readonly type: 'paragraph' }>
  | { readonly type: 'paragraph'; readonly nodes: readonly ChannelRichtextInlineV3[] }
  | { readonly type: 'inline-code'; readonly text: string }
  | { readonly type: 'code'; readonly text: string; readonly language?: ChannelCodeLanguageV3 }
export type ChannelOutboundContentV3 =
  | Exclude<ChannelOutboundContent, { readonly type: 'richtext' }>
  | { readonly type: 'richtext'; readonly blocks: readonly ChannelRichtextBlockV3[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelIntegrityError('Invalid v3 node')
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ChannelIntegrityError('Invalid v3 fields')
}
function boundedText(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value.length || value.includes('\u0000') || Array.from(value).length > maximum) {
    throw new ChannelIntegrityError('Invalid v3 text')
  }
  return value
}
function safeUrl(value: unknown): string {
  const url = boundedText(value, 2048)
  if (
    /[\s\u0000-\u001f\u007f\\]/u.test(url) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(url) || !/^https?:\/\//u.test(url)
  ) {
    throw new ChannelIntegrityError('Invalid richtext link')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ChannelIntegrityError('Invalid richtext link')
  }
  if (!parsed.hostname || parsed.username || parsed.password) throw new ChannelIntegrityError('Invalid richtext link')
  return url
}

export function validateOutboundContentV3(value: unknown): ChannelOutboundContentV3 {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new ChannelIntegrityError('Invalid v3 content')
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 196608) {
    throw new ChannelIntegrityError('V3 content exceeds transport bound')
  }
  const content = record(value)
  if (content.type !== 'richtext') return validateOutboundContent(value)
  fields(content, ['type', 'blocks'])
  if (!Array.isArray(content.blocks) || !content.blocks.length || content.blocks.length > 128) {
    throw new ChannelIntegrityError('Invalid v3 blocks')
  }
  const blocks = content.blocks.map((value): ChannelRichtextBlockV3 => {
    const block = record(value)
    if (block.type === 'inline-code' || block.type === 'code') {
      fields(block, block.type === 'code' ? ['type', 'text', 'language'] : ['type', 'text'])
      const text = boundedText(block.text)
      if (block.type === 'inline-code') {
        if (/[\r\n\u0000]/u.test(text) || /^ +$/u.test(text)) throw new ChannelIntegrityError('Invalid inline code')
        return { type: 'inline-code', text }
      }
      if (block.language !== undefined && !codeLanguagesV3.includes(block.language as ChannelCodeLanguageV3)) {
        throw new ChannelIntegrityError('Invalid code language')
      }
      return {
        type: 'code',
        text,
        ...(block.language === undefined ? {} : { language: block.language as ChannelCodeLanguageV3 }),
      }
    }
    if (block.type === 'paragraph') {
      fields(block, ['type', 'nodes'])
      if (!Array.isArray(block.nodes) || !block.nodes.length || block.nodes.length > 128) {
        throw new ChannelIntegrityError('Invalid v3 paragraph')
      }
      return {
        type: 'paragraph',
        nodes: block.nodes.map((value): ChannelRichtextInlineV3 => {
          const node = record(value)
          if (node.type === 'link') {
            fields(node, ['type', 'text', 'url'])
            return { type: 'link', text: boundedText(node.text), url: safeUrl(node.url) }
          }
          if (node.type === 'image') {
            fields(node, ['type', 'handle'])
            const parsed = validateOutboundContent(node)
            if (parsed.type !== 'image') throw new ChannelIntegrityError('Invalid prepared image')
            return { type: 'image', handle: parsed.handle }
          }
          const parsed = validateOutboundContent({ type: 'richtext', blocks: [{ type: 'paragraph', nodes: [node] }] })
          if (parsed.type !== 'richtext' || !('type' in parsed.blocks[0]!)) {
            throw new ChannelIntegrityError('Invalid v3 node')
          }
          return parsed.blocks[0].nodes[0]!
        }),
      }
    }
    const parsed = validateOutboundContent({ type: 'richtext', blocks: [block] })
    if (parsed.type !== 'richtext') throw new ChannelIntegrityError('Invalid v3 block')
    return parsed.blocks[0]!
  })
  const images = blocks.flatMap(block =>
    'type' in block && block.type === 'paragraph'
      ? block.nodes.filter(node => node.type === 'image')
      : []
  )
  if (images.length > 16) throw new ChannelIntegrityError('Too many prepared images')
  let nodeCount = 0
  let textCount = 0
  for (const block of blocks) {
    if ('type' in block && block.type === 'paragraph') {
      nodeCount += block.nodes.length
      textCount += block.nodes.reduce((sum, node) => sum + ('text' in node ? Array.from(node.text).length : 0), 0)
    } else {
      nodeCount += 1
      textCount += Array.from(block.text).length
    }
  }
  if (nodeCount > 1024 || textCount > 65536) throw new ChannelIntegrityError('V3 richtext aggregate bound exceeded')
  return { type: 'richtext', blocks }
}

export function inlineCodeMarkdown(text: string): string {
  const block = validateOutboundContentV3({ type: 'richtext', blocks: [{ type: 'inline-code', text }] })
  if (block.type !== 'richtext') throw new ChannelIntegrityError('Invalid inline code')
  const runs = text.match(/`+/gu) ?? []
  const delimiter = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') && text.endsWith(' ')
  return `${delimiter}${pad ? ' ' : ''}${text}${pad ? ' ' : ''}${delimiter}`
}

export function richtextRequirementsV3(content: ChannelOutboundContentV3) {
  const paragraphs = content.type === 'richtext'
    ? content.blocks.filter(block => 'type' in block && block.type === 'paragraph')
    : []
  const nodes = paragraphs.flatMap(block => 'nodes' in block ? block.nodes : [])
  return {
    paragraphs: paragraphs.length > 0,
    userIds: [...new Set(nodes.flatMap(node => node.type === 'mention' ? [node.userId] : []))],
    imageHandles: [...new Set(nodes.flatMap(node => node.type === 'image' ? [node.handle] : []))],
  }
}

export function v3MentionContent(content: ChannelOutboundContentV3): ChannelOutboundContent | undefined {
  const userIds = richtextRequirementsV3(validateOutboundContentV3(content)).userIds
  return userIds.length
    ? { type: 'richtext', blocks: [{ type: 'paragraph', nodes: userIds.map(userId => ({ type: 'mention', userId })) }] }
    : undefined
}
