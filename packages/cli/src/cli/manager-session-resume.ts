import { randomBytes, timingSafeEqual } from 'node:crypto'

const idPattern = /^[a-f0-9]{64}$/u
const cookieName = 'cordisx_manager_resume'
const graceMs = 30_000
const limit = 64

type Grant = {
  readonly id: string
  readonly secret: string
  readonly session: string
  parkedUntil?: number
  retirement?: Promise<boolean>
  consuming?: boolean
}

/** A tab-local public handle needs the separate, HttpOnly browser cookie. */
export class ManagerSessionResumeGrants {
  private readonly grants = new Map<string, Grant>()
  private readonly sessions = new Map<string, string>()

  private forget(grant: Grant): void {
    if (this.grants.get(grant.id) === grant) this.grants.delete(grant.id)
    if (this.sessions.get(grant.session) === grant.id) this.sessions.delete(grant.session)
  }

  private prune(): void {
    const now = Date.now()
    for (const grant of this.grants.values()) {
      if (grant.parkedUntil !== undefined && grant.parkedUntil <= now) this.forget(grant)
    }
  }

  issue(session: string): { readonly id: string; readonly cookie: string } {
    if (!idPattern.test(session) || this.sessions.has(session)) throw new Error('manager-resume-invalid')
    this.prune()
    if (this.grants.size >= limit) {
      const parked = [...this.grants.values()].find(grant => grant.parkedUntil !== undefined)
      if (!parked) throw new Error('manager-resume-limit')
      this.forget(parked)
    }
    const grant = { id: randomBytes(32).toString('hex'), secret: randomBytes(32).toString('hex'), session }
    this.grants.set(grant.id, grant)
    this.sessions.set(session, grant.id)
    return {
      id: grant.id,
      cookie: `${cookieName}=${grant.secret}; Path=/api/session/resume/${grant.id}; HttpOnly; SameSite=Strict`,
    }
  }

  park(session: string, retirement: Promise<boolean>): void {
    const id = this.sessions.get(session)
    const grant = id === undefined ? undefined : this.grants.get(id)
    if (!grant || grant.parkedUntil !== undefined) return
    grant.parkedUntil = Date.now() + graceMs
    grant.retirement = retirement
  }

  revoke(session: string): void {
    const id = this.sessions.get(session)
    const grant = id === undefined ? undefined : this.grants.get(id)
    if (grant) this.forget(grant)
  }

  async claim(
    id: string,
    header: string | undefined,
    retire?: (session: string) => Promise<boolean>,
  ): Promise<'pending' | 'denied' | 'accepted'> {
    this.prune()
    if (!idPattern.test(id)) return 'denied'
    const grant = this.grants.get(id)
    const values = (header ?? '').split(';').map(item => item.trim())
      .filter(item => item.startsWith(`${cookieName}=`)).map(item => item.slice(cookieName.length + 1))
    const value = values.length === 1 ? values[0]! : ''
    if (
      !grant || !idPattern.test(value) || !timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(grant.secret, 'hex'))
    ) {
      return 'denied'
    }
    if (grant.consuming) return 'denied'
    if ((grant.parkedUntil === undefined || grant.retirement === undefined) && retire === undefined) return 'pending'
    grant.consuming = true
    // A browser may drop its pagehide keepalive. A valid tab handle and cookie
    // may request retirement, but never bypass the owner's confirmation.
    const confirmed = grant.retirement === undefined
      ? await retire!(grant.session).catch(() => false)
      : await grant.retirement.catch(() => false)
    const current = this.grants.get(id) === grant && grant.parkedUntil !== undefined
      && grant.retirement !== undefined && grant.parkedUntil > Date.now()
    this.forget(grant)
    return confirmed && current ? 'accepted' : 'denied'
  }

  deleteCookie(id: string): string {
    if (!idPattern.test(id)) throw new Error('manager-resume-invalid')
    return `${cookieName}=; Path=/api/session/resume/${id}; HttpOnly; SameSite=Strict; Max-Age=0`
  }

  close(): void {
    this.grants.clear()
    this.sessions.clear()
  }
}
