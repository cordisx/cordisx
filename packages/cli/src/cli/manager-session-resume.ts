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
  attempt?: string
  issued?: { readonly token: string; readonly resumeId: string }
}

type ResumedSession = { readonly token: string; readonly resumeId: string; readonly cookie: string }
type ResumeExchange = ResumedSession & { readonly retryCookie: string; readonly previousResumeId?: string }

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

  private authenticate(id: string, header: string | undefined): Grant | undefined {
    if (!idPattern.test(id)) return undefined
    const grant = this.grants.get(id)
    const values = (header ?? '').split(';').map(item => item.trim())
      .filter(item => item.startsWith(`${cookieName}=`)).map(item => item.slice(cookieName.length + 1))
    const value = values.length === 1 ? values[0]! : ''
    return grant && idPattern.test(value)
        && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(grant.secret, 'hex'))
      ? grant
      : undefined
  }

  private parked(grant: Grant): boolean {
    return this.grants.get(grant.id) === grant && grant.parkedUntil !== undefined
      && grant.retirement !== undefined && grant.parkedUntil > Date.now()
  }

  issue(session: string): { readonly id: string; readonly cookie: string } {
    if (!idPattern.test(session) || this.sessions.has(session)) throw new Error('manager-resume-invalid')
    this.prune()
    if (this.grants.size >= limit) {
      const parked = [...this.grants.values()].find(grant => grant.parkedUntil !== undefined && !grant.consuming)
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
    const grant = this.authenticate(id, header)
    if (!grant || grant.consuming || grant.attempt !== undefined) return 'denied'
    if ((grant.parkedUntil === undefined || grant.retirement === undefined) && retire === undefined) return 'pending'
    grant.consuming = true
    // A browser may drop its pagehide keepalive. A valid tab handle and cookie
    // may request retirement, but never bypass the owner's confirmation.
    const confirmed = grant.retirement === undefined
      ? await retire!(grant.session).catch(() => false)
      : await grant.retirement.catch(() => false)
    const current = this.parked(grant)
    this.forget(grant)
    return confirmed && current ? 'accepted' : 'denied'
  }

  /** Retry a lost exchange only for the same tab and before the replacement is used. */
  async exchange(
    id: string,
    header: string | undefined,
    attempt: string,
    retireOriginal: (session: string) => Promise<boolean>,
    retireIssued: (session: string) => Promise<boolean>,
    issue: () => Promise<ResumedSession | undefined>,
  ): Promise<'pending' | 'denied' | ResumeExchange> {
    this.prune()
    const grant = this.authenticate(id, header)
    if (!grant || !idPattern.test(attempt) || grant.attempt !== undefined && grant.attempt !== attempt) return 'denied'
    grant.attempt = attempt
    if (grant.consuming) return 'pending'
    grant.consuming = true
    try {
      const previous = grant.issued
      const confirmed = previous
        ? await retireIssued(previous.token).catch(() => false)
        : grant.retirement === undefined
        ? await retireOriginal(grant.session).catch(() => false)
        : await grant.retirement.catch(() => false)
      if (!confirmed || !this.parked(grant)) {
        this.forget(grant)
        return 'denied'
      }
      const issued = await issue()
      if (!issued) {
        this.forget(grant)
        return 'denied'
      }
      if (!this.parked(grant)) {
        await retireIssued(issued.token).catch(() => false)
        return 'denied'
      }
      grant.issued = { token: issued.token, resumeId: issued.resumeId }
      return {
        ...issued,
        retryCookie:
          `${cookieName}=${grant.secret}; Path=/api/session/resume/${grant.id}; HttpOnly; SameSite=Strict; Max-Age=${
            graceMs / 1_000
          }`,
        ...(previous === undefined ? {} : { previousResumeId: previous.resumeId }),
      }
    } catch (error) {
      this.forget(grant)
      throw error
    } finally {
      grant.consuming = false
    }
  }

  /** The first authenticated request makes the previous recovery handle unusable. */
  finalizeSession(session: string): readonly string[] {
    const finalized: string[] = []
    for (const grant of this.grants.values()) {
      if (grant.issued?.token !== session) continue
      finalized.push(grant.id)
      this.forget(grant)
    }
    return finalized
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

/** Validate and exchange one resume request, including the legacy one-use form. */
export async function exchangeManagerSessionResume(input: {
  readonly id: string
  readonly cookie: string | undefined
  readonly payload: Record<string, unknown>
  readonly grants: ManagerSessionResumeGrants
  readonly retireOriginal: (session: string) => Promise<boolean>
  readonly retireIssued: (session: string) => Promise<boolean>
  readonly issue: () => Promise<ResumedSession | undefined>
}): Promise<{ readonly status: number; readonly value: unknown; readonly cookies?: readonly string[] }> {
  const keys = Object.keys(input.payload)
  if (keys.length === 1 && typeof input.payload.attempt === 'string' && idPattern.test(input.payload.attempt)) {
    const exchanged = await input.grants.exchange(
      input.id,
      input.cookie,
      input.payload.attempt,
      input.retireOriginal,
      input.retireIssued,
      input.issue,
    )
    if (exchanged === 'pending') return { status: 409, value: { error: 'RESUME_PENDING' } }
    if (exchanged === 'denied') return { status: 401, value: { error: 'UNAUTHORIZED' } }
    return {
      status: 200,
      value: { token: exchanged.token, resumeId: exchanged.resumeId },
      cookies: [
        ...(exchanged.previousResumeId === undefined ? [] : [input.grants.deleteCookie(exchanged.previousResumeId)]),
        exchanged.retryCookie,
        exchanged.cookie,
      ],
    }
  }
  if (keys.length !== 0) return { status: 400, value: { error: 'INVALID_REQUEST' } }
  const claimed = await input.grants.claim(input.id, input.cookie, input.retireOriginal)
  if (claimed === 'pending') return { status: 409, value: { error: 'RESUME_PENDING' } }
  if (claimed !== 'accepted') return { status: 401, value: { error: 'UNAUTHORIZED' } }
  const issued = await input.issue()
  if (!issued) return { status: 401, value: { error: 'UNAUTHORIZED' } }
  return {
    status: 200,
    value: { token: issued.token, resumeId: issued.resumeId },
    cookies: [input.grants.deleteCookie(input.id), issued.cookie],
  }
}
