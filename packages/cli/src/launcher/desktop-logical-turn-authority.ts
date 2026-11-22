import { randomBytes } from 'node:crypto'
import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'

interface Ticket {
  scope: NativeSubmissionScope
  identity: string
  threadId: string
  attached: boolean
  expiresAt: number
  state: 'issued' | 'starting' | 'active'
  observedTurn?: string
  confirmedTurn?: string
  requestId?: string | number
}
const sameScope = (left: NativeSubmissionScope, right: NativeSubmissionScope) =>
  left.targetId === right.targetId && left.rendererGeneration === right.rendererGeneration
  && left.navigationGeneration === right.navigationGeneration && left.composerId === right.composerId
  && left.threadId === right.threadId

/** An unguessable Host-issued ticket ties a real submitted request to one native turn and account. */
export class DesktopLogicalTurnAuthority {
  private readonly tickets = new Map<string, Ticket>()
  private readonly waiters = new Map<string, Set<() => void>>()
  constructor(
    private readonly identity: (scope: NativeSubmissionScope) => Promise<string | undefined>,
    private readonly ownerIdentity: (scope: NativeSubmissionScope) => Promise<string | undefined> = identity,
    private readonly dispatchIdentity: (scope: NativeSubmissionScope) => Promise<string | undefined> = identity,
  ) {}
  private prune(): void {
    for (const [token, ticket] of this.tickets) {
      if (ticket.state !== 'active' && ticket.expiresAt + (ticket.attached ? 600_000 : 0) <= Date.now()) {
        this.tickets.delete(token)
      }
    }
  }
  async issue(
    scope: NativeSubmissionScope,
    targetThreadId = scope.threadId,
    attachedToken?: string,
  ): Promise<string | undefined> {
    this.prune()
    if (
      !scope.threadId || !targetThreadId || targetThreadId.length > 512 || /[\0\r\n]/u.test(targetThreadId)
      || attachedToken !== undefined && (attachedToken.length < 16 || attachedToken.length > 256
          || /[\0\r\n]/u.test(attachedToken) || this.tickets.has(attachedToken))
      || this.tickets.size >= 512
    ) return undefined
    const identity = await this.identity(scope)
    if (!identity || this.tickets.size >= 512) return undefined
    const token = attachedToken ?? randomBytes(32).toString('hex')
    if (this.tickets.has(token)) return undefined
    this.tickets.set(token, {
      scope: structuredClone(scope),
      identity,
      threadId: targetThreadId,
      attached: attachedToken !== undefined,
      expiresAt: Date.now() + 60_000,
      state: 'issued',
    })
    return token
  }
  owns(token: string): boolean {
    return this.tickets.has(token)
  }
  attached(token: string): boolean {
    return this.tickets.get(token)?.attached === true
  }
  async begin(token: string, threadId: string, requestId: string | number): Promise<boolean> {
    this.prune()
    const ticket = this.tickets.get(token)
    if (
      !ticket || ticket.state !== 'issued' || ticket.threadId !== threadId || ticket.expiresAt <= Date.now()
      || [...this.tickets.values()].some(other =>
        other !== ticket && other.threadId === threadId
        && other.state !== 'issued'
      )
    ) return false
    if (
      await this.dispatchIdentity(ticket.scope) !== ticket.identity || this.tickets.get(token) !== ticket
      || ticket.state !== 'issued' || ticket.expiresAt <= Date.now()
      || [...this.tickets.values()].some(other =>
        other !== ticket && other.threadId === threadId
        && other.state !== 'issued'
      )
    ) return false
    ticket.state = 'starting'
    ticket.requestId = requestId
    return true
  }
  async authorize(token: string, requestId: string | number): Promise<boolean> {
    const ticket = this.tickets.get(token)
    if (!ticket || ticket.state !== 'starting' || ticket.requestId !== requestId || ticket.expiresAt <= Date.now()) {
      return false
    }
    return await this.dispatchIdentity(ticket.scope) === ticket.identity && this.tickets.get(token) === ticket
      && ticket.state === 'starting' && ticket.requestId === requestId
  }
  confirm(token: string, threadId: string, turnId: string, requestId: string | number): boolean {
    const ticket = this.tickets.get(token)
    if (
      !ticket || ticket.state !== 'starting' || ticket.expiresAt <= Date.now()
      || ticket.threadId !== threadId || ticket.requestId !== requestId || !turnId
      || ticket.observedTurn && ticket.observedTurn !== turnId
    ) {
      this.tickets.delete(token)
      this.signal(threadId)
      return false
    }
    ticket.confirmedTurn = turnId
    if (ticket.observedTurn === turnId) ticket.state = 'active'
    this.signal(threadId)
    return true
  }
  observe(method: string, params: unknown): void {
    const value = params as { threadId?: unknown; turn?: { id?: unknown } } | null
    const threadId = value?.threadId, turnId = value?.turn?.id
    if (typeof threadId !== 'string' || typeof turnId !== 'string') return
    for (const [token, ticket] of this.tickets) {
      if (ticket.threadId !== threadId || ticket.state === 'issued') continue
      if (
        method === 'turn/completed' && (!ticket.observedTurn && !ticket.confirmedTurn
          || ticket.observedTurn === turnId || ticket.confirmedTurn === turnId)
      ) {
        this.tickets.delete(token)
      } else if (method === 'turn/started' && ticket.state === 'starting') {
        if (
          ticket.observedTurn && ticket.observedTurn !== turnId
          || ticket.confirmedTurn && ticket.confirmedTurn !== turnId
        ) {
          this.tickets.delete(token)
        } else {
          ticket.observedTurn = turnId
          if (ticket.confirmedTurn === turnId) ticket.state = 'active'
        }
      }
    }
    this.signal(threadId)
  }
  async activeIdentity(threadId: string, turnId: string): Promise<string | undefined> {
    const waiting = [...this.tickets.values()].some(ticket =>
      ticket.state === 'starting'
      && ticket.threadId === threadId && ticket.observedTurn === turnId && !ticket.confirmedTurn
    )
    if (waiting) await this.waitForConfirmation(threadId)
    const matches = [...this.tickets.values()].filter(ticket =>
      ticket.state === 'active'
      && ticket.threadId === threadId && ticket.confirmedTurn === turnId
    )
    if (matches.length !== 1) return undefined
    const ticket = matches[0]!
    const identity = await this.ownerIdentity(ticket.scope)
    return identity === ticket.identity && [...this.tickets.values()].includes(ticket) && ticket.state === 'active'
      ? identity
      : undefined
  }
  cancel(token: string): void {
    const threadId = this.tickets.get(token)?.threadId
    this.tickets.delete(token)
    if (threadId) this.signal(threadId)
  }
  cancelForScope(token: string, scope: NativeSubmissionScope): boolean {
    const ticket = this.tickets.get(token)
    if (!ticket || ticket.state !== 'issued' || !sameScope(ticket.scope, scope)) return false
    this.cancel(token)
    return true
  }
  releaseScope(scope: NativeSubmissionScope): void {
    for (const [token, ticket] of this.tickets) {
      if (ticket.state === 'issued' && sameScope(ticket.scope, scope)) this.cancel(token)
    }
  }
  clear(): void {
    this.tickets.clear()
    for (const threadId of this.waiters.keys()) this.signal(threadId)
  }
  private signal(threadId: string): void {
    const waiters = this.waiters.get(threadId)
    this.waiters.delete(threadId)
    waiters?.forEach(resolve => resolve())
  }
  private async waitForConfirmation(threadId: string): Promise<void> {
    await new Promise<void>(resolve => {
      const waiters = this.waiters.get(threadId) ?? new Set<() => void>()
      const finish = () => {
        clearTimeout(timer)
        waiters.delete(finish)
        if (!waiters.size) this.waiters.delete(threadId)
        resolve()
      }
      const timer = setTimeout(finish, 2_000)
      waiters.add(finish)
      this.waiters.set(threadId, waiters)
    })
  }
}
