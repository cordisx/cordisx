import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationPolicy } from './channel-conversation-policy.js'
import { channelCommandDenied, channelPolicyAllows, channelPolicyDenied } from './channel-conversation-policy.js'

export interface OwnMemoryRecall {
  topics?: readonly string[]
  recentWork?: true
}

/** Interpret only the actual incoming request, never an Agent's query or claimed role. */
export function ownAdministratorRecall(request: string | undefined): OwnMemoryRecall | undefined {
  if (!request || request.length > 2048 || /["“”「」『』`\n\r]/u.test(request)) return undefined
  const text = request.trim().replace(/[。.!！?？]+$/u, '').trim()
  if (/^(?:别|不要|不用|不必|并非|不是|do not|don't|no need)/iu.test(text)) return undefined
  if (
    /^(?:你(?:还)?(?:记得|记不记得)?(?:自己)?(?:最近|近期)(?:都)?(?:做了|完成了|干了|处理了)(?:什么|哪些)(?:工作|任务|项目)?(?:吗|呢)?|(?:请)?(?:总结|回顾|告诉我|看看)(?:一下)?(?:你|我们|我)?(?:最近|近期)(?:的)?(?:工作|任务|项目)(?:进展|进度|情况)?|what (?:have you|did you) (?:worked on|do|complete)(?: recently)?|(?:summarize|review) (?:my|our|your) recent (?:work|tasks|projects))$/iu
      .test(text)
  ) return { recentWork: true }
  const chinese =
    /^(?:(?:请|麻烦)?(?:帮我)?(?:看看|查一下|告诉我|回顾一下)?)\s*(?:我的|我们(?:的)?)?([\p{L}\p{N}_ -]{2,64}?)(?:项目|任务|部署|工作)(?:的)?(?:现在|目前|当前)?(?:进度|进展|状态|情况|完成情况)(?:是什么|怎么样|如何|怎样|到哪了|吗|呢)?$/u
      .exec(text)
  const english =
    /^(?:what is|show|tell me|check|recall) (?:my |our )?([\p{L}\p{N}_ -]{2,64}?) (?:project|task|deployment) (?:progress|status)$/iu
      .exec(text)
  const subject = (chinese?.[1] ?? english?.[1])?.trim().toLowerCase()
  if (!subject || /^(?:这个|那个|其他|所有|全部|别人|他人|大家|the|all|other)(?:的|\s|$)/u.test(subject)) {
    return undefined
  }
  return { topics: [subject] }
}

/** Existing positive management grants establish the role; explicit task/send denies still win. */
export function channelMemoryAdministrator(
  policy: ChannelConversationPolicy,
  source: ChannelEventRef,
  sourceAdministrator = false,
): boolean {
  return policy.enabled && !!source.actor?.userId && source.actor.adapterId === source.adapterId
    && source.actor.accountId === source.accountId && source.actor.tenantId === source.tenantId
    && !channelPolicyDenied(policy, 'dispatch', source) && !channelPolicyDenied(policy, 'send', source)
    && ['allow-user', 'deny-user', 'reset-user'].every(command => !channelCommandDenied(policy, source, command))
    && (sourceAdministrator
      || ['allow-user', 'deny-user', 'reset-user'].every(command =>
        channelPolicyAllows(policy, 'command', source, command)
      ))
}

export function ownRecallMatches(
  record: { kind?: string; title?: string; tags?: string[]; summary?: string; keywords?: string; updatedAt?: string },
  recall: OwnMemoryRecall,
  now: string,
): boolean {
  const topic = [record.title, record.summary, record.keywords, ...(record.tags ?? [])].join(' ').toLowerCase()
  if (!['fact', 'conversation', 'collaboration'].includes(record.kind ?? '')) return false
  if (recall.topics) return recall.topics.some(word => topic.includes(word))
  // An overview is recent task knowledge, not a person's preference/profile or the complete private archive.
  return recall.recentWork === true
    && typeof record.updatedAt === 'string' && Date.parse(record.updatedAt) >= Date.parse(now) - 30 * 86400000
    && Date.parse(record.updatedAt) <= Date.parse(now)
    && /项目|任务|工作|进度|进展|部署|发布|实现|开发|修复|验收|测试|\b(?:project|task|work|progress|deploy\w*|release|implement\w*|develop\w*|fix|validat\w*|test\w*)\b/iu
      .test(topic)
}
