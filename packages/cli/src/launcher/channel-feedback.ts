import { randomInt } from 'node:crypto'
import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelReplyDefaults, channelReplyTarget } from './channel-reply-routing.js'
import { type ChannelFeedbackSettings } from './channel-feedback-settings.js'

export interface ChannelReactionReceipt {
  reactionId: string
  emojiType?: string
  removed?: boolean
}

type Entry = {
  recordId: string
  event: ChannelEventRef
  since: number
  generation: string
  replied: boolean
  timer?: ReturnType<typeof setTimeout>
}
type Options = {
  store: Pick<ChannelConversationStore, 'snapshot' | 'mutate'>
  access(): ChannelConversationAccess | undefined
  turnState(sessionId: string, turnId: string): Promise<string>
  settings(): Promise<ChannelFeedbackSettings>
  signal: AbortSignal
  report?(code: string): void
  now?: () => number
  randomIndex?: (length: number) => number
}
/** Best-effort feedback for accepted routed inputs; native work and transport replies never wait for it. */
export class ChannelFeedback {
  private readonly pending = new Map<string, Entry>()
  private readonly subscriptions = new Map<object, () => void>()
  private readonly now: () => number
  private disposed = false
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
  }
  private diagnostic(code: string) {
    try {
      this.options.report?.(code)
    } catch { /* feedback cannot block work */ }
  }
  private jobs(state: ChannelConversationState, id: string) {
    return Object.values(state.jobs).filter(job =>
      job.recordId === id && ['queued', 'dispatching', 'running'].includes(job.state)
      && job.creationReason !== 'bind-command' && (!job.bindingId || state.bindings[job.bindingId]?.state === 'active')
    )
  }
  private permitted(state: ChannelConversationState, event: ChannelEventRef) {
    return state.policy.enabled && channelPolicyAllows(state.policy, 'dispatch', event)
      && channelPolicyAllows(state.policy, 'send', event)
  }
  private alive(entry: Entry) {
    return !this.disposed && !this.options.signal.aborted && !entry.replied
      && this.pending.get(entry.recordId) === entry
      && this.options.access()?.generation === entry.generation
  }
  private finish(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    if (this.pending.get(entry.recordId) === entry) this.pending.delete(entry.recordId)
  }
  private arm(entry: Entry, delay: number) {
    if (!this.alive(entry)) {
      this.finish(entry)
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void this.deadline(entry).catch(() => {
        this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED')
        this.finish(entry)
      })
    }, Math.max(0, delay))
    entry.timer.unref?.()
  }
  sync() {
    const access = this.options.access()
    if (access && !this.subscriptions.has(access.runtime) && typeof access.runtime.observeOutbound === 'function') {
      for (const remove of this.subscriptions.values()) remove()
      this.subscriptions.clear()
      this.subscriptions.set(access.runtime, access.runtime.observeOutbound(target => this.outbound(target)))
    }
    for (const entry of this.pending.values()) {
      if (!this.alive(entry) || !this.jobs(this.options.store.snapshot(), entry.recordId).length) this.finish(entry)
    }
  }
  async routed(recordId: string) {
    if (this.disposed || this.options.signal.aborted || this.pending.has(recordId)) return
    this.sync()
    const state = this.options.store.snapshot(),
      event = state.inputs[recordId]?.input.source.event,
      access = this.options.access()
    if (
      !event || !access || !['feishu', 'lark'].includes(event.adapterId) || !this.jobs(state, recordId).length
      || !this.permitted(state, event)
    ) return
    const entry: Entry = { recordId, event, since: this.now(), generation: access.generation, replied: false }
    this.pending.set(recordId, entry)
    try {
      const fresh = await this.options.store.mutate(state => {
        const input = state.inputs[recordId]
        if (!input || input.feedback || !this.jobs(state, recordId).length || !this.permitted(state, event)) {
          return false
        }
        input.feedback = { since: entry.since, reactionAttempted: true, waitAttempted: false, replyObserved: false }
        return true
      })
      if (!fresh || !this.alive(entry)) {
        this.finish(entry)
        return
      }
      const config = await this.options.settings()
      if (!this.alive(entry) || !this.jobs(this.options.store.snapshot(), recordId).length) {
        this.finish(entry)
        return
      }
      if (config.reaction.enabled) {
        void this.options.access()?.feedbackReact?.(event, config.reaction.emojiType).then(async receipt => {
          if (receipt) {
            await this.options.store.mutate(state => {
              const feedback = state.inputs[recordId]?.feedback
              if (feedback) feedback.reaction = receipt
            })
          }
        }).catch(() => this.diagnostic('CHANNEL_FEEDBACK_REACTION_FAILED'))
      }
      if (config.wait.enabled) this.arm(entry, entry.since + config.wait.delaySeconds * 1000 - this.now())
      else this.finish(entry)
    } catch {
      this.diagnostic('CHANNEL_FEEDBACK_UNAVAILABLE')
      this.finish(entry)
    }
  }
  jobUpdated(_recordId: string) {
    this.sync()
  }
  async catchup() {
    for (
      const record of Object.values(this.options.store.snapshot().inputs).filter(record =>
        record.feedback?.reaction && !record.feedback.completionAttempted
      ).slice(0, 100)
    ) {
      await this.completed(record.recordId).catch(() => this.diagnostic('CHANNEL_FEEDBACK_COMPLETION_UNKNOWN'))
    }
  }
  async completed(recordId: string) {
    const state = this.options.store.snapshot(), record = state.inputs[recordId]
    const jobs = Object.values(state.jobs).filter(job => job.recordId === recordId)
    if (
      !record?.feedback?.reaction || record.feedback.completionAttempted || !jobs.length
      || jobs.some(job => job.state !== 'completed') || !this.permitted(state, record.input.source.event)
    ) return
    const config = await this.options.settings(), emoji = config.reaction.completionEmojiType
    if (!config.reaction.enabled || !emoji) return
    const reserved = await this.options.store.mutate(state => {
      const feedback = state.inputs[recordId]?.feedback
      if (!feedback || feedback.completionAttempted) return false
      feedback.completionAttempted = true
      return true
    })
    if (!reserved) return
    const access = this.options.access(), event = record.input.source.event
    if (!access?.feedbackRemove || !access.feedbackReact) throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE')
    await access.feedbackRemove(event, record.feedback.reaction.reactionId)
    const receipt = await access.feedbackReact(event, emoji)
    await this.options.store.mutate(state => {
      const feedback = state.inputs[recordId]?.feedback
      if (feedback) feedback.completion = receipt
    })
  }
  private outbound(target: ChannelThreadRef) {
    for (const entry of this.pending.values()) {
      if (
        !['adapterId', 'accountId', 'tenantId'].every(key =>
          entry.event[key as keyof ChannelEventRef] === target[key as keyof ChannelThreadRef]
        )
      ) continue
      if (
        entry.event.conversationId !== target.conversationId
        && !(entry.event.kind === 'direct' && entry.event.actor?.userId === target.conversationId)
      ) continue
      entry.replied = true
      this.finish(entry)
      void this.options.store.mutate(state => {
        const row = state.inputs[entry.recordId]?.feedback
        if (row) row.replyObserved = true
      }).catch(() => this.diagnostic('CHANNEL_FEEDBACK_STORE_UNAVAILABLE'))
    }
  }
  private async activeJob(entry: Entry) {
    const state = this.options.store.snapshot()
    if (!this.alive(entry) || !this.permitted(state, entry.event)) return undefined
    for (const job of this.jobs(state, entry.recordId)) {
      if (job.state === 'queued') return job
      if (job.state !== 'running' || !job.sessionId || !job.turnId) continue
      const takeover = state.liveTakeovers[job.sessionId]
      if (takeover && !['preparing', 'ready', 'abandoned'].includes(takeover.state)) continue
      if (await this.options.turnState(job.sessionId, job.turnId) === 'active' && this.alive(entry)) return job
    }
    return undefined
  }
  private async deadline(entry: Entry) {
    if (!this.alive(entry)) {
      this.finish(entry)
      return
    }
    const config = await this.options.settings()
    if (!config.wait.enabled) {
      this.finish(entry)
      return
    }
    const remaining = entry.since + config.wait.delaySeconds * 1000 - this.now()
    if (remaining > 0) {
      this.arm(entry, remaining)
      return
    }
    const job = await this.activeJob(entry)
    if (!job) {
      this.finish(entry)
      return
    }
    const reserved = await this.options.store.mutate(state => {
      const feedback = state.inputs[entry.recordId]?.feedback, current = state.jobs[job.id]
      if (
        !feedback || feedback.waitAttempted || feedback.replyObserved || !current || current.state !== job.state
        || current.turnId !== job.turnId || current.sessionId !== job.sessionId
        || !this.jobs(state, entry.recordId).some(row => row.id === job.id)
        || !this.permitted(state, entry.event)
      ) return false
      feedback.waitAttempted = true
      return true
    })
    const final = reserved && this.alive(entry) ? await this.activeJob(entry) : undefined
    if (!final || !this.alive(entry)) {
      this.finish(entry)
      return
    }
    const state = this.options.store.snapshot(), binding = final.bindingId ? state.bindings[final.bindingId] : undefined
    const current = state.jobs[final.id]
    if (
      !current || current.state !== final.state || current.sessionId !== final.sessionId
      || current.turnId !== final.turnId || !this.permitted(state, entry.event)
    ) {
      this.finish(entry)
      return
    }
    const defaults = final.replyDefaults ?? channelReplyDefaults(state.policy, entry.event, binding)
    const mode = final.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode)
    if (mode === 'none') {
      this.finish(entry)
      return
    }
    const choices = config.wait.texts ?? [config.wait.text],
      index = (this.options.randomIndex ?? randomInt)(choices.length)
    if (!Number.isInteger(index) || !choices[index]) throw new Error('INVALID_FEEDBACK_CONFIG')
    if (this.alive(entry)) {
      void this.options.access()?.feedbackWait?.(
        entry.event,
        channelReplyTarget(entry.event, mode),
        choices[index]!,
        entry.recordId,
      ).catch(() => this.diagnostic('CHANNEL_FEEDBACK_WAIT_FAILED'))
    }
    this.finish(entry)
  }
  dispose() {
    this.disposed = true
    for (const entry of this.pending.values()) this.finish(entry)
    for (const remove of this.subscriptions.values()) remove()
    this.subscriptions.clear()
  }
}
