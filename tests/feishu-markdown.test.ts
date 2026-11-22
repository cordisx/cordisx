import { describe, expect, it } from 'vitest'
import { renderFeishuMarkdown } from '../packages/cli/src/launcher/feishu-markdown.js'

describe('Feishu outbound Markdown', () => {
  it('keeps ordinary text unchanged', () => {
    expect(renderFeishuMarkdown('Hello 😀')).toEqual({ msg_type: 'text', content: { text: 'Hello 😀' } })
  })

  it('uses standalone md paragraphs with supported syntax and readable headings', () => {
    expect(renderFeishuMarkdown('# Summary\r\n\r\n+ **done**\r\n1. [Docs](https://example.com)\r\n> quote\r\n~~old~~'))
      .toEqual({
        msg_type: 'post',
        content: {
          zh_cn: {
            title: '',
            content: [[{
              tag: 'md',
              text: '**Summary**\n\n- **done**\n1. [Docs](https://example.com)\n> quote\n~~old~~',
            }]],
          },
        },
      })
  })

  it('preserves code literally and maps language aliases without interpreting mentions or media', () => {
    expect(renderFeishuMarkdown('Before\n```ts\nconst value = "<at user_id="all">"\n```\nAfter')).toEqual({
      msg_type: 'post',
      content: {
        zh_cn: {
          title: '',
          content: [
            [{ tag: 'md', text: 'Before' }],
            [{ tag: 'code_block', language: 'TYPESCRIPT', text: 'const value = "<at user_id="all">"' }],
            [{ tag: 'md', text: 'After' }],
          ],
        },
      },
    })
  })

  it('supports longer fences and unknown languages as unhighlighted literal code', () => {
    expect(renderFeishuMarkdown('~~~~custom\n```\n~~~~')).toMatchObject({
      content: { zh_cn: { content: [[{ tag: 'code_block', text: '```' }]] } },
    })
  })

  it.each([
    '# Heading\n`inline`',
    '# Heading\n| A | B |',
    '**bold**\n![image](https://example.com/image.png)',
    '**bold**\n<at user_id="all">Everyone</at>',
    '```ts\nunclosed',
    '```bad info\ncode\n```',
  ])('falls back without losing unsupported content: %s', text => {
    expect(renderFeishuMarkdown(text)).toEqual({ msg_type: 'text', content: { text } })
  })

  it('falls back for oversized rich text without truncating or splitting delivery identity', () => {
    const text = '**bold**\n' + '😀'.repeat(7000)
    expect(renderFeishuMarkdown(text)).toEqual({ msg_type: 'text', content: { text } })
  })

  it('counts escaped UTF-8 payload bytes and rejects oversized plain text', () => {
    expect(() => renderFeishuMarkdown('😀'.repeat(36_000))).toThrow('FEISHU_TEXT_TOO_LARGE')
    expect(() => renderFeishuMarkdown('"'.repeat(40_000))).toThrow('FEISHU_TEXT_TOO_LARGE')
  })
})
