import { describe, expect, it } from 'vitest'
import { validateOutboundContent } from './outbound-content.js'
import { inlineCodeMarkdown, validateOutboundContentV3 } from './outbound-richtext-v3.js'

const richtext = (blocks: unknown[]) => ({ type: 'richtext', blocks })
const paragraph = (nodes: unknown[]) => ({ type: 'paragraph', nodes })

describe('typed richtext v3 validation', () => {
  it('preserves literal links, prepared handles and enumerated languages', () => {
    const content = richtext([
      paragraph([{ type: 'link', text: '**literal**', url: 'https://example.org/a#b' }, {
        type: 'image',
        handle: 'media:prepared',
      }]),
      { type: 'inline-code', text: '<at user_id="all">x</at>' },
      { type: 'code', text: 'const answer = 42', language: 'TYPESCRIPT' },
    ])
    expect(validateOutboundContentV3(content)).toEqual(content)
    expect(() => validateOutboundContent(content)).toThrow()
  })
  it.each([
    'javascript:alert(1)',
    'file:///tmp/a',
    '//example.org',
    'https://user:password@example.org',
    'https://@example.org',
    'https://example.org/bad%G0',
    'https://example.org/a\nb',
    'https://example.org\\evil',
    'https://',
  ])('rejects unsafe URL %s', url => {
    expect(() => validateOutboundContentV3(richtext([paragraph([{ type: 'link', text: 'label', url }])]))).toThrow()
  })
  it.each([
    paragraph([{ type: 'inline-code', text: 'not native mixed' }]),
    paragraph([{ type: 'image', handle: 'img_vendor_key' }]),
    paragraph([{ type: 'image', handle: 'media:valid', image_key: 'forged' }]),
    { type: 'inline-code', text: 'a\nb' },
    { type: 'code', text: 'a', language: 'arbitrary' },
  ])('rejects malformed successor structure', block => {
    expect(() => validateOutboundContentV3(richtext([block]))).toThrow()
  })
  it('bounds image count before effects', () => {
    const nodes = Array(17).fill({ type: 'image', handle: 'media:valid' })
    expect(() => validateOutboundContentV3(richtext([paragraph(nodes)]))).toThrow()
  })
  it('bounds aggregate bytes, text and nodes', () => {
    expect(() => validateOutboundContentV3(richtext(Array(17).fill({ text: 'x'.repeat(4096), style: 'plain' }))))
      .toThrow()
    expect(() =>
      validateOutboundContentV3(
        richtext(Array(9).fill(paragraph(Array(128).fill({ type: 'text', text: 'x', style: 'plain' })))),
      )
    ).toThrow()
    expect(() => validateOutboundContentV3(richtext(Array(17).fill({ text: '字'.repeat(4096), style: 'plain' }))))
      .toThrow()
  })
  it.each([
    'https://user%3Apass@example.org',
    'https://example.org/a%0Ab',
    'https://example.org/a%5cb',
    'https://%40evil.example.org',
  ])('rejects encoded unsafe URL %s', url => {
    expect(() => validateOutboundContentV3(richtext([paragraph([{ type: 'link', text: 'label', url }])]))).toThrow()
  })
  it('retains legacy content and mention validation', () => {
    const content = richtext([
      paragraph([{ type: 'mention', userId: 'ou_verified' }, { type: 'text', text: 'hello', style: 'plain' }]),
    ])
    expect(validateOutboundContentV3(content)).toEqual(content)
    expect(() => validateOutboundContentV3(richtext([paragraph([{ type: 'mention', userId: 'all' }])]))).toThrow()
  })
  it('generates only a literal CommonMark code span', () => {
    expect(inlineCodeMarkdown('x')).toBe('`x`')
    expect(inlineCodeMarkdown('`x`')).toBe('`` `x` ``')
    expect(inlineCodeMarkdown('  x  ')).toBe('`   x   `')
    expect(inlineCodeMarkdown('[link](javascript:x) <at user_id="all">')).toBe(
      '`[link](javascript:x) <at user_id="all">`',
    )
    expect(() => inlineCodeMarkdown('   ')).toThrow()
  })
})
