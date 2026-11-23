import { channelDispatchAllowed } from './channel-group-access.js'
import { randomInt } from 'node:crypto'
import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelReplyDefaults, channelReplyTarget } from './channel-reply-routing.js'
import { type ChannelFeedbackSettings } from './channel-feedback-settings.js'
import { ChannelStoppedFeedback } from './channel-feedback-stopped.js'

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
  private readonly initializing = new Map<string, Promise<void>>()
  private readonly fresh = new Set<string>()
  private readonly receiptOwners = new Map<string, { generation: string; reactionId: string }>()
  private readonly subscriptions = new Map<object, () => void>()
  private readonly now: () => number
  private readonly stopped: ChannelStoppedFeedback
  private disposed = false
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    this.stopped = new ChannelStoppedFeedback(options)
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
    return state.policy.enabled && channelDispatchAllowed(state, event)
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
  /** Acknowledge only accepted, addressed input; the external HTTP request never gates routing. */
  async received(recordId: string): Promise<void> {
    const pending = this.initializing.get(recordId)
    if (pending) return pending
    const initializing = this.initializeReceived(recordId)
    this.initializing.set(recordId, initializing)
    try {
      await initializing
    } finally {
      if (this.initializing.get(recordId) === initializing) this.initializing.delete(recordId)
    }
  }
  private async initializeReceived(recordId: string) {
    const state = this.options.store.snapshot(),
      record = state.inputs[recordId],
      event = record?.input.source.event,
      access = this.options.access()
    if (
      this.disposed || this.options.signal.aborted || !record?.accepted || !event || !access
      || !['feishu', 'lark'].includes(event.adapterId) || !this.permitted(state, event)
    ) return
    const claimed = await this.options.store.mutate(current => {
      const input = current.inputs[recordId]
      if (!input || !input.accepted || input.feedback || !this.permitted(current, event)) return false
      input.feedback = {
        since: this.now(),
        reactionAttempted: false,
        receivedAttempted: true,
        waitAttempted: false,
        replyObserved: false,
      }
      return true
    })
    if (!claimed) return
    this.fresh.add(recordId)
    if (this.fresh.size > 1024) this.fresh.delete(this.fresh.values().next().value!)
    const config = await this.options.settings()
    if (
      (config.reaction.stoppedEnabled ?? false) && !this.disposed && !this.options.signal.aborted
      && this.options.access()?.generation === access.generation
    ) this.stopped.accepted(recordId, access.generation, config.reaction.stoppedEmojiType ?? 'DONE')
    if (
      !(config.reaction.receivedEnabled ?? config.reaction.enabled) || this.disposed || this.options.signal.aborted
      || this.options.access()?.generation !== access.generation
    ) return
    const request = access.feedbackReact?.(event, config.reaction.receivedEmojiType ?? 'Get')
    if (!request) return
    void request.then(async receipt => {
      if (!receipt) return
      if (this.options.access()?.generation === access.generation && !this.disposed) {
        this.receiptOwners.set(recordId, { generation: access.generation, reactionId: receipt.reactionId })
        if (this.receiptOwners.size > 1024) this.receiptOwners.delete(this.receiptOwners.keys().next().value!)
      }
      await this.options.store.mutate(current => {
        const feedback = current.inputs[recordId]?.feedback
        if (!feedback) return
        feedback.receivedReaction = receipt
        if (feedback.processingSharesReceived) feedback.reaction = receipt
      })
      await this.retireReceived(recordId)
      this.stopped.receiptUpdated(recordId)
    }).catch(() => this.diagnostic('CHANNEL_FEEDBACK_REACTION_FAILED'))
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
      await this.received(recordId)
      const feedback = this.options.store.snapshot().inputs[recordId]?.feedback
      const fresh = this.fresh.delete(recordId)
      if (!fresh || !feedback || !this.alive(entry)) {
        this.finish(entry)
        return
      }
      entry.since = feedback.since
      const config = await this.options.settings()
      if (!this.alive(entry) || !this.jobs(this.options.store.snapshot(), recordId).length) {
        this.finish(entry)
        return
      }
      if (config.wait.enabled && !feedback.waitAttempted && !feedback.replyObserved) {
        this.arm(entry, entry.since + config.wait.delaySeconds * 1000 - this.now())
      } else this.finish(entry)
    } catch {
      this.diagnostic('CHANNEL_FEEDBACK_UNAVAILABLE')
      this.finish(entry)
    }
  }
  jobUpdated(recordId: string) {
    this.sync()
    void this.started(recordId).catch(() => this.diagnostic('CHANNEL_FEEDBACK_PROCESSING_FAILED'))
    this.stopped.changed(recordId)
  }
  /** Change to processing only after a native turn has been acknowledged. */
  async started(recordId: string) {
    const snapshot = this.options.store.snapshot(),
      record = snapshot.inputs[recordId],
      event = record?.input.source.event,
      access = this.options.access()
    if (
      this.disposed || this.options.signal.aborted || !event || !access || !record.feedback?.receivedAttempted
      || record.feedback.reactionAttempted || !this.permitted(snapshot, event)
      || !this.jobs(snapshot, recordId).some(job => job.state === 'running' && job.sessionId && job.turnId)
    ) return
    const config = await this.options.settings()
    if (!(config.reaction.processingEnabled ?? config.reaction.enabled)) return
    const shares = (config.reaction.receivedEnabled ?? config.reaction.enabled)
      && (config.reaction.receivedEmojiType ?? 'Get') === config.reaction.emojiType
    const claimed = await this.options.store.mutate(state => {
      const feedback = state.inputs[recordId]?.feedback
      if (
        !feedback?.receivedAttempted || feedback.reactionAttempted || !this.permitted(state, event)
        || !this.jobs(state, recordId).some(job => job.state === 'running' && job.sessionId && job.turnId)
      ) return false
      feedback.reactionAttempted = true
      if (shares) {
        feedback.processingSharesReceived = true
        if (feedback.receivedReaction) feedback.reaction = feedback.receivedReaction
      }
      return true
    })
    if (
      !claimed || shares || this.disposed || this.options.signal.aborted
      || this.options.access()?.generation !== access.generation
    ) return
    const request = access.feedbackReact?.(event, config.reaction.emojiType)
    if (!request) return
    void request.then(async receipt => {
      if (
        !receipt || this.disposed || this.options.signal.aborted
        || this.options.access()?.generation !== access.generation
      ) return
      await this.options.store.mutate(state => {
        const feedback = state.inputs[recordId]?.feedback
        if (feedback) feedback.reaction = receipt
      })
      await this.retireReceived(recordId)
      this.stopped.receiptUpdated(recordId)
    }).catch(() => this.diagnostic('CHANNEL_FEEDBACK_PROCESSING_FAILED'))
  }
  private async retireReceived(recordId: string) {
    const state = this.options.store.snapshot(),
      record = state.inputs[recordId],
      feedback = record?.feedback,
      access = this.options.access(),
      owner = this.receiptOwners.get(recordId)
    if (
      this.disposed || this.options.signal.aborted || !record || !access || !owner || !feedback?.receivedReaction
      || !feedback.reaction || feedback.receivedRemovalAttempted
      || owner.generation !== access.generation || owner.reactionId !== feedback.receivedReaction.reactionId
      || feedback.reaction.reactionId === feedback.receivedReaction.reactionId
      || !this.permitted(state, record.input.source.event)
    ) return
    const claimed = await this.options.store.mutate(current => {
      const row = current.inputs[recordId]?.feedback
      if (
        !row?.receivedReaction || !row.reaction || row.receivedRemovalAttempted
        || row.receivedReaction.reactionId !== owner.reactionId || !this.permitted(current, record.input.source.event)
      ) {
        return false
      }
      row.receivedRemovalAttempted = true
      return true
    })
    if (
      !claimed || this.disposed || this.options.signal.aborted
      || this.options.access()?.generation !== owner.generation
    ) return
    this.receiptOwners.delete(recordId)
    const result = await access.feedbackRemove?.(record.input.source.event, owner.reactionId)
    if (result?.removed) {
      await this.options.store.mutate(current => {
        const row = current.inputs[recordId]?.feedback
        if (row?.receivedReaction?.reactionId === owner.reactionId) row.receivedReaction.removed = true
      })
    }
  }
  async catchup() {
    this.stopped.catchup()
    for (
      const record of Object.values(this.options.store.snapshot().inputs).filter(record =>
        record.feedback?.reaction && !record.feedback.completionAttempted
      ).slice(0, 100)
    ) {
      await this.completed(record.recordId).catch(() => this.diagnostic('CHANNEL_FEEDBACK_COMPLETION_UNKNOWN'))
    }
  }
  async completed(recordId: string) {
    if (this.stopped.has(recordId)) return
    const state = this.options.store.snapshot(), record = state.inputs[recordId]
    const jobs = Object.values(state.jobs).filter(job => job.recordId === recordId)
    if (
      !record?.feedback?.reaction || record.feedback.completionAttempted || !jobs.length
      || jobs.some(job => job.state !== 'completed') || !this.permitted(state, record.input.source.event)
    ) return
    const config = await this.options.settings(), emoji = config.reaction.completionEmojiType
    if (config.reaction.stoppedEnabled || !config.reaction.enabled || !emoji) return
    const reserved = await this.options.store.mutate(state => {
      const feedback = state.inputs[recordId]?.feedback
      if (!feedback || feedback.completionAttempted) return false
      feedback.completionAttempted = true
      return true
    })
    if (!reserved) return
    const access = this.options.access(), event = record.input.source.event
    if (!access?.feedbackRemove || !access.feedbackReact) throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE')
    const receipt = await access.feedbackReact(event, emoji)
    await this.options.store.mutate(state => {
      const feedback = state.inputs[recordId]?.feedback
      if (feedback) feedback.completion = receipt
    })
    if (receipt && receipt.reactionId !== record.feedback.reaction.reactionId) {
      await access.feedbackRemove(event, record.feedback.reaction.reactionId)
    }
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
    this.stopped.dispose()
    for (const entry of this.pending.values()) this.finish(entry)
    for (const remove of this.subscriptions.values()) remove()
    this.subscriptions.clear()
    this.fresh.clear()
    this.receiptOwners.clear()
  }
}
