import type { ChannelConversationStore } from './channel-conversation-store.js'
import { effectiveLivePolicy } from './channel-live-policy.js'
import type { ContextObservations } from './context-observations.js'

/** Watches current Channel-owned running turns, not completed turns or cumulative usage. */
export class ChannelLiveThreshold {
  private readonly watches = new Map<string, { key: string; close(): Promise<void> }>()
  private readonly unsubscribeSession: () => void
  private disposed = false
  constructor(
    private readonly store: ChannelConversationStore,
    private readonly observations: ContextObservations,
    private readonly cross: (input: { source: string; sourceTurn: string; sourceJob: string }) => Promise<unknown>,
  ) {
    this.unsubscribeSession = observations.onSession(sessionId => {
      const old = this.watches.get(sessionId)
      if (old) {
        this.watches.delete(sessionId)
        void old.close()
      }
      this.sync()
    })
  }

  sync(): void {
    if (this.disposed) return
    const state = this.store.snapshot()
    const wanted = new Map<string, { key: string; ratio: number }>()
    for (
      const source of new Set(
        Object.values(state.bindings).filter(binding => binding.state === 'active')
          .map(binding => binding.sessionId),
      )
    ) {
      const policy = effectiveLivePolicy(state.continuationDefaults, state.continuations[source])
      const takeover = state.liveTakeovers[source]
      if (!policy.policy.enabled || takeover && takeover.state !== 'abandoned') continue
      const key = JSON.stringify([policy.defaultsRevision, policy.overrideRevision, policy.policy.thresholdRatio])
      wanted.set(source, { key, ratio: policy.policy.thresholdRatio })
    }
    for (const [source, watch] of this.watches) {
      if (wanted.get(source)?.key !== watch.key) {
        this.watches.delete(source)
        void watch.close()
      }
    }
    for (const [source, target] of wanted) {
      if (this.watches.has(source) || this.watches.size >= 128) continue
      try {
        const watch = this.observations.watch(source, target.ratio, async event => {
          if (event.reason !== 'crossed' || !event.sample.turnId) return
          const current = this.store.snapshot()
          const matching = Object.values(current.jobs).filter(job =>
            job.state === 'running'
            && job.sessionId === source && job.turnId === event.sample.turnId && job.bindingId
            && current.bindings[job.bindingId]?.state === 'active'
          )
          if (matching.length !== 1) return
          const job = matching[0]!, turn = event.sample.turnId
          const policy = effectiveLivePolicy(current.continuationDefaults, current.continuations[source])
          const latest = this.observations.read(source)
          const key = JSON.stringify([policy.defaultsRevision, policy.overrideRevision, policy.policy.thresholdRatio])
          const takeover = current.liveTakeovers[source]
          if (
            this.disposed || this.watches.get(source)?.key !== target.key || key !== target.key
            || !policy.policy.enabled || !latest || latest.budget.status !== 'resolved' || latest.turnId !== turn
            || latest.resetEpoch !== event.sample.resetEpoch || latest.configEpoch !== event.sample.configEpoch
            || latest.usedTokens / latest.budget.tokens < target.ratio
            || takeover && !(takeover.state === 'abandoned' && takeover.sourceTurn !== turn)
          ) return
          await this.cross({ source, sourceTurn: turn, sourceJob: job.id })
        })
        const entry = { key: target.key, close: watch.unsubscribe }
        this.watches.set(source, entry)
        void watch.closed.then(() => {
          if (this.watches.get(source) === entry) this.watches.delete(source)
        })
      } catch { /* No fresh current-connection session has been observed yet. */ }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSession()
    for (const watch of this.watches.values()) void watch.close()
    this.watches.clear()
  }
}
