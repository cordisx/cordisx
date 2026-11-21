import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import { ManagerRendererWriteLifetimes } from './manager-renderer-write-lifetimes.js'
import { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'

/** Private to the owner RPC and sidecar memory. Never serialize to the browser. */
export interface ManagerRendererHandle {
  readonly rendererId: string
  readonly ownerGeneration: string
  readonly grant: string
}

export interface ManagerRendererInvocation {
  readonly gateway: ManagerRendererGatewayProof
  /** This is generated and maintained by the sidecar, not browser input. */
  readonly browserSessionId: string
  readonly handle: ManagerRendererHandle
}

export interface ManagerRendererChannelContext {
  readonly profileId: string
  readonly rendererId: string
  readonly ownerGeneration: string
  readonly signal: AbortSignal
  /** True only after this renderer joined the live lifecycle federation. */
  readonly admitted?: boolean
}

/**
 * `prepare` must validate every untrusted field and capability without doing
 * I/O or changing state. A channel is opt-in and owns its complete projection.
 * No default channels are installed by this module.
 */
export interface ManagerRendererChannel {
  prepare(payload: unknown, context: ManagerRendererChannelContext): {
    readonly mode: 'read' | 'write'
    dispatch(): Promise<unknown>
  }
}

export type ManagerRendererCallResult =
  | { readonly status: 'ok'; readonly value: unknown }
  | { readonly status: 'unavailable' }
  | { readonly status: 'unknown' }

interface Session {
  readonly gateway: ManagerRendererGatewayProof
  readonly browserSessionId: string
  readonly handle: ManagerRendererHandle
  readonly controller: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  peer?: ManagerRendererCommandPeer
  admission?: Promise<boolean>
  admitted?: boolean
  retirement?: Promise<boolean>
  inFlight: number
}

function secretEqual(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/u.test(left)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function gatewayMatches(left: ManagerRendererGatewayProof, right: ManagerRendererGatewayProof): boolean {
  return left !== null && typeof left === 'object' && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt && secretEqual(left.instanceToken, right.instanceToken)
}

/**
 * Per-owner-generation session authority. The sidecar is the only RPC caller;
 * HTTP handlers must derive browserSessionId and handle from their own session.
 */
export class ManagerRendererSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly usedBrowserSessions = new Set<string>()
  private readonly retiredSessions = new Map<
    string,
    { gateway: ManagerRendererGatewayProof; result: Promise<boolean> }
  >()
  private readonly pendingRetirements = new Set<Promise<boolean>>()
  private readonly retirementWaiters = new Set<() => void>()
  private readonly channels: ReadonlyMap<string, ManagerRendererChannel>
  private readonly writeLifetimes: ManagerRendererWriteLifetimes
  private readonly readLifetimes: ManagerRendererReadLifetimes
  private disposed = false
  private monitor: ReturnType<typeof setInterval> | undefined
  private monitoring = false
  private mutationFence: symbol | undefined
  private mutationsFenced = false
  private mutationUncertain = false
  private retirementUncertain = false
  private writesInFlight = 0
  private readonly writeWaiters = new Set<() => void>()
  private readonly writeContext = new AsyncLocalStorage<symbol>()

  constructor(
    private readonly input: {
      readonly profileId: string
      readonly ownerGeneration: string
      readonly ownerCurrent: () => boolean
      readonly authenticateGateway: (proof: ManagerRendererGatewayProof) => Promise<boolean>
      /** Wait for owner resources and profile fences belonging to this exact renderer. */
      readonly waitForRetirement?: (rendererId: string) => Promise<boolean>
      /** Shared with owner resources so their locks outlive a dispatched write. */
      readonly writeLifetimes?: ManagerRendererWriteLifetimes
      /** Shared with owner resources so their locks outlive a dispatched read. */
      readonly readLifetimes?: ManagerRendererReadLifetimes
      readonly channels?: ReadonlyMap<string, ManagerRendererChannel>
      /** The owner alone may enable a lifecycle participant and its admission. */
      readonly participant?: {
        readonly create: (input: {
          readonly gateway: ManagerRendererGatewayProof
          readonly browserSessionId: string
          readonly handle: ManagerRendererHandle
        }) => ManagerRendererCommandPeer
        readonly attach: (peer: ManagerRendererCommandPeer) => Promise<void>
      }
      readonly maxSessions?: number
      readonly sessionLifetimeMs?: number
      readonly monitorIntervalMs?: number
    },
  ) {
    // Copy the allowlist: a later mutation cannot silently add authority.
    this.channels = new Map(input.channels)
    this.writeLifetimes = input.writeLifetimes ?? new ManagerRendererWriteLifetimes()
    this.readLifetimes = input.readLifetimes ?? new ManagerRendererReadLifetimes()
  }

  private alive(): boolean {
    try {
      return !this.disposed && this.input.ownerCurrent()
    } catch {
      return false
    }
  }

  /** Only names are projected; owner-side dispatch remains the authority. */
  channelNames(): readonly string[] {
    return [...this.channels.keys()].filter(name => name !== 'manager-bootstrap')
  }

  commandsAvailable(): boolean {
    return this.input.participant !== undefined
  }

  /** Owner-only check before a sidecar action can discard a renderer's drafts. */
  hasLiveRenderers(): boolean {
    return this.pendingRetirements.size > 0 || this.retirementUncertain
      || [...this.sessions.values()].some(session => this.current(session))
  }

  mutationAvailability(): 'available' | 'busy' | 'unavailable' {
    if (!this.alive() || this.mutationsFenced || this.mutationUncertain || this.retirementUncertain) {
      return 'unavailable'
    }
    if (this.pendingRetirements.size > 0) return 'busy'
    return this.mutationFence === undefined ? 'available' : 'busy'
  }

  private retire(session: Session): Promise<boolean> {
    if (session.retirement) return session.retirement
    if (this.sessions.get(session.handle.rendererId) !== session) return Promise.resolve(true)
    this.sessions.delete(session.handle.rendererId)
    clearTimeout(session.timer)
    session.controller.abort()
    let finish!: (result: boolean) => void
    const retirement = new Promise<boolean>(resolve => {
      finish = resolve
    })
    session.retirement = retirement
    this.pendingRetirements.add(retirement)
    this.retiredSessions.set(session.browserSessionId, { gateway: session.gateway, result: retirement })
    const writes = this.writeLifetimes.retire(session.handle.rendererId)
    const reads = this.readLifetimes.retire(session.handle.rendererId)
    try {
      session.peer?.close()
      const resources = Promise.resolve().then(async () =>
        this.input.waitForRetirement ? await this.input.waitForRetirement(session.handle.rendererId) : true
      )
      void Promise.all([writes, reads, resources]).then(
        ([settled, , released]) => finish(settled && released),
        () => finish(false),
      )
    } catch {
      finish(false)
    }
    void retirement.then(result => {
      this.pendingRetirements.delete(retirement)
      if (!result) {
        this.retirementUncertain = true
        this.fenceMutations()
      }
      for (const notify of this.retirementWaiters) notify()
    })
    if (this.sessions.size === 0 && this.monitor !== undefined) {
      clearInterval(this.monitor)
      this.monitor = undefined
    }
    return session.retirement
  }

  private retireGateway(gateway: ManagerRendererGatewayProof): void {
    for (const session of this.sessions.values()) {
      if (gatewayMatches(gateway, session.gateway)) this.retire(session)
    }
  }

  private startMonitor(): void {
    if (this.monitor !== undefined) return
    this.monitor = setInterval(() => {
      if (this.monitoring) return
      this.monitoring = true
      void (async () => {
        if (!this.alive()) {
          for (const session of this.sessions.values()) this.retire(session)
          return
        }
        const gateways = new Map<string, ManagerRendererGatewayProof>()
        for (const session of this.sessions.values()) gateways.set(session.gateway.instanceToken, session.gateway)
        for (const gateway of gateways.values()) {
          if (!await this.authenticated(gateway)) this.retireGateway(gateway)
        }
      })().finally(() => {
        this.monitoring = false
      })
    }, Math.max(100, this.input.monitorIntervalMs ?? 10_000))
    this.monitor.unref()
  }

  private async authenticated(proof: ManagerRendererGatewayProof): Promise<boolean> {
    try {
      return this.alive() && await this.input.authenticateGateway(proof) && this.alive()
    } catch {
      return false
    }
  }

  async open(
    gateway: ManagerRendererGatewayProof,
    browserSessionId: string,
  ): Promise<ManagerRendererHandle | undefined> {
    if (typeof browserSessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(browserSessionId)) return undefined
    if (!await this.authenticated(gateway)) return undefined
    // All admission checks are synchronous after authentication, so concurrent
    // opens cannot create two renderer identities for one browser session.
    if (
      this.usedBrowserSessions.has(browserSessionId) || this.usedBrowserSessions.size >= 4096
      || this.sessions.size >= (this.input.maxSessions ?? 16)
      || this.mutationsFenced || this.mutationUncertain || this.mutationFence !== undefined || this.retirementUncertain
      || this.pendingRetirements.size > 0
    ) return undefined
    const handle: ManagerRendererHandle = {
      rendererId: randomBytes(32).toString('hex'),
      ownerGeneration: this.input.ownerGeneration,
      grant: randomBytes(32).toString('hex'),
    }
    const controller = new AbortController()
    const lifetime = Math.max(1, Math.min(this.input.sessionLifetimeMs ?? 8 * 60 * 60 * 1000, 8 * 60 * 60 * 1000))
    let session: Session
    const timer = setTimeout(() => this.retire(session), lifetime)
    timer.unref()
    session = { gateway: { ...gateway }, browserSessionId, handle, controller, timer, inFlight: 0 }
    this.usedBrowserSessions.add(browserSessionId)
    this.sessions.set(handle.rendererId, session)
    if (this.input.participant !== undefined) {
      try {
        const peer = this.input.participant.create({ gateway: session.gateway, browserSessionId, handle })
        if (
          peer.closed || peer.sessionId !== browserSessionId || peer.identity.rendererId !== handle.rendererId
          || peer.identity.pid !== gateway.pid || peer.identity.processStartedAt !== gateway.processStartedAt
          || peer.scope.profileId !== this.input.profileId || peer.scope.generation !== this.input.ownerGeneration
        ) {
          peer.close()
          throw new Error('renderer-peer-unavailable')
        }
        session.peer = peer
        peer.onDisconnect(() => this.retire(session))
      } catch {
        this.retire(session)
        return undefined
      }
    }
    this.startMonitor()
    return { ...handle }
  }

  /** Begin federation only after the browser has started polling for synchronize. */
  async admit(invocation: ManagerRendererInvocation): Promise<ManagerRendererCallResult> {
    const session = this.lookup(invocation)
    const peer = session?.peer
    const participant = this.input.participant
    if (!session || !peer || !participant || !this.current(session) || session.inFlight >= 8) {
      return { status: 'unavailable' }
    }
    session.inFlight++
    try {
      if (!await this.authenticated(session.gateway) || !this.current(session)) return { status: 'unavailable' }
      session.admission ??= Promise.resolve().then(() => participant.attach(peer)).then(() => true).catch(() => {
        peer.close()
        return false
      })
      const attached = await session.admission
      if (!attached || !this.current(session) || peer.closed || !await this.authenticated(session.gateway)) {
        peer.close()
        return { status: 'unavailable' }
      }
      if (!this.current(session)) return { status: 'unavailable' }
      session.admitted = true
      return { status: 'ok', value: { admitted: true } }
    } finally {
      session.inFlight--
    }
  }

  /** One owner command may be handed to this session at most once. */
  async poll(invocation: ManagerRendererInvocation, timeoutMs: number): Promise<ManagerRendererCallResult> {
    const session = this.lookup(invocation)
    const peer = session?.peer
    if (!session || !peer || !this.current(session) || session.inFlight >= 8) return { status: 'unavailable' }
    session.inFlight++
    let offered = false
    try {
      if (!await this.authenticated(session.gateway) || !this.current(session)) return { status: 'unavailable' }
      const command = await peer.next({ signal: session.controller.signal, timeoutMs })
      offered = command !== undefined
      if (!this.current(session) || peer.closed || !await this.authenticated(session.gateway)) {
        if (offered) peer.close()
        return { status: offered ? 'unknown' : 'unavailable' }
      }
      if (!this.current(session)) {
        if (offered) peer.close()
        return { status: offered ? 'unknown' : 'unavailable' }
      }
      return { status: 'ok', value: { command: command ?? null } }
    } catch {
      // A command may have been offered; never replay it after transport loss.
      if (offered) peer.close()
      return { status: offered ? 'unknown' : 'unavailable' }
    } finally {
      session.inFlight--
    }
  }

  /** Acknowledgements are consumed once and never automatically retried. */
  async acknowledge(invocation: ManagerRendererInvocation, receipt: unknown): Promise<ManagerRendererCallResult> {
    const session = this.lookup(invocation)
    const peer = session?.peer
    if (!session || !peer || !this.current(session) || session.inFlight >= 8) return { status: 'unavailable' }
    session.inFlight++
    let consumed = false
    try {
      if (!await this.authenticated(session.gateway) || !this.current(session)) return { status: 'unavailable' }
      const encoded = JSON.stringify(receipt)
      if (encoded === undefined || Buffer.byteLength(encoded) > 196 * 1024) return { status: 'unavailable' }
      consumed = peer.acknowledge(receipt)
      if (!consumed) return { status: 'unavailable' }
      if (!this.current(session) || peer.closed || !await this.authenticated(session.gateway)) {
        return { status: 'unknown' }
      }
      return this.current(session) ? { status: 'ok', value: { accepted: true } } : { status: 'unknown' }
    } catch {
      return { status: consumed ? 'unknown' : 'unavailable' }
    } finally {
      session.inFlight--
    }
  }

  private lookup(invocation: ManagerRendererInvocation): Session | undefined {
    const handle = invocation?.handle
    if (!handle || typeof handle.rendererId !== 'string') return undefined
    const session = this.sessions.get(handle.rendererId)
    if (
      !session || invocation.browserSessionId !== session.browserSessionId
      || handle.ownerGeneration !== session.handle.ownerGeneration || !secretEqual(handle.grant, session.handle.grant)
      || !gatewayMatches(invocation.gateway, session.gateway)
    ) return undefined
    return session
  }

  private current(session: Session): boolean {
    return this.alive() && !session.controller.signal.aborted
      && this.sessions.get(session.handle.rendererId) === session
  }

  async call(
    invocation: ManagerRendererInvocation,
    channel: string,
    payload: unknown,
  ): Promise<ManagerRendererCallResult> {
    const unavailable: ManagerRendererCallResult = { status: 'unavailable' }
    const session = this.lookup(invocation)
    if (!session || !this.current(session) || session.inFlight >= 8) return unavailable
    const target = typeof channel === 'string' ? this.channels.get(channel) : undefined
    if (!target) return unavailable
    session.inFlight++
    let dispatched: 'read' | 'write' | undefined
    let trackedWrite = false
    let finishWrite: (() => void) | undefined
    let finishRead: (() => void) | undefined
    const unknown = (): ManagerRendererCallResult => {
      this.mutationUncertain = true
      this.fenceMutations()
      return { status: 'unknown' }
    }
    try {
      if (!await this.authenticated(session.gateway)) {
        this.retireGateway(session.gateway)
        return unavailable
      }
      if (!this.current(session)) return unavailable
      const encoded = JSON.stringify(payload)
      if (encoded === undefined || Buffer.byteLength(encoded) > 256 * 1024) return unavailable
      const prepared = target.prepare(payload, {
        profileId: this.input.profileId,
        rendererId: session.handle.rendererId,
        ownerGeneration: this.input.ownerGeneration,
        signal: session.controller.signal,
        admitted: session.admitted === true && session.peer !== undefined && !session.peer.closed,
      })
      if (prepared.mode !== 'read' && prepared.mode !== 'write') return unavailable
      if (prepared.mode === 'write') {
        if (
          this.mutationsFenced || this.mutationUncertain || this.mutationFence !== undefined
          || this.retirementUncertain || this.pendingRetirements.size > 0
        ) return unavailable
        finishWrite = this.writeLifetimes.begin(session.handle.rendererId)
        if (!finishWrite) return unavailable
        this.writesInFlight++
        trackedWrite = true
      } else {
        finishRead = this.readLifetimes.begin(session.handle.rendererId)
        if (!finishRead) return unavailable
      }
      dispatched = prepared.mode
      const value = trackedWrite
        ? await this.writeContext.run(Symbol('manager-write'), async () => await prepared.dispatch())
        : await prepared.dispatch()
      if (!this.current(session)) return dispatched === 'write' ? unknown() : unavailable
      if (!await this.authenticated(session.gateway)) {
        this.retireGateway(session.gateway)
        return dispatched === 'write' ? unknown() : unavailable
      }
      if (!this.current(session)) return dispatched === 'write' ? unknown() : unavailable
      return { status: 'ok', value }
    } catch {
      // An in-flight write can have committed even if its result was lost.
      return dispatched === 'write' ? unknown() : unavailable
    } finally {
      if (trackedWrite) {
        this.writesInFlight--
        if (this.writesInFlight === 0) { for (const notify of this.writeWaiters) notify() }
        finishWrite?.()
      }
      finishRead?.()
      session.inFlight--
    }
  }

  /**
   * Freeze new Manager writes and admissions before a profile owner drains its
   * other writers and consumers. This does not itself cover non-Manager paths.
   */
  async suspendMutations(timeoutMs = 15_000): Promise<{ isCurrent(): boolean; release(): boolean; fence(): void }> {
    if (
      !this.alive() || this.mutationsFenced || this.mutationUncertain || this.mutationFence !== undefined
      || this.retirementUncertain || this.pendingRetirements.size > 0
      || this.writeContext.getStore() !== undefined
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    ) throw new Error('renderer-mutation-fence-unavailable')
    const reservation = Symbol('manager-mutation-fence')
    this.mutationFence = reservation
    const drained = await this.waitForWrites(timeoutMs)
    if (
      !drained || !this.alive() || this.mutationUncertain || this.mutationFence !== reservation
    ) {
      this.fenceMutations()
      throw new Error('renderer-mutation-fence-unavailable')
    }
    let ended = false
    const current = () =>
      !ended && this.alive() && !this.mutationsFenced && !this.mutationUncertain && this.mutationFence === reservation
      && !this.retirementUncertain && this.pendingRetirements.size === 0 && this.writesInFlight === 0
    return {
      isCurrent: current,
      release: () => {
        if (ended) return false
        if (!current()) {
          ended = true
          this.fenceMutations()
          return false
        }
        ended = true
        this.mutationFence = undefined
        return true
      },
      fence: () => {
        if (ended) return
        ended = true
        this.fenceMutations()
      },
    }
  }

  private async waitForWrites(timeoutMs: number): Promise<boolean> {
    if (this.writesInFlight === 0) return true
    return await new Promise(resolve => {
      const finish = (value: boolean) => {
        clearTimeout(timer)
        this.writeWaiters.delete(check)
        resolve(value)
      }
      const check = () => {
        if (this.disposed || this.writesInFlight === 0) finish(!this.disposed && this.writesInFlight === 0)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
      this.writeWaiters.add(check)
      check()
    })
  }

  /** Wait for all peer-specific resource and profile-fence release receipts. */
  async waitForRetirements(timeoutMs = 15_000): Promise<boolean> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) return false
    if (this.disposed || this.retirementUncertain) return false
    if (this.pendingRetirements.size === 0) return true
    return await new Promise(resolve => {
      const finish = (value: boolean) => {
        clearTimeout(timer)
        this.retirementWaiters.delete(check)
        resolve(value)
      }
      const check = () => {
        if (this.disposed || this.retirementUncertain || this.pendingRetirements.size === 0) {
          finish(!this.disposed && !this.retirementUncertain && this.pendingRetirements.size === 0)
        }
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
      this.retirementWaiters.add(check)
      check()
    })
  }

  private fenceMutations(): void {
    this.mutationsFenced = true
    for (const session of this.sessions.values()) this.retire(session)
  }

  async close(invocation: ManagerRendererInvocation): Promise<boolean> {
    const session = this.lookup(invocation)
    if (!session) return false
    // Retire before the asynchronous gateway check so in-flight work is fenced
    // immediately; an invalid caller cannot pass lookup without the private grant.
    const retired = this.retire(session)
    return await this.authenticated(session.gateway) && await retired
  }

  /** Retire a browser session even when its open request is still in flight. */
  async revoke(gateway: ManagerRendererGatewayProof, browserSessionId: string): Promise<boolean> {
    if (
      typeof browserSessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(browserSessionId)
      || !await this.authenticated(gateway)
    ) return false
    // Tombstone before walking live sessions, so an overlapping open cannot
    // create a renderer after this revocation. The finite cap fails closed.
    if (!this.usedBrowserSessions.has(browserSessionId) && this.usedBrowserSessions.size >= 4096) return false
    this.usedBrowserSessions.add(browserSessionId)
    for (const session of this.sessions.values()) {
      if (session.browserSessionId === browserSessionId && gatewayMatches(gateway, session.gateway)) {
        this.retire(session)
      }
    }
    const retired = this.retiredSessions.get(browserSessionId)
    if (!retired) return true
    return gatewayMatches(gateway, retired.gateway) && await retired.result
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) this.retire(session)
    for (const notify of this.writeWaiters) notify()
    for (const notify of this.retirementWaiters) notify()
  }
}
