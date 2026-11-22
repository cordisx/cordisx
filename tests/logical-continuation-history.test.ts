import { describe, expect, it } from 'vitest'
import { projectLogicalHistory } from '../packages/cli/src/launcher/logical-continuation-history.js'

describe('scoped logical continuation history', () => {
  it('exposes only consented text and reports unavailable native categories without changing the source', () => {
    const source = [
      { type: 'userMessage', content: [{ type: 'text', text: 'question' }, { type: 'image', url: 'private' }] },
      { type: 'reasoning', content: ['private'], encryptedContent: 'private' },
      { type: 'agentMessage', text: 'answer' },
      { type: 'commandExecution', id: 'c1', command: 'private command', aggregatedOutput: 'private output' },
      { type: 'futureNativeItem', data: 'private' },
    ]
    const before = structuredClone(source)
    const result = projectLogicalHistory(source, ['user-text', 'assistant-text'])
    expect(result.entries).toEqual([{ category: 'user-text', text: 'question' }, {
      category: 'assistant-text',
      text: 'answer',
    }])
    expect(result.omitted).toEqual([
      'attachment',
      'raw-reasoning',
      'encrypted-reasoning',
      'unsupported',
      'not-authorized',
    ])
    expect(JSON.stringify(result)).not.toContain('private')
    expect(source).toEqual(before)
  })
  it('only returns selected tool fields and preserves call identity when tools are explicitly allowed', () => {
    const result = projectLogicalHistory([{
      type: 'mcpToolCall',
      id: 'call-1',
      server: 's',
      tool: 't',
      arguments: { query: 'q' },
      result: { text: 'a' },
      internalAuth: 'do-not-copy',
    }], ['tool'])
    expect(JSON.parse(result.entries[0]!.text)).toEqual({
      type: 'mcpToolCall',
      id: 'call-1',
      server: 's',
      tool: 't',
      arguments: { query: 'q' },
      result: { text: 'a' },
    })
    expect(JSON.stringify(result)).not.toContain('do-not-copy')
  })
  it('pages a long entry instead of silently dropping its leading text', () => {
    const items = [{ type: 'agentMessage', text: 'abcdefghij' }]
    const first = projectLogicalHistory(items, ['assistant-text'], { budget: 4 })
    expect(first.entries[0]?.text).toBe('…ghij')
    expect(first.truncated).toBe(true)
    const second = projectLogicalHistory(items, ['assistant-text'], { budget: 4, cursor: first.nextCursor })
    expect(second.entries[0]?.text).toBe('…cdef')
    const third = projectLogicalHistory(items, ['assistant-text'], { budget: 4, cursor: second.nextCursor })
    expect(third.entries[0]?.text).toBe('ab')
    expect(third.truncated).toBe(false)
  })
  it('rejects malformed native pages and unbounded or unconsented requests', () => {
    expect(() => projectLogicalHistory(Array(33).fill({ type: 'agentMessage', text: 'a' }), ['assistant-text']))
      .toThrow()
    expect(() => projectLogicalHistory([{ type: 'userMessage', content: null }], ['user-text'])).toThrow()
    expect(() => projectLogicalHistory([], [])).toThrow()
    expect(() => projectLogicalHistory([], ['tool'], { budget: 60_001 })).toThrow()
  })
})
