export interface ChannelApprovalDisplay {
  readonly id: string
  readonly chat: string
  readonly reason: string
  readonly scope: string
  readonly state: 'pending' | 'submitted' | 'resolved' | 'cancelled' | 'expired' | 'unknown'
  readonly token: string
}
export function channelApprovalCard(display: ChannelApprovalDisplay): object {
  const markdown = (value: string) => value.replace(/[\\`*_<>]/gu, char => `\\${char}`)
  const states = {
    pending: '等待批准',
    submitted: '决定已提交，等待原生确认',
    resolved: '已处理',
    cancelled: '已取消',
    expired: '已过期',
    unknown: '提交结果未知，请核对原生审批',
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: display.state === 'pending' ? 'orange' : 'grey',
      title: { tag: 'plain_text', content: `Codex 操作授权 · ${display.chat}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**申请原因**\n${markdown(display.reason)}\n\n**操作范围**\n${
            markdown(display.scope)
          }\n\n**状态**：${states[display.state]}`,
        },
      },
      ...(display.state === 'pending'
        ? [{
          tag: 'action',
          actions: [
            {
              tag: 'button',
              type: 'primary',
              text: { tag: 'plain_text', content: '批准这一次' },
              value: { channelApproval: display.token, decision: 'accept' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '本会话批准' },
              value: { channelApproval: display.token, decision: 'acceptForSession' },
            },
            {
              tag: 'button',
              type: 'danger',
              text: { tag: 'plain_text', content: '拒绝' },
              value: { channelApproval: display.token, decision: 'decline' },
            },
          ],
        }]
        : []),
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: `审批 ${display.id} · 也可回复 /approve ${display.id} once 或 /deny ${display.id}`,
        }],
      },
    ],
  }
}

/** Fixed bounded redaction for display; no raw request body, credential or URL is stored. */
export function channelApprovalPreview(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s]+)/giu,
      '$1=[redacted]',
    )
    .replace(
      /(--(?:[a-z0-9-]*(?:token|secret|password|api-key|authorization|cookie)[a-z0-9-]*))\s*(?:=|\s)\s*(?:'[^']*'|"[^"]*"|[^\s]+)/giu,
      '$1 [redacted]',
    )
    .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, '[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
    .slice(0, 1500)
}
