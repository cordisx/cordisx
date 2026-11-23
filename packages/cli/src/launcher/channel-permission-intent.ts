export type ChannelUserAccessEffect = 'allow' | 'deny' | 'reset'
const normal = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ')

function request(text: string | undefined): string | undefined {
  if (!text || text.length > 2048 || /[“”「」『』`\n\r]/u.test(text)) return undefined
  return text.trim().replace(/[。.!！]+$/u, '').replace(/(?:吧|一下|就行|就好)$/u, '').trim()
}

/** A single affirmative instruction, never a paraphrase supplied by the model. */
export function channelUserAccessIntent(text: string | undefined, effect: ChannelUserAccessEffect) {
  let value = request(text)
  if (!value) return undefined
  value = value.replace(/^(?:请|麻烦)?(?:帮我)?/u, '')
  const account = value.startsWith('在本账号')
  if (account) value = value.slice(4)
  value = value.replace(/^(?:在本群|在当前对话)/u, '')
  const patterns = {
    allow: /^(?:给|允许)\s*(.+?)\s*(?:授权|开白|加白|发起任务)$/u,
    deny: /^(?:禁止|拉黑)\s*(.+?)(?:\s*(?:发起任务|的任务权限))?$/u,
    reset: /^(?:恢复|重置)\s*(.+?)\s*(?:权限|的任务权限)$/u,
  }
  const match = patterns[effect].exec(value)
  const user = match?.[1]?.trim()
  // Avoid treating additional commands, qualifiers or quoted speech as a target.
  if (!user || /[,，;；!?？！"'<>]|不要|别|不许|其他群|所有人|然后|但是|他说/u.test(user)) return undefined
  return { user, account }
}

export function channelSameUserArgument(left: string, right: string): boolean {
  return normal(left) === normal(right)
}

export function channelGroupBlockIntent(text: string | undefined, blocked: boolean): boolean {
  const value = request(text)?.replace(/^(?:请|麻烦)?(?:帮我)?/u, '')
  if (!value) return false
  return (blocked
    ? /^(?:禁止|禁用|拉黑)(?:本群|这个群|当前群)(?:的)?(?:任务|任务权限|发起任务)?$/u
    : /^(?:恢复|解除禁止|解除禁用|解除拉黑)(?:本群|这个群|当前群)(?:的)?(?:任务|任务权限)?$/u).test(value)
}
