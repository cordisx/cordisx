import type { NotificationOptionsV1, NotificationsV1 } from '../../notification-contracts.js'

export interface NotificationOwner {
  readonly key: string
  readonly pluginId: string
  readonly active: () => boolean
  readonly presentation: () => { name: string; icon?: string }
  readonly open?: () => Promise<void>
  readonly canOpen?: () => boolean
}
export interface NotificationEntry {
  readonly id: number
  readonly owner: NotificationOwner
  readonly lifetime: AbortController
  options: NotificationOptionsV1
  count: number
  remaining: number
  paused: boolean
  busy: boolean
  actionError?: string | undefined
}
export interface NotificationRule {
  readonly id: string
  readonly ownerKey: string
  readonly name: string
  readonly kind?: string
  readonly expiresAt?: number
}
export interface NotificationStorage {
  read(): unknown
  write(rules: readonly NotificationRule[]): void
}
const duration = { success: 3000, info: 4000, warning: 6000, error: Infinity }
const noHandle = Object.freeze({ dismiss() {} })
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

export class NotificationCenter {
  private entries: NotificationEntry[] = []
  private rules: NotificationRule[] = []
  private listeners = new Set<() => void>()
  private revision = 0
  private sequence = 0
  private undoRule: string | undefined
  private undoUntil = 0
  private previousRules: NotificationRule[] = []
  private management = false
  persistenceError = false
  constructor(private readonly storage: NotificationStorage, private readonly now = Date.now) {
    try {
      const saved = storage.read()
      if (Array.isArray(saved)) {
        this.rules = saved.filter((r): r is NotificationRule =>
          r && text(r.id, 200) && text(r.ownerKey, 4096) && text(r.name, 256)
          && (r.kind === undefined || text(r.kind, 96))
          && (r.expiresAt === undefined || Number.isFinite(r.expiresAt) && r.expiresAt > now())
        ).slice(0, 500)
      }
    } catch {
      this.persistenceError = true
    }
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  snapshot = () => this.revision
  private changed() {
    this.revision++
    for (const fn of this.listeners) fn()
  }
  visible() {
    return this.entries.slice(0, 3)
  }
  pending() {
    return Math.max(0, this.entries.length - 3)
  }
  getRules() {
    return this.rules.filter(r => r.expiresAt === undefined || r.expiresAt > this.now())
  }
  isManaging() {
    return this.management
  }
  manage(value = true) {
    this.management = value
    this.changed()
  }
  canUndo() {
    return this.undoRule !== undefined && this.undoUntil > this.now()
  }
  private matches(rule: NotificationRule, owner: NotificationOwner, kind: string) {
    return rule.ownerKey === owner.key && (rule.kind === undefined || rule.kind === kind)
      && (rule.expiresAt === undefined || rule.expiresAt > this.now())
  }
  bind(owner: NotificationOwner): { api: NotificationsV1; dispose(): void } {
    let disposed = false
    const owned = new Set<number>()
    const api: NotificationsV1 = Object.freeze({
      contract: 'cordisx.notifications/v1',
      show: (input: NotificationOptionsV1) => {
        if (
          !input || typeof input.kind !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(input.kind)
          || !Object.hasOwn(duration, input.type) || !text(input.message, 500)
          || (input.description !== undefined && !text(input.description, 2000))
          || (input.details !== undefined && !text(input.details, 16000))
          || (input.action !== undefined && (!text(input.action.label, 64) || typeof input.action.run !== 'function'))
        ) {
          throw new TypeError('Invalid notification')
        }
        if (disposed || !owner.active() || this.rules.some(r => this.matches(r, owner, input.kind))) return noHandle
        // Snapshot the descriptor; plugin mutation cannot change an already shown card.
        const options = Object.freeze({
          ...input,
          ...(input.action ? { action: Object.freeze({ ...input.action }) } : {}),
        })
        let entry = this.entries.find(e => e.owner === owner && e.options.kind === options.kind && !e.busy)
        if (entry) {
          entry.count++
          entry.remaining = duration[options.type]
          if (!entry.busy) entry.options = options
        } else {
          if (this.entries.length >= 100 || this.entries.filter(e => e.owner.key === owner.key).length >= 20) {
            return noHandle
          }
          entry = {
            id: ++this.sequence,
            owner,
            options,
            count: 1,
            remaining: duration[options.type],
            paused: false,
            busy: false,
            lifetime: new AbortController(),
          }
          this.entries.push(entry)
          owned.add(entry.id)
        }
        const id = entry.id
        this.changed()
        return Object.freeze({
          dismiss: () => {
            if (owned.has(id)) this.dismiss(id)
          },
        })
      },
    })
    return {
      api,
      dispose: () => {
        disposed = true
        for (const id of owned) this.dismiss(id)
        owned.clear()
      },
    }
  }
  dismiss(id: number) {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return
    entry.lifetime.abort()
    this.entries = this.entries.filter(e => e !== entry)
    this.changed()
  }
  tick(elapsed: number, background = false) {
    for (const e of [...this.entries]) if (!e.owner.active()) this.dismiss(e.id)
    if (!background) {
      for (const e of this.visible()) {
        if (!e.paused && !e.busy) e.remaining -= Math.max(0, Math.min(elapsed, 1000))
        if (e.remaining <= 0) this.dismiss(e.id)
      }
    }
    if (this.undoRule && this.undoUntil <= this.now()) {
      this.undoRule = undefined
      this.changed()
    }
  }
  async invoke(entry: NotificationEntry, fallback: string) {
    if (!this.entries.includes(entry) || !entry.owner.active() || entry.busy || !entry.options.action) return
    entry.busy = true
    entry.actionError = undefined
    this.changed()
    try {
      await entry.options.action.run(entry.lifetime.signal)
      if (!entry.lifetime.signal.aborted) this.dismiss(entry.id)
    } catch {
      if (!entry.lifetime.signal.aborted && entry.owner.active()) {
        entry.actionError = fallback
        entry.remaining = Infinity
      }
    } finally {
      entry.busy = false
      this.changed()
    }
  }
  mute(entry: NotificationEntry, scope: 'kind' | 'plugin' | 'hour' | 'today') {
    const until = new Date(this.now())
    until.setHours(24, 0, 0, 0)
    const rule: NotificationRule = {
      id: `${this.now()}-${++this.sequence}`,
      ownerKey: entry.owner.key,
      name: entry.owner.presentation().name,
      ...(scope === 'kind' ? { kind: entry.options.kind } : {}),
      ...(scope === 'hour' ? { expiresAt: this.now() + 3600000 } : scope === 'today' ? { expiresAt: +until } : {}),
    }
    this.previousRules = [...this.getRules()]
    this.rules = this.getRules().filter(r => !(r.ownerKey === rule.ownerKey && r.kind === rule.kind))
    if (this.rules.length >= 500) {
      this.management = true
      this.changed()
      return
    }
    this.rules.push(rule)
    this.undoRule = rule.id
    this.undoUntil = this.now() + 10000
    for (const e of [...this.entries]) if (this.matches(rule, e.owner, e.options.kind)) this.dismiss(e.id)
    this.save()
  }
  undo() {
    if (this.canUndo()) {
      this.rules = this.previousRules
      this.undoRule = undefined
      this.save()
    }
  }
  removeRule(id: string) {
    this.rules = this.rules.filter(r => r.id !== id)
    this.undoRule = undefined
    this.save()
  }
  private save() {
    try {
      this.storage.write(this.rules)
      this.persistenceError = false
    } catch {
      this.persistenceError = true
    }
    this.changed()
  }
  dispose() {
    for (const e of this.entries) e.lifetime.abort()
    this.entries = []
    this.listeners.clear()
  }
}
