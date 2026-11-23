import { randomBytes } from 'node:crypto'
import type { ChannelEventRef, ChannelSentDelivery, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { ChannelConversationStore as ConversationStore } from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelFeedbackSettings } from './channel-feedback-settings.js'
import type { ChannelProgressNotice, ChannelProgressResult } from './channel-progress-native.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { sameChannelPrincipal } from './channel-source-principal.js'
import { outboundCallerScope } from './channel-outbound-rpc.js'

const scopeKey = (event: ChannelEventRef) =>
  JSON.stringify([
    event.adapterId,
    event.accountId,
    event.tenantId,
    event.conversationId,
    event.kind,
    ...(event.kind === 'direct' ? [] : [event.semantics, event.threadId]),
  ])
export const channelProgressTarget = (source: ChannelEventRef, target: ChannelThreadRef) =>
  (['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'] as const).every(key => source[key] === target[key])
  && (source.kind === 'direct' || source.semantics !== 'topic'
    ? target.semantics !== 'topic' || source.threadId === target.threadId
    : target.semantics === 'topic' && source.threadId === target.threadId)

type Entry = {
  recordId: string
  source: ChannelEventRef
  generation: string
  sequence: number
  since: number
  token: string
  settings: NonNullable<ChannelFeedbackSettings['wait']>
  count: number
  uncertain: boolean
  acknowledged?: boolean
  ackOverdue?: boolean
  ackTimer?: ReturnType<typeof setTimeout>
  timer?: ReturnType<typeof setTimeout>
}
type Options = {
  store: Pick<ChannelConversationStore, 'snapshot'>
  access(): ChannelConversationAccess | undefined
  settings(): Promise<ChannelFeedbackSettings>
  turnState(sessionId: string, turnId: string): Promise<string>
  remind(notice: ChannelProgressNotice, current: () => boolean): Promise<ChannelProgressResult>
  signal: AbortSignal
  now?: () => number
  report?(code: string): void
}

/** One latest-input debounce per source conversation. Only confirmed, correlated sends cancel it. */
export class ChannelProgressReminders {
  private readonly entries = new Map<string, Entry>()
  private readonly arrivals = new Map<string, number>()
  private readonly latest = new Map<string, string>()
  private readonly deliveries = new Map<
    string,
    { source: ChannelEventRef; session: string; turn: string; generation: string }
  >()
  private subscription: { runtime: object; remove(): void } | undefined
  private disposed = false
  private readonly now: () => number
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
  }
  private report(code: string) {
    try {
      this.options.report?.(code)
    } catch {}
  }
  private finish(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.ackTimer) clearTimeout(entry.ackTimer)
    if (this.entries.get(scopeKey(entry.source)) === entry) this.entries.delete(scopeKey(entry.source))
  }
  private allowed(state: ChannelConversationState, source: ChannelEventRef) {
    return state.policy.enabled && channelDispatchAllowed(state, source)
      && channelPolicyAllows(state.policy, 'send', source)
  }
  private current(entry: Entry) {
    return !this.disposed && !this.options.signal.aborted && this.entries.get(scopeKey(entry.source)) === entry
      && this.options.access()?.generation === entry.generation
  }
  inputReceived(recordId: string, source: ChannelEventRef) {
    const entry = this.entries.get(scopeKey(source))
    if (entry) this.finish(entry)
    this.arrivals.set(recordId, this.now())
    this.latest.set(scopeKey(source), recordId)
    if (this.latest.size > 1024) this.latest.delete(this.latest.keys().next().value!)
    if (this.arrivals.size > 1024) this.arrivals.delete(this.arrivals.keys().next().value!)
  }
  sync() {
    const access = this.options.access()
    if (access?.runtime !== this.subscription?.runtime) {
      this.subscription?.remove()
      this.subscription = undefined
      if (access?.runtime.observeSentDelivery) {
        this.subscription = {
          runtime: access.runtime,
          remove: access.runtime.observeSentDelivery(event => this.sent(event)),
        }
      }
    }
    for (const entry of this.entries.values()) {
      if (!this.current(entry) || !this.allowed(this.options.store.snapshot(), entry.source)) this.finish(entry)
    }
  }
  /** Called once at admission, before async settings reads or native dispatch can delay the debounce. */
  async accepted(recordId: string) {
    const state = this.options.store.snapshot(), record = state.inputs[recordId], access = this.options.access()
    const source = record?.input.source.event
    if (!record?.accepted || !source || !access || !this.arrivals.has(recordId) || !this.allowed(state, source)) return
    const key = scopeKey(source), prior = this.entries.get(key)
    if (this.latest.has(key) && this.latest.get(key) !== recordId) return
    if (prior && prior.sequence >= record.sequence) return
    if (prior) this.finish(prior)
    const entry: Entry = {
      recordId,
      source,
      sequence: record.sequence,
      generation: access.generation,
      since: this.arrivals.get(recordId) ?? this.now(),
      token: randomBytes(24).toString('hex'),
      settings: { enabled: false, text: '', delaySeconds: 30 },
      count: 0,
      uncertain: false,
    }
    this.entries.set(key, entry)
    this.sync()
    const config = await this.options.settings().catch(() => undefined)
    if (!this.current(entry)) return
    if (!config?.wait.enabled || config.wait.mode !== 'agent' || !this.subscription) {
      this.finish(entry)
      return
    }
    entry.settings = config.wait
    const ackSeconds = config.wait.ackTimeoutSeconds ?? 60
    if (ackSeconds > 0) {
      entry.ackTimer = setTimeout(() => {
        const jobs = Object.values(this.options.store.snapshot().jobs).filter(job => job.recordId === entry.recordId)
        if (
          this.current(entry) && !entry.acknowledged
          && jobs.some(job => ['queued', 'dispatching', 'running', 'reconciliation-required'].includes(job.state))
        ) {
          entry.ackOverdue = true
          this.report('CHANNEL_INPUT_ACK_OVERDUE')
        }
      }, Math.max(0, entry.since + ackSeconds * 1000 - this.now()))
      entry.ackTimer.unref?.()
    }
    this.arm(entry, entry.since + (config.wait.quietSeconds ?? 5) * 1000 - this.now())
  }
  private arm(entry: Entry, delay: number) {
    if (!this.current(entry) || entry.uncertain) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void this.deadline(entry).catch(() => {
        entry.uncertain = true
        this.report('CHANNEL_PROGRESS_REMINDER_UNKNOWN')
      })
    }, Math.max(0, delay))
    entry.timer.unref?.()
  }
  private job(entry: Entry) {
    const state = this.options.store.snapshot()
    if (!this.current(entry) || !this.allowed(state, entry.source)) return undefined
    const jobs = Object.values(state.jobs).filter(job => job.recordId === entry.recordId)
    if (!jobs.length || jobs.some(job => job.state !== 'running' || !job.sessionId || !job.turnId)) return undefined
    const first = jobs[0]!
    if (ConversationStore.logicalSourceFenced(state, first.sessionId!)) return undefined
    if (jobs.some(job => job.sessionId !== first.sessionId || job.turnId !== first.turnId)) return undefined
    const siblings = Object.values(state.jobs).filter(job =>
      job.sessionId === first.sessionId && job.turnId === first.turnId
      && ['running', 'dispatching', 'reconciliation-required'].includes(job.state)
    )
    if (
      siblings.some(job =>
        job.state !== 'running' || !state.inputs[job.recordId]
        || !sameChannelPrincipal(state.inputs[job.recordId]!.input.source.event, entry.source)
      )
    ) return undefined
    if (first.bindingId && state.bindings[first.bindingId]?.state !== 'active') return undefined
    const takeover = state.liveTakeovers[first.sessionId!]
    if (takeover && !['finished', 'abandoned'].includes(takeover.state)) return undefined
    if (['dispatching', 'unknown'].includes(state.continuations[first.sessionId!]?.intent?.state ?? '')) {
      return undefined
    }
    return first
  }
  private async deadline(entry: Entry) {
    if (!this.current(entry)) return
    const state = this.options.store.snapshot(),
      jobs = Object.values(state.jobs).filter(job => job.recordId === entry.recordId)
    if (jobs.length && jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.state))) {
      this.finish(entry)
      return
    }
    const job = this.job(entry)
    if (!job) {
      if (jobs.some(job => job.state === 'reconciliation-required')) {
        this.finish(entry)
        return
      }
      this.arm(entry, (entry.settings.repeatSeconds ?? 30) * 1000)
      return
    }
    const status = await this.options.turnState(job.sessionId!, job.turnId!)
    if (!this.current(entry)) return
    if (status === 'completed' || status === 'failed') {
      this.finish(entry)
      return
    }
    if (status !== 'active') {
      entry.uncertain = true
      this.report('CHANNEL_PROGRESS_TURN_UNKNOWN')
      return
    }
    const valid = () => this.current(entry) && this.job(entry)?.turnId === job.turnId
    if (!valid()) return
    const result = await this.options.remind({
      source: entry.source,
      sessionId: job.sessionId!,
      turnId: job.turnId!,
      token: entry.token,
      finishSeconds: entry.settings.finishSeconds ?? 10,
      reminder: ++entry.count,
    }, valid)
    if (!this.current(entry)) return
    if (result === 'unknown') {
      entry.uncertain = true
      this.report('CHANNEL_PROGRESS_REMINDER_UNKNOWN')
      return
    }
    if (result === 'rejected') {
      this.finish(entry)
      return
    }
    this.arm(entry, (entry.settings.repeatSeconds ?? 30) * 1000)
  }
  private sent(event: ChannelSentDelivery) {
    for (const entry of this.entries.values()) {
      if (
        !this.current(entry) || !channelProgressTarget(entry.source, event.target)
        || Date.parse(event.createdAt) < entry.since
      ) continue
      const state = this.options.store.snapshot()
      const jobs = Object.values(state.jobs).filter(job =>
        job.recordId === entry.recordId && job.sessionId && job.turnId
      )
      const tracked = this.deliveries.get(event.deliveryId)
      const matched =
        tracked && tracked.generation === entry.generation && sameChannelPrincipal(tracked.source, entry.source)
          && jobs.some(job => job.sessionId === tracked.session && job.turnId === tracked.turn)
          && event.caller.source === 'cordisx:native-channel' && event.caller.pluginId === 'host-channel-tools'
          && event.caller.generation
            === outboundCallerScope({ source: tracked.source, session: tracked.session, turnId: tracked.turn })
        || jobs.some(job =>
          Object.values(state.jobs).filter(other => other.sessionId === job.sessionId && other.turnId === job.turnId)
            .some(other => {
              const source = state.inputs[other.recordId]?.input.source.event
              return source && sameChannelPrincipal(source, entry.source)
                && event.caller.source === 'cordisx:native-channel'
                && event.caller.pluginId === 'host-channel-tools'
                && event.caller.generation
                  === outboundCallerScope({ source, session: job.sessionId!, turnId: job.turnId! })
            })
        )
      if (matched) this.finish(entry)
    }
  }
  trackDelivery(
    id: string,
    source: ChannelEventRef | undefined,
    session: string | undefined,
    turn: string | undefined,
  ) {
    const generation = this.options.access()?.generation
    if (!source || !session || !turn || !generation || this.deliveries.has(id)) return
    this.deliveries.set(id, { source, session, turn, generation })
    if (this.deliveries.size > 2048) this.deliveries.delete(this.deliveries.keys().next().value!)
  }
  assertCurrent(token: unknown, source: ChannelEventRef | undefined, sessionId: string | undefined) {
    if (typeof token !== 'string' || !source || !sessionId) throw new Error('CHANNEL_PROGRESS_NOTICE_STALE')
    const entry = this.entries.get(scopeKey(source)), job = entry && this.job(entry)
    if (
      !entry || entry.token !== token || !this.current(entry) || job?.sessionId !== sessionId
      || !sameChannelPrincipal(entry.source, source)
    ) {
      throw new Error('CHANNEL_PROGRESS_NOTICE_STALE')
    }
  }
  inputStatus(source: ChannelEventRef, sessionId: string, acknowledge: boolean) {
    const entry = this.entries.get(scopeKey(source))
    const jobs = entry
      && Object.values(this.options.store.snapshot().jobs).filter(job => job.recordId === entry.recordId)
    // The native caller may acknowledge before dispatch's promise has committed its running state.
    const job = entry
      && (this.job(entry) ?? (jobs?.length === 1 && jobs[0]?.state === 'dispatching' ? jobs[0] : undefined))
    if (
      !entry || !this.current(entry) || !job || job.sessionId !== undefined && job.sessionId !== sessionId
      || entry.source.messageId !== source.messageId || !sameChannelPrincipal(entry.source, source)
    ) {
      return { status: 'ok', acknowledgment: 'not-monitored', consumption: 'unconfirmed' }
    }
    if (acknowledge) {
      entry.acknowledged = true
      if (entry.ackTimer) clearTimeout(entry.ackTimer)
    }
    return {
      status: 'ok',
      acknowledgment: entry.acknowledged ? 'agent-acknowledged' : 'awaiting-agent',
      consumption: entry.acknowledged ? 'acknowledged-by-caller' : 'unconfirmed',
      overdue: entry.ackOverdue === true && !entry.acknowledged,
      elapsedMs: Math.max(0, this.now() - entry.since),
    }
  }
  dispose() {
    this.disposed = true
    this.subscription?.remove()
    this.arrivals.clear()
    this.latest.clear()
    this.deliveries.clear()
    for (const entry of this.entries.values()) this.finish(entry)
  }
}
