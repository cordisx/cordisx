import { randomUUID } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'

export interface ChannelCommandUser {
  readonly id: string
  readonly name: string
}
export interface ChannelCommandMention {
  readonly key: string
  readonly userId: string
  readonly name?: string
}
/** Minimal SDK addressing metadata; raw messages and credentials never enter this sidecar. */
export interface ChannelCommandAddressing {
  readonly mentions: readonly ChannelCommandMention[]
  readonly senderName?: string
}
export interface ChannelCommandUserReadback {
  readonly users: readonly ChannelCommandUser[]
  readonly complete: boolean
  readonly code?: string
}
export type ChannelCommandUserResolution =
  | { readonly userId: string }
  | { readonly message: string }

interface Choice {
  readonly context: string
  readonly expiresAt: number
  readonly users: readonly ChannelCommandUser[]
  readonly global: boolean
}
const normal = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
const safe = (value: string) => value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
export function channelCommandAddressing(message: {
  readonly senderName?: string
  readonly mentions?: readonly {
    readonly key: string
    readonly openId?: string
    readonly userId?: string
    readonly name?: string
    readonly isBot?: boolean
  }[]
}): ChannelCommandAddressing {
  return {
    mentions: (message.mentions ?? []).flatMap(mention => {
      const userId = mention.openId ?? mention.userId
      if (mention.isBot || !userId || !safe(userId) || !safe(mention.key) || mention.key === '@_all') return []
      return [{
        key: mention.key,
        userId,
        ...(mention.name && safe(mention.name) ? { name: mention.name } : {}),
      }]
    }),
    ...(message.senderName && safe(message.senderName) ? { senderName: message.senderName } : {}),
  }
}
const context = (event: ChannelEventRef, command: string, global: boolean, generation?: string) =>
  JSON.stringify([
    event.adapterId,
    event.accountId,
    event.tenantId,
    event.conversationId,
    event.actor?.userId,
    command,
    global,
    generation,
  ])

/** Candidate selection stays with the original actor, account, conversation, command and scope. */
export class ChannelCommandUsers {
  private readonly choices = new Map<string, Choice>()
  constructor(private readonly now: () => number = Date.now) {}

  async resolve(input: {
    readonly event: ChannelEventRef
    readonly command: string
    readonly argument: string
    readonly global: boolean
    readonly generation?: string
    readonly addressing?: ChannelCommandAddressing
    readonly directory?: () => Promise<ChannelCommandUserReadback>
  }): Promise<ChannelCommandUserResolution> {
    for (const [token, choice] of this.choices) {
      if (choice.expiresAt <= this.now()) this.choices.delete(token)
    }
    const raw = input.argument.trim()
    const choiceRequest = /^--(choose|list)\s+([\w-]+)\s+([1-9]\d*)$/u.exec(raw)
    if (choiceRequest) {
      const [, operation, token, number] = choiceRequest
      const choice = this.choices.get(token!)
      if (
        !input.event.actor || !choice
        || choice.context !== context(input.event, input.command, input.global, input.generation)
      ) {
        return { message: '选择已过期或不属于当前用户、会话、指令与范围，请重新输入用户名或 @ 提及。' }
      }
      if (operation === 'list') return { message: this.list(token!, choice, input.command, Number(number)) }
      const selected = choice.users[Number(number) - 1]
      if (!selected) return { message: '候选序号无效，请从列表选择。' }
      this.choices.delete(token!)
      return { userId: selected.id }
    }
    if (!safe(raw) || raw.startsWith('--')) {
      return { message: `用法：/${input.command} <用户 ID | @用户 | 用户名> [--global]` }
    }
    if (/^@(?:_all|all|所有人)$/iu.test(raw)) return { message: '请指定一个用户，不能使用 @所有人。' }
    const explicitId = raw.startsWith('id:')
      ? raw.slice(3)
      : /^@?ou_[A-Za-z0-9_]+$/u.test(raw)
      ? raw.replace(/^@/u, '')
      : undefined
    if (explicitId !== undefined) {
      return safe(explicitId) && !/\s/u.test(explicitId)
        ? { userId: explicitId }
        : { message: '用户 ID 无效。' }
    }
    const query = normal(raw.replace(/^@/u, '').replace(/^(["'])(.*)\1$/u, '$2'))
    if (!query) return { message: '请指定一个用户，不能使用 @所有人。' }
    const mentioned = new Map<string, ChannelCommandUser>()
    for (const mention of input.addressing?.mentions ?? []) {
      if (
        raw.startsWith('@')
        && (normal(mention.key.replace(/^@/u, '')) === query || mention.name && normal(mention.name) === query)
      ) mentioned.set(mention.userId, { id: mention.userId, name: mention.name ?? mention.userId })
    }
    if (mentioned.size === 1) return { userId: [...mentioned.keys()][0]! }
    if (mentioned.size > 1) return this.offer(input, [...mentioned.values()], false)
    let directory: ChannelCommandUserReadback
    try {
      directory = await input.directory?.() ?? { users: [], complete: false, code: 'CHANNEL_DIRECTORY_UNAVAILABLE' }
    } catch {
      directory = { users: [], complete: false, code: 'CHANNEL_DIRECTORY_FAILED' }
    }
    const users = [
      ...new Map(directory.users.filter(user => safe(user.id) && safe(user.name)).map(user => [user.id, user]))
        .values(),
    ]
    const byId = users.find(user => user.id === raw)
    if (byId) return { userId: byId.id }
    const exact = users.filter(user => normal(user.name) === query)
    if (directory.complete && exact.length === 1) return { userId: exact[0]!.id }
    const candidates = exact.length ? exact : users.filter(user => normal(user.name).includes(query))
    if (candidates.length) return this.offer(input, candidates, !directory.complete)
    return {
      message: directory.complete
        ? '没有找到匹配的用户，请使用完整用户名、原生 @ 提及或用户 ID。'
        : `用户列表未能完整读取（${
          directory.code && /^[A-Z_]+$/u.test(directory.code) ? directory.code : 'CHANNEL_DIRECTORY_UNAVAILABLE'
        }），请使用原生 @ 提及或用户 ID。`,
    }
  }

  private offer(
    input: {
      readonly event: ChannelEventRef
      readonly command: string
      readonly global: boolean
      readonly generation?: string
    },
    users: readonly ChannelCommandUser[],
    partial: boolean,
  ): ChannelCommandUserResolution {
    if (!input.event.actor) return { message: '无法确认当前操作用户，请使用原生 @ 提及或用户 ID。' }
    while (this.choices.size >= 64) this.choices.delete(this.choices.keys().next().value!)
    const token = randomUUID()
    const choice: Choice = {
      context: context(input.event, input.command, input.global, input.generation),
      expiresAt: this.now() + 10 * 60_000,
      users,
      global: input.global,
    }
    this.choices.set(token, choice)
    return {
      message: `${partial ? '用户列表未完整读取，请确认目标用户' : '请确认目标用户'}；名单尚未修改。\n${
        this.list(token, choice, input.command, 1)
      }`,
    }
  }

  private list(token: string, choice: Choice, command: string, page: number): string {
    const pages = Math.ceil(choice.users.length / 10)
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return '候选页码无效。'
    const offset = (page - 1) * 10, scope = choice.global ? ' --global' : ''
    return [
      ...choice.users.slice(offset, offset + 10).map((user, index) =>
        `${offset + index + 1}. @${user.name} (${user.id})`
      ),
      `选择：/${command} --choose ${token} <序号>${scope}（10 分钟内有效）`,
      ...(pages > 1 ? [`第 ${page}/${pages} 页；翻页：/${command} --list ${token} <页码>${scope}`] : []),
    ].join('\n')
  }
  dispose(): void {
    this.choices.clear()
  }
}
