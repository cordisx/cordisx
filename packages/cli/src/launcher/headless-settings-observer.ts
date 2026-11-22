import type { CodexAppServerRpc } from '../providers/codex-app-server.js'

/** Fresh native settings notifications can confirm idle model changes without resuming a rollout. */
export class HeadlessSettingsObserver {
  private readonly observations = new Map<string, { revision: number; settings: Record<string, unknown> }>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: (() => void) | undefined
  constructor(server: CodexAppServerRpc) {
    this.unsubscribe = server.subscribeNotifications?.((method, params) => {
      if (method !== 'thread/settings/updated' || !params || typeof params !== 'object') return
      const row = params as { threadId?: unknown; threadSettings?: unknown }
      if (typeof row.threadId !== 'string' || !row.threadSettings || typeof row.threadSettings !== 'object') return
      this.observations.set(row.threadId, {
        revision: this.revision(row.threadId) + 1,
        settings: row.threadSettings as Record<string, unknown>,
      })
      if (this.observations.size > 512) this.observations.delete(this.observations.keys().next().value!)
      for (const listener of this.listeners) listener()
    })
  }
  revision(threadId: string) {
    return this.observations.get(threadId)?.revision ?? 0
  }
  fresh(threadId: string, revision: number) {
    const observed = this.observations.get(threadId)
    return observed && observed.revision > revision ? observed.settings : undefined
  }
  async wait(threadId: string, revision: number) {
    if (!this.unsubscribe) return undefined
    const fresh = this.fresh(threadId, revision)
    if (fresh) return fresh
    return new Promise<Record<string, unknown> | undefined>(resolve => {
      const done = (value?: Record<string, unknown>) => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(value)
      }
      const listener = () => {
        const value = this.fresh(threadId, revision)
        if (value) done(value)
      }
      const timer = setTimeout(() => done(), 1000)
      this.listeners.add(listener)
      listener()
    })
  }
  close() {
    this.unsubscribe?.()
    this.observations.clear()
  }
}
