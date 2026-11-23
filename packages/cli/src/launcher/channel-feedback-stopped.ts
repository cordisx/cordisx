import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type {
  ChannelConversationJob,
  ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import type { ChannelReactionReceipt } from './channel-feedback.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelDispatchAllowed } from './channel-group-access.js'

type Candidate = {
  generation: string
  emoji: string
  checking: boolean
  attempted: boolean
  receipt?: ChannelReactionReceipt
  removals: Set<string>
}
type Options = {
  store: Pick<ChannelConversationStore, 'snapshot' | 'mutate'>
  access(): ChannelConversationAccess | undefined
  turnState(sessionId: string, turnId: string): Promise<string>
  signal: AbortSignal
  report?(code: string): void
}

/** Feedback describes the observed end of a turn, not completion of the user's goal. */
export class ChannelStoppedFeedback {
  private readonly candidates = new Map<string, Candidate>()
  private disposed = false
  constructor(private readonly options: Options) {}

  private report(code: string) {
    try {
      this.options.report?.(code)
    } catch { /* feedback never gates the job */ }
  }

  private current(candidate: Candidate) {
    return !this.disposed && !this.options.signal.aborted
      && this.options.access()?.generation === candidate.generation
  }

  private allowed(state: ChannelConversationState, event: ChannelEventRef) {
    return state.policy.enabled && channelDispatchAllowed(state, event)
      && channelPolicyAllows(state.policy, 'send', event)
  }

  private jobs(state: ChannelConversationState, recordId: string): ChannelConversationJob[] | undefined {
    const jobs = Object.values(state.jobs).filter(job => job.recordId === recordId)
    if (
      !jobs.length || jobs.some(job =>
        !job.sessionId || !job.turnId
        || !['running', 'replying', 'completed', 'failed', 'cancelled'].includes(job.state)
        || (state.liveTakeovers?.[job.sessionId]
          && !['preparing', 'ready', 'abandoned'].includes(state.liveTakeovers[job.sessionId]!.state))
        || ['dispatching', 'unknown'].includes(state.continuations?.[job.sessionId]?.intent?.state ?? '')
      )
    ) return undefined
    return jobs
  }

  /** Only inputs accepted after enabling this option are eligible, never stored history. */
  accepted(recordId: string, generation: string, emoji: string) {
    if (this.disposed || this.candidates.has(recordId)) return
    if (this.candidates.size >= 1024) {
      for (const [id, item] of this.candidates) {
        if (item.attempted && !item.checking) {
          this.candidates.delete(id)
          break
        }
      }
    }
    if (this.candidates.size >= 1024) {
      this.report('CHANNEL_FEEDBACK_STOPPED_CAPACITY')
      return
    }
    this.candidates.set(recordId, { generation, emoji, checking: false, attempted: false, removals: new Set() })
  }

  has(recordId: string) {
    return this.candidates.has(recordId)
  }

  changed(recordId: string) {
    void this.check(recordId).catch(() => this.report('CHANNEL_FEEDBACK_STOPPED_UNKNOWN'))
  }

  receiptUpdated(recordId: string) {
    this.changed(recordId)
    if (this.candidates.get(recordId)?.receipt) {
      void this.retire(recordId).catch(() => this.report('CHANNEL_FEEDBACK_STOPPED_REMOVE_UNKNOWN'))
    }
  }

  catchup() {
    const state = this.options.store.snapshot()
    const terminalRecords = new Set(
      Object.values(state.jobs)
        .filter(job => ['replying', 'completed', 'failed', 'cancelled'].includes(job.state))
        .map(job => job.recordId),
    )
    for (const [id, candidate] of this.candidates) {
      if (!candidate.attempted && !candidate.checking && terminalRecords.has(id)) this.changed(id)
    }
  }

  async check(recordId: string) {
    const candidate = this.candidates.get(recordId), access = this.options.access()
    if (!candidate || candidate.checking || candidate.attempted || !this.current(candidate) || !access?.feedbackReact) {
      return
    }
    const snapshot = this.options.store.snapshot(), record = snapshot.inputs[recordId]
    const jobs = this.jobs(snapshot, recordId)
    if (
      !record?.feedback || record.feedback.completionAttempted || !jobs
      || !this.allowed(snapshot, record.input.source.event)
    ) return
    candidate.checking = true
    try {
      const verdicts = await Promise.all(jobs.map(job => this.options.turnState(job.sessionId!, job.turnId!)))
      if (verdicts.some(status => !['completed', 'failed'].includes(status)) || !this.current(candidate)) return
      const fingerprint = JSON.stringify(jobs.map(job => JSON.stringify([job.id, job.sessionId, job.turnId])).sort())
      const reserved = await this.options.store.mutate(state => {
        const current = state.inputs[recordId], currentJobs = this.jobs(state, recordId)
        if (
          !this.current(candidate) || !current?.feedback || current.feedback.completionAttempted || !currentJobs
          || !this.allowed(state, current.input.source.event)
          || JSON.stringify(currentJobs.map(job => JSON.stringify([job.id, job.sessionId, job.turnId])).sort())
            !== fingerprint
        ) return false
        current.feedback.completionAttempted = true
        return true
      })
      if (!reserved || !this.current(candidate)) return
      candidate.attempted = true
      const latestState = this.options.store.snapshot(), latest = latestState.inputs[recordId]
      if (!latest?.feedback || !this.allowed(latestState, latest.input.source.event)) return
      const feedback = latest.feedback
      // Reuse an already-owned identical emoji rather than adding and removing it.
      const same = [feedback.reaction, feedback.receivedReaction].find(receipt =>
        receipt && !receipt.removed && receipt.emojiType === candidate.emoji
        && !(receipt.reactionId === feedback.receivedReaction?.reactionId && feedback.receivedRemovalAttempted)
      )
      const receipt = same ?? await access.feedbackReact(latest.input.source.event, candidate.emoji)
      if (!receipt || !this.current(candidate)) return
      candidate.receipt = receipt
      await this.options.store.mutate(state => {
        const feedback = state.inputs[recordId]?.feedback
        if (feedback) feedback.completion = receipt
      })
      await this.retire(recordId)
    } finally {
      candidate.checking = false
    }
  }

  /** Remove only reactions with SDK-owned receipts, and never retry an uncertain removal. */
  async retire(recordId: string) {
    const candidate = this.candidates.get(recordId), access = this.options.access()
    if (!candidate?.receipt || !this.current(candidate) || !access?.feedbackRemove) return
    const snapshot = this.options.store.snapshot(), record = snapshot.inputs[recordId]
    if (!record?.feedback || !this.allowed(snapshot, record.input.source.event)) return
    for (const receipt of [record.feedback.receivedReaction, record.feedback.reaction]) {
      if (
        !receipt || receipt.removed || receipt.reactionId === candidate.receipt.reactionId
        || candidate.removals.has(receipt.reactionId)
      ) continue
      const isReceived = receipt.reactionId === record.feedback.receivedReaction?.reactionId
      if (isReceived) {
        const claimed = await this.options.store.mutate(state => {
          const feedback = state.inputs[recordId]?.feedback
          const current = state.inputs[recordId]
          if (
            feedback?.receivedReaction?.reactionId !== receipt.reactionId || feedback.receivedRemovalAttempted
            || !current || !this.allowed(state, current.input.source.event)
          ) {
            return false
          }
          feedback.receivedRemovalAttempted = true
          return true
        })
        if (!claimed) continue
      }
      if (!this.current(candidate)) return
      const current = this.options.store.snapshot(), currentRecord = current.inputs[recordId]
      if (!currentRecord || !this.allowed(current, currentRecord.input.source.event)) return
      candidate.removals.add(receipt.reactionId)
      try {
        const removed = await access.feedbackRemove(record.input.source.event, receipt.reactionId)
        if (removed?.removed) {
          await this.options.store.mutate(state => {
            const feedback = state.inputs[recordId]?.feedback
            if (feedback?.receivedReaction?.reactionId === receipt.reactionId) feedback.receivedReaction.removed = true
            if (feedback?.reaction?.reactionId === receipt.reactionId) feedback.reaction.removed = true
          })
        }
      } catch {
        this.report('CHANNEL_FEEDBACK_STOPPED_REMOVE_UNKNOWN')
      }
    }
  }

  dispose() {
    this.disposed = true
    this.candidates.clear()
  }
}
