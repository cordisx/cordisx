import { createHash, randomBytes } from 'node:crypto'
import type { FeishuQuestionAction } from './feishu-card-action-queue.js'
import type {
  ChannelEventRef,
  ChannelPluginIdentity,
  ChannelTenantRef,
  ChannelThreadRef,
} from '@cordisx/channel-runtime'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelReplyMode, channelReplyTarget } from './channel-reply-routing.js'
import { sameConversation } from './channel-conversation-refs.js'
const sameQuestionConversation = (a: ChannelThreadRef, b: ChannelThreadRef) =>
  a.kind === b.kind && sameConversation(a, b)

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const questionDeliveryId = (caller: ChannelPluginIdentity, ref: ChannelTenantRef, operationId: string) =>
  `delivery:${hash([caller, ref, operationId])}`
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const text = (value: unknown, max: number, multiline = false): string => {
  if (
    typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /\0/u : /[\0\r\n]/u).test(value)
  ) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const exact = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
}
export interface ChannelQuestionRecord {
  readonly fingerprint: string
  readonly token: string
  readonly caller: ChannelPluginIdentity
  readonly target: ChannelThreadRef
  readonly question: string
  readonly options: readonly { readonly label: string; readonly value: string }[]
  readonly targetUserId?: string
  readonly expiresAt: number
  cancelled: boolean
}

/** Launcher-owned question records reference the normal persistent Channel outbox. */
export class ChannelQuestions {
  constructor(
    private readonly store: ChannelConversationStore,
    private readonly access: () => ChannelConversationAccess | undefined,
    private readonly wake: () => void,
  ) {}

  async ask(
    input: Record<string, unknown>,
    ref: ChannelTenantRef,
    caller: ChannelPluginIdentity,
    source?: ChannelEventRef,
  ) {
    exact(input, ['account', 'target', 'question', 'options', 'targetUserId', 'operationId', 'expiresInSeconds'])
    const operationId = text(input.operationId, 128)
    const raw = object(input.target)
    exact(raw, ['id', 'kind', 'replyMode', 'replyTo'])
    const id = text(raw.id, 512), kind = raw.kind
    const card = ['feishu', 'lark'].includes(ref.adapterId)
    if (card && !/^oc_[A-Za-z0-9_]+$/u.test(id) || !['direct', 'group'].includes(String(kind))) {
      throw new Error('INVALID_TARGET')
    }
    const replyTo = raw.replyTo === undefined ? undefined : text(raw.replyTo, 512)
    if (card && replyTo && !/^om_[A-Za-z0-9_]+$/u.test(replyTo)) throw new Error('INVALID_TARGET')
    const mode = raw.replyMode === undefined ? replyTo ? 'reply' : 'conversation' : channelReplyMode(raw.replyMode)
    if (mode === 'none' || mode === 'agent' || mode === 'conversation' && replyTo) throw new Error('INVALID_REPLY_MODE')
    const target = channelReplyTarget({
      ...ref,
      conversationId: id,
      kind: kind as 'direct' | 'group',
      threadId: id,
      semantics: 'conversation',
      eventId: operationId,
      ...(replyTo ? { messageId: replyTo } : {}),
    }, mode)
    const question = text(input.question, 1000, true)
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 5) {
      throw new Error('INVALID_REQUEST')
    }
    const options = input.options.map(value => {
      const option = object(value)
      exact(option, ['label', 'value'])
      return { label: text(option.label, 80), value: text(option.value, 512, true) }
    })
    const targetUserId = input.targetUserId === undefined ? undefined : text(input.targetUserId, 512)
    if (targetUserId && !card) throw new Error('QUESTION_TARGET_USER_UNSUPPORTED')
    if (targetUserId && !/^ou_[A-Za-z0-9_]+$/u.test(targetUserId)) throw new Error('INVALID_TARGET')
    const duration = input.expiresInSeconds ?? 86400
    if (!Number.isSafeInteger(duration) || Number(duration) < 60 || Number(duration) > 604800) {
      throw new Error('INVALID_REQUEST')
    }
    const current = this.access()
    if (!current) throw new Error('CHANNEL_NOT_CONFIGURED')
    const state = this.store.snapshot()
    if (
      !state.policy.enabled
      || !channelPolicyAllows(state.policy, 'send', {
        ...target,
        eventId: operationId,
        ...(source?.actor ? { actor: source.actor } : {}),
      })
    ) {
      throw new Error('CHANNEL_POLICY_DENIED')
    }
    if (
      !Object.values(state.bindings).some(binding =>
        binding.state === 'active' && binding.mode === 'deliver' && sameQuestionConversation(binding.channel, target)
      ) && !(source && sameQuestionConversation(source, target))
    ) {
      throw new Error('QUESTION_TARGET_NOT_BOUND')
    }
    const deliveryId = questionDeliveryId(caller, ref, operationId)
    const fingerprint = hash([target, question, options, targetUserId ?? null, duration])
    const record = await this.store.mutate(state => {
      const prior = state.questions[deliveryId]
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('OPERATION_CONFLICT')
        return prior
      }
      const created: ChannelQuestionRecord = {
        fingerprint,
        token: randomBytes(32).toString('hex'),
        caller,
        target,
        question,
        options,
        ...(targetUserId ? { targetUserId } : {}),
        expiresAt: Date.now() + Number(duration) * 1000,
        cancelled: false,
      }
      state.questions[deliveryId] = created
      return created
    })
    if (record.cancelled || record.expiresAt <= Date.now()) throw new Error('QUESTION_INACTIVE')
    const body = `${question}\n${
      options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')
    }\n也可发送文字回答；群聊请 @机器人或使用唤醒词。`
    const notification = { target, kind: 'reply' as const, text: body }
    try {
      if (card) {
        await current.runtime.notifyQuestionOnce(notification, caller, deliveryId, {
          token: record.token,
          question,
          options: options.map(option => option.label),
        })
      } else await current.runtime.notifyOnce(notification, caller, deliveryId)
      if (this.access()?.generation !== current.generation) throw new Error('CHANNEL_GENERATION_CHANGED')
      await current.drain(ref)
    } catch (error) {
      if (error instanceof Error && error.message === 'Operation conflict') throw new Error('OPERATION_CONFLICT')
      if (error instanceof Error && error.name === 'ChannelPermissionError') {
        throw new Error('CHANNEL_PERMISSION_DENIED')
      }
      return {
        status: 'partial',
        generation: current.generation,
        operationId,
        deliveryState: 'unknown',
        code: error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'CHANNEL_EFFECT_UNCERTAIN',
      }
    }
    const receipt = current.runtime.deliverySnapshot(deliveryId, caller) ?? null
    return {
      status: 'ok',
      generation: current.generation,
      operationId,
      presentation: card ? 'card' : 'numbered-text',
      deliveryState: !receipt ? 'unknown' : receipt.state === 'sent'
        ? 'sent'
        : receipt?.state === 'dead-letter' || receipt?.state === 'cancelled'
        ? 'failed'
        : 'pending',
      receipt,
    }
  }

  async cancel(input: Record<string, unknown>, ref: ChannelTenantRef, caller: ChannelPluginIdentity) {
    exact(input, ['account', 'operationId'])
    const operationId = text(input.operationId, 128), id = questionDeliveryId(caller, ref, operationId)
    const found = await this.store.mutate(state => {
      const record = state.questions[id]
      if (!record) return false
      record.cancelled = true
      return true
    })
    if (!found) throw new Error('QUESTION_NOT_FOUND')
    return { status: 'ok', operationId, state: 'cancelled' }
  }

  async action(ref: ChannelTenantRef, action: FeishuQuestionAction): Promise<boolean> {
    const value = action.action.value as Record<string, unknown> | undefined
    const form = action.action.name === 'channel_question_submit'
    if (!form && (!value || typeof value.channelQuestion !== 'string')) return false
    if (form && action.action.tag !== 'button') return true
    if (!['feishu', 'lark'].includes(ref.adapterId)) return true
    const actor = action.operator.openId, index = value?.option
    if (typeof actor !== 'string' || !/^ou_[A-Za-z0-9_]+$/u.test(actor)) return true
    if (
      form ? typeof action.questionText !== 'string' : typeof value?.channelQuestion !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.channelQuestion) || !Number.isSafeInteger(index)
    ) return true
    const entry = Object.entries(this.store.snapshot().questions).find(([id, q]) => {
      if (
        q.target.adapterId !== ref.adapterId || q.target.accountId !== ref.accountId
        || q.target.tenantId !== ref.tenantId
        || q.target.conversationId !== action.chatId || !form && q.token !== value?.channelQuestion
      ) return false
      const receipt = this.access()?.runtime.deliverySnapshot(id, q.caller)
      return receipt?.state === 'sent' && receipt.externalMessageId === action.messageId
    })
    if (!entry) return true
    const [deliveryId, q] = entry
    const event: ChannelEventRef = {
      ...q.target,
      eventId: `question:${hash([deliveryId, actor])}`,
      messageId: action.messageId,
      actor: { ...ref, userId: actor },
    }
    const recordId = `question:${hash([deliveryId, actor])}`
    await this.store.mutate(state => {
      const current = state.questions[deliveryId]
      const answer = form ? action.questionText : current?.options[Number(index)]?.value
      if (
        !current || current.cancelled || current.expiresAt <= Date.now() || !answer
        || current.targetUserId && current.targetUserId !== actor
      ) return
      if (state.inputs[recordId]) return
      state.inputs[recordId] = {
        recordId,
        input: {
          contract: 'cordisx.channel-user-input/v1',
          schemaVersion: 1,
          role: 'user',
          content: [{ type: 'text', text: `问题「${current.question}」的回答：${answer}` }],
          source: { kind: 'channel', event },
          receivedAt: new Date().toISOString(),
        },
        mentionedBot: true,
        sequence: state.nextSequence++,
        persisted: true,
        accepted: false,
        routed: false,
      }
    })
    this.wake()
    return true
  }
}
