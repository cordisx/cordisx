export interface ChannelApprovalDisplay {
  readonly id: string
  readonly chat: string
  readonly reason: string
  readonly scope: string
  readonly statusText?: string
  readonly summary?: string
  readonly requester?: string
  readonly sessionApproval?: boolean
  readonly state: 'pending' | 'submitted' | 'resolved' | 'cancelled' | 'expired' | 'unknown'
  readonly token: string
}
export function channelApprovalCard(display: ChannelApprovalDisplay): object {
  const markdown = (value: string) => channelApprovalPreview(value, '').replace(/[\\`*_<>]/gu, char => `\\${char}`)
  const states = {
    pending: '等待批准',
    submitted: '决定已提交，等待原生确认',
    resolved: '已处理',
    cancelled: '已取消',
    expired: '已过期',
    unknown: '提交结果未知，请核对原生审批',
  }
  return {
    config: { wide_screen_mode: false, update_multi: true },
    header: {
      template: display.state === 'pending' ? 'orange' : 'grey',
      title: {
        tag: 'plain_text',
        content: `Codex 操作授权 · ${channelApprovalPreview(display.chat, 'Codex 对话').slice(0, 80)}`,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${display.requester ? `**申请人**：${markdown(display.requester)}\n` : ''}${
            markdown(channelApprovalPreview(display.summary ?? display.reason, '操作授权').slice(0, 180))
          }\n**状态**：${markdown(display.statusText ?? states[display.state])}`,
        },
      },
      {
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: '操作详情' },
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        elements: [{
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**原因**\n${markdown(display.reason)}\n\n**范围与参数**\n${markdown(display.scope)}`,
          },
        }],
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
            ...(display.sessionApproval === false ? [] : [{
              tag: 'button',
              text: { tag: 'plain_text', content: '本会话批准' },
              value: { channelApproval: display.token, decision: 'acceptForSession' },
            }]),
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
          content: display.state !== 'pending'
            ? `审批 ${display.id}`
            : display.sessionApproval === false
            ? `审批 ${display.id} · /task-approve ${display.id} 或 /task-deny ${display.id}`
            : `审批 ${display.id} · /approve ${display.id} once 或 /deny ${display.id}`,
        }],
      },
    ],
  }
}

/** Fixed bounded redaction for display; no raw request body, credential or URL is stored. */
export function channelApprovalPreview(value: unknown, fallback: string): string {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) value = value.join(' ')
  if (typeof value !== 'string' || !value.trim()) return fallback
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CONTEXT)[A-Z0-9_]*)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s]+)/giu,
      '$1=[redacted]',
    )
    .replace(
      /(--(?:context|[a-z0-9-]*(?:token|secret|password|api-key|authorization|cookie)[a-z0-9-]*))\s*(?:=|\s)\s*(?:'[^']*'|"[^"]*"|[^\s]+)/giu,
      '$1 [redacted]',
    )
    .replace(
      /((?:\\?["'])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|channelContext)(?:\\?["'])?\s*:\s*)(?:\\?"(?:\\.|[^"\\])*\\?"|'[^']*'|[^,}\s]+)/giu,
      '$1[redacted]',
    )
    .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, '[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
    .slice(0, 1500)
}

/** Expose purpose, never the full shell/JSON payload, in the always-visible summary. */
export function channelApprovalSummary(method: unknown, command: unknown): string {
  if (method === 'item/fileChange/requestApproval') return '修改文件'
  const text = Array.isArray(command)
    ? command.filter(value => typeof value === 'string').join(' ')
    : typeof command === 'string'
    ? command
    : ''
  const operation =
    /\bchannel\s+(send-many|send|connections|conversations|history|listen|receipt|model-list|task-settings-set|task-settings|task-config-set|task-config|bind|unbind)\b/u
      .exec(text)?.[1]
  const labels: Record<string, string> = {
    send: '发送频道消息',
    'send-many': '发送多条频道消息',
    connections: '查询频道账号',
    conversations: '查询频道对话',
    history: '查询频道消息',
    listen: '监听频道消息',
    receipt: '查询发送回执',
    'model-list': '查询可用模型',
    'task-settings': '查询对话配置',
    'task-settings-set': '修改对话模型配置',
    'task-config': '查询默认配置',
    'task-config-set': '修改默认配置',
    bind: '绑定频道对话',
    unbind: '解除频道绑定',
  }
  return operation ? labels[operation]! : '执行命令'
}
