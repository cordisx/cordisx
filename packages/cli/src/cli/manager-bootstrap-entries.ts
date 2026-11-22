import { randomBytes } from 'node:crypto'

const idPattern = /^[a-f0-9]{64}$/u
const lifetimeMs = 60_000
const limit = 16

export interface ManagerBootstrapSession {
  readonly token: string
  readonly resumeId?: string
  readonly cookie?: string
}

type Entry = {
  readonly deadline: number
  readonly timer: NodeJS.Timeout
  cleanup?: () => Promise<void>
  attempt?: string
  tail: Promise<void>
  issued?: { readonly token: string; readonly resumeId?: string }
}

/** A bootstrap remains retryable only until its first session is used. */
export class ManagerBootstrapEntries {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(private readonly retireSession: (token: string) => Promise<boolean>) {}

  issue(cleanup?: () => Promise<void>): string {
    if (this.closed || this.entries.size >= limit) throw new Error('MANAGER_LINK_LIMIT')
    const token = randomBytes(32).toString('hex')
    if (this.entries.has(token)) throw new Error('MANAGER_LINK_LIMIT')
    const timer = setTimeout(() => void this.revoke(token).catch(() => undefined), lifetimeMs)
    timer.unref()
    this.entries.set(token, {
      deadline: Date.now() + lifetimeMs,
      timer,
      tail: Promise.resolve(),
      ...(cleanup === undefined ? {} : { cleanup }),
    })
    return token
  }

  private detach(token: string, entry: Entry): boolean {
    if (this.entries.get(token) !== entry) return false
    this.entries.delete(token)
    clearTimeout(entry.timer)
    return true
  }

  private current(token: string, entry: Entry): boolean {
    return !this.closed && this.entries.get(token) === entry && entry.deadline > Date.now()
  }

  async revoke(token: string): Promise<void> {
    const entry = this.entries.get(token)
    if (!entry || !this.detach(token, entry)) return
    const cleanup = entry.cleanup
    delete entry.cleanup
    const results = await Promise.allSettled([
      Promise.resolve().then(async () => await cleanup?.()),
      ...(entry.issued === undefined ? [] : [this.retireSession(entry.issued.token)]),
    ])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  /** Retry a lost exchange only for the same tab attempt and after retirement. */
  async exchange(
    token: string,
    attempt: string | undefined,
    issueSession: () => Promise<ManagerBootstrapSession>,
  ): Promise<(ManagerBootstrapSession & { readonly previousResumeId?: string }) | undefined> {
    const entry = this.entries.get(token)
    if (!entry || !idPattern.test(token)) return undefined
    if (!this.current(token, entry)) {
      await this.revoke(token)
      return undefined
    }
    if (attempt === undefined) {
      if (entry.attempt !== undefined || !this.detach(token, entry)) return undefined
      await entry.cleanup?.()
      if (this.closed || entry.deadline <= Date.now()) return undefined
      const issued = await issueSession()
      if (this.closed || entry.deadline <= Date.now()) {
        await this.retireSession(issued.token)
        return undefined
      }
      return issued
    }
    if (!idPattern.test(attempt) || entry.attempt !== undefined && entry.attempt !== attempt) return undefined
    entry.attempt = attempt
    const previous = entry.tail
    let release!: () => void
    entry.tail = new Promise<void>(resolve => release = resolve)
    await previous
    try {
      if (!this.current(token, entry)) return undefined
      const cleanup = entry.cleanup
      delete entry.cleanup
      await cleanup?.()
      if (!this.current(token, entry)) return undefined
      const prior = entry.issued
      if (prior && !await this.retireSession(prior.token)) {
        await this.revoke(token)
        return undefined
      }
      if (!this.current(token, entry)) return undefined
      const issued = await issueSession()
      if (!this.current(token, entry)) {
        await this.retireSession(issued.token)
        return undefined
      }
      entry.issued = {
        token: issued.token,
        ...(issued.resumeId === undefined ? {} : { resumeId: issued.resumeId }),
      }
      return { ...issued, ...(prior?.resumeId === undefined ? {} : { previousResumeId: prior.resumeId }) }
    } catch (error) {
      if (this.entries.get(token) === entry) await this.revoke(token).catch(() => undefined)
      throw error
    } finally {
      release()
    }
  }

  /** The first authenticated session request consumes the bootstrap permanently. */
  finalizeSession(sessionToken: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.issued?.token === sessionToken) this.detach(token, entry)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([...this.entries.keys()].map(async token => await this.revoke(token)))
  }
}
