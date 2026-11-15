export const CHANNEL_COMMAND_DEFINITIONS = [
  { name: 'help', usage: '/help [指令]', summary: '查看可用指令或某条指令的参数。', readOnly: true },
  {
    name: 'bind',
    usage: '/bind <对话 ID> | /bind new',
    summary: '绑定现有 Codex 对话，或创建并绑定一个新对话。',
    readOnly: false,
  },
  {
    name: 'unbind',
    usage: '/unbind [对话 ID | --all]',
    summary: '解除绑定；多个目标时先选择，不删除 Codex 对话。',
    readOnly: false,
  },
  { name: 'bind-status', usage: '/bind-status', summary: '查看当前私聊或群聊绑定的对话。', readOnly: true },
  { name: 'messages-on', usage: '/messages-on [--global]', summary: '恢复消息投递。', readOnly: false },
  { name: 'messages-off', usage: '/messages-off [--global]', summary: '暂停消息投递，仍保留记录。', readOnly: false },
  { name: 'messages-status', usage: '/messages-status', summary: '查看接收与投递状态。', readOnly: true },
  {
    name: 'allow-user',
    usage: '/allow-user <@用户 | 用户名 | 用户 ID> [--global]',
    summary: '添加允许用户；同名时提供候选。',
    readOnly: false,
  },
  {
    name: 'deny-user',
    usage: '/deny-user <@用户 | 用户名 | 用户 ID> [--global]',
    summary: '拒绝指定用户的消息投递。',
    readOnly: false,
  },
  {
    name: 'reset-user',
    usage: '/reset-user <@用户 | 用户名 | 用户 ID> [--global]',
    summary: '移除该用户的消息规则。',
    readOnly: false,
  },
  {
    name: 'wake',
    usage: '/wake <前缀 | --clear> [--global]',
    summary: '设置唤醒前缀；接收全部群消息时生效。',
    readOnly: false,
  },
  {
    name: 'permissions',
    usage:
      '/permissions [inherit | read-only | workspace-write | full-access] [--approval inherit|untrusted|on-request|never] [--target ID | --all]',
    summary: '读取或保存对话执行权限与审批策略；下一 turn 应用。',
    readOnly: false,
  },
  {
    name: 'work-mode',
    usage: '/work-mode [inherit | default | plan] [--effort inherit|low|medium|high|max] [--target ID | --all]',
    summary: '读取或保存执行／Plan 模式及思考强度。',
    readOnly: false,
  },
  {
    name: 'choose',
    usage: '/choose <选择码> <all | 序号[,序号]>',
    summary: '继续你发起的目标选择，不替其他用户选择。',
    readOnly: false,
  },
  {
    name: 'approve',
    usage: '/approve [审批编号] [once | session]',
    summary: '批准对应原生请求；需要当前用户的审批权限。',
    readOnly: false,
  },
  { name: 'deny', usage: '/deny [审批编号]', summary: '拒绝对应原生请求；需要当前用户的审批权限。', readOnly: false },
  { name: 'approvals', usage: '/approvals', summary: '查看当前频道会话的待处理请求。', readOnly: true },
] as const
export const CHANNEL_COMMAND_NAMES = CHANNEL_COMMAND_DEFINITIONS.map(item => item.name)
export function channelCommandHelp(name?: string, allowed: (command: string) => boolean = () => true): string {
  const command = name?.trim().replace(/^\//u, '')
  const rows = command
    ? CHANNEL_COMMAND_DEFINITIONS.filter(item => item.name === command)
    : CHANNEL_COMMAND_DEFINITIONS.filter(item => allowed(item.name))
  if (!rows.length) return `未找到指令 ${command ?? ''}。用 /help 查看可用指令。`
  return rows.map(item =>
    `${item.usage}\n${item.summary}${allowed(item.name) ? '' : '\n当前用户没有执行此指令的权限。'}`
  ).join('\n\n')
}
