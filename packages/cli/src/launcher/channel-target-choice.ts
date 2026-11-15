import { randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChatExecutionSettings } from '../chat-execution-settings.js'

export type ChannelTargetAction = { readonly kind: 'unbind' } | {
  readonly kind: 'execution'
  readonly patch: ChatExecutionSettings
  readonly readOnly: boolean
}
const context = (event: ChannelEventRef) =>
  JSON.stringify([
    event.adapterId,
    event.accountId,
    event.tenantId,
    event.conversationId,
    event.actor?.userId,
  ])
const safe = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 120)

/** The choice is a continuation of an exact actor's operation, never a new permission grant. */
export class ChannelTargetChoices {
  private readonly choices = new Map<string, {
    readonly context: string
    readonly expiresAt: number
    readonly command: string
    readonly targets: readonly { id: string; name: string }[]
    readonly action: ChannelTargetAction
  }>()
  offer(
    event: ChannelEventRef,
    command: string,
    targets: readonly { id: string; name: string }[],
    action: ChannelTargetAction,
  ) {
    for (const [id, choice] of this.choices) if (choice.expiresAt <= Date.now()) this.choices.delete(id)
    if (!event.actor?.userId) throw new Error('CHANNEL_ACTOR_REQUIRED')
    if (this.choices.size >= 128) throw new Error('CHOICE_BUSY')
    const token = randomBytes(6).toString('hex')
    this.choices.set(token, { context: context(event), expiresAt: Date.now() + 10 * 60_000, command, targets, action })
    return `请选择本次 /${command} 的目标：\n${
      targets.map((target, index) => `${index + 1}. ${safe(target.name)}`).join('\n')
    }\n回复 /choose ${token} all 选择全部；或 /choose ${token} 1,2 选择一个或多个。选择有效期 10 分钟。`
  }
  take(event: ChannelEventRef, token: string, selected: string, currentIds: readonly string[]) {
    const choice = this.choices.get(token)
    if (!choice || choice.context !== context(event) || choice.expiresAt <= Date.now()) {
      throw new Error('CHOICE_EXPIRED')
    }
    const indexes = selected === 'all' ? choice.targets.map((_, index) => index + 1) : selected.split(',').map(Number)
    if (
      !indexes.length || indexes.some(index => !Number.isInteger(index) || index < 1 || index > choice.targets.length)
      || new Set(indexes).size !== indexes.length
    ) throw new Error('INVALID_CHOICE')
    const targets = indexes.map(index => choice.targets[index - 1]!)
    if (targets.some(target => !currentIds.includes(target.id))) throw new Error('CHOICE_TARGET_CHANGED')
    this.choices.delete(token)
    return { action: choice.action, command: choice.command, targets }
  }
  dispose() {
    this.choices.clear()
  }
}
