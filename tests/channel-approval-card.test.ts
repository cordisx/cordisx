import { describe, expect, it } from 'vitest'
import {
  channelApprovalCard,
  channelApprovalPreview,
  channelApprovalSummary,
} from '../packages/cli/src/launcher/channel-approval-card.js'

describe('compact Channel approval display', () => {
  it('keeps summary, status and decisions outside the default collapsed detail and removes terminal buttons', () => {
    const display = {
      id: 'aabbccdd',
      token: 'fixture',
      chat: '飞书 · 群聊',
      reason: 'Detailed reason',
      scope: 'Long command with parameters',
      summary: '发送频道消息',
      state: 'pending' as const,
      sessionApproval: false,
    }
    const card = channelApprovalCard(display) as any
    expect(card.config.wide_screen_mode).toBe(false)
    expect(card.elements[0].text.content).toContain('发送频道消息')
    expect(card.elements[0].text.content).not.toContain('Long command')
    expect(card.elements.find((item: any) => item.tag === 'collapsible_panel')).toMatchObject({
      expanded: false,
      elements: [{ text: { content: expect.stringContaining('Long command') } }],
    })
    expect(card.elements.find((item: any) => item.tag === 'action').actions.map((action: any) => action.value.decision))
      .toEqual(['accept', 'decline'])
    for (const state of ['submitted', 'resolved', 'cancelled', 'expired', 'unknown'] as const) {
      const terminal = channelApprovalCard({ ...display, state }) as any
      expect(terminal.elements.some((item: any) => item.tag === 'action')).toBe(false)
      expect(terminal.elements.find((item: any) => item.tag === 'note').elements[0].content).toBe('审批 aabbccdd')
    }
    expect(channelApprovalSummary('item/commandExecution/requestApproval', "node cli channel send --input '{}'")).toBe(
      '发送频道消息',
    )
  })

  it('redacts plain and escaped JSON, env and flags, including the transient context', () => {
    const json = JSON.stringify({
      apiKey: 'fixture-sensitive',
      cookie: 'fixture-sensitive',
      token: 'fixture-sensitive',
    })
    for (
      const value of [
        json,
        json.replaceAll('"', '\\"'),
        "COOKIE='fixture-sensitive' --context 'fixture-sensitive' --api-key=fixture-sensitive",
        '{"password":"fixture-sensitive\\"tail"}',
        'Bearer fixture-sensitive https://example.test/token',
      ]
    ) {
      expect(channelApprovalPreview(value, '')).not.toContain('fixture-sensitive')
    }
    expect(channelApprovalPreview('x'.repeat(5000), '')).toHaveLength(1500)
  })
})
