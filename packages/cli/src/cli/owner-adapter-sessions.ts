import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import {
  attachmentEqual,
  type RendererAttachmentIdentity,
  type RendererAttachmentScope,
} from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import { OwnerAdapterAdmission } from './owner-adapter-admission.js'
import { processIdentityStatus } from './supervisor-state.js'
import { parseMarketplaceArtifactBindingRequest } from '../launcher/marketplace-artifact.js'
import { createOwnerPolicySigner } from './owner-policy-signature.js'
import { type OwnerPolicyTransition, parseOwnerPolicyTransition } from '../owner-policy-handoff.js'

type Snapshot = Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
type Session = {
  readonly id: string
  readonly grant: string
  readonly documentSecret: string
  readonly policySigner: ReturnType<typeof createOwnerPolicySigner>
  readonly pid: number
  readonly processStartedAt: string
  readonly peer: ManagerRendererCommandPeer
  readonly controller: AbortController
  readonly releasePermissionFence?: () => Promise<void>
  readonly snapshot: Snapshot
  readonly artifacts: Map<string, AbortController>
  readonly cancelledArtifacts: Map<string, number>
  touched: number
  admitted: boolean
  admission?: Promise<boolean>
}

export type OwnerAdapterSessionOperation =
  | { readonly action: 'open'; readonly pid: number; readonly processStartedAt: string }
  | { readonly action: 'admit' | 'close'; readonly sessionId: string; readonly grant: string }
  | { readonly action: 'model-services-read'; readonly sessionId: string; readonly grant: string }
  | { readonly action: 'poll'; readonly sessionId: string; readonly grant: string; readonly timeoutMs: number }
  | { readonly action: 'acknowledge'; readonly sessionId: string; readonly grant: string; readonly receipt: unknown }
  | { readonly action: 'lifecycle'; readonly sessionId: string; readonly grant: string; readonly payload: unknown }
  | { readonly action: 'management'; readonly sessionId: string; readonly grant: string; readonly payload: unknown }
  | { readonly action: 'document'; readonly sessionId: string; readonly grant: string; readonly payload: unknown }
  | { readonly action: 'artifact'; readonly sessionId: string; readonly grant: string; readonly payload: unknown }

/** Private, session-bound authority; no secret is sent to a plugin Context. */
export interface OwnerAdapterDocumentContext {
  readonly secret: string
  current(write: boolean): boolean
}

/** The owner derives this identity from the admitted adapter session. */
export interface OwnerAdapterManagementContext extends OwnerAdapterDocumentContext {
  readonly rendererId: string
  readonly signal: AbortSignal
  live(): boolean
}

const secretPattern = /^[a-f0-9]{64}$/u
const secret = () => randomBytes(32).toString('hex')
const matches = (left: string, right: string) =>
  secretPattern.test(left) && secretPattern.test(right)
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))

/**
 * Private service-owner authority for one kind of native adapter. The caller
 * must authenticate the surrounding same-user transport before dispatching.
 * A session is bound to a live client process and retires if it stops polling.
 */
export class OwnerAdapterSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly callContext = new AsyncLocalStorage<symbol>()
  private readonly calls = new Set<symbol>()
  private readonly callOwners = new Map<symbol, Session>()
  private readonly callsChanged = new Set<() => void>()
  private readonly admission: OwnerAdapterAdmission
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly identify: typeof processIdentityStatus
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private fenced = false
  private reservation: symbol | undefined

  constructor(
    private readonly input: {
      readonly scope: RendererAttachmentScope
      readonly adapter: Readonly<{ appId: string; adapterId: string }>
      readonly snapshot: () => Snapshot
      readonly attach: (peer: ManagerRendererCommandPeer) => Promise<void>
      readonly lifecycle?: (payload: unknown, context: OwnerAdapterManagementContext) => Promise<unknown>
      readonly management?: (payload: unknown, context: OwnerAdapterManagementContext) => Promise<unknown>
      readonly document?: (payload: unknown, context: OwnerAdapterDocumentContext) => Promise<unknown>
      readonly modelServicesRead?: () => Promise<unknown>
      readonly artifact?: (payload: unknown, signal: AbortSignal) => Promise<unknown>
      /** Owner-held profile fence, shared with the Web fleet. */
      readonly acquirePermissionFence?: () => Promise<() => Promise<void>>
      readonly ownerCurrent: () => boolean
      readonly now?: () => number
      readonly identify?: typeof processIdentityStatus
      readonly timeoutMs?: number
    },
  ) {
    this.now = input.now ?? (() => performance.now())
    this.identify = input.identify ?? processIdentityStatus
    this.timeoutMs = input.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 10 * 60_000) {
      throw new Error('adapter-session-timeout-invalid')
    }
    this.admission = new OwnerAdapterAdmission({
      scope: input.scope,
      now: this.now,
      attach: async peer => await input.attach(peer as ManagerRendererCommandPeer),
    })
  }

  private current(): boolean {
    try {
      return !this.closed && !this.fenced && this.input.ownerCurrent() === true
    } catch {
      return false
    }
  }

  private retire(session: Session): void {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    session.controller.abort()
    if (session.releasePermissionFence) {
      void session.releasePermissionFence().catch(() => {
        // Do not admit a replacement after a profile lock release becomes uncertain.
        this.fenced = true
      })
    }
    for (const controller of session.artifacts.values()) controller.abort()
    session.artifacts.clear()
    session.cancelledArtifacts.clear()
    session.peer.close()
    if (this.sessions.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private startMonitor(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!this.current() || this.now() - session.touched >= this.timeoutMs) this.retire(session)
      }
    }, Math.min(5_000, this.timeoutMs))
    this.timer.unref()
  }

  private async lookup(sessionId: string, grant: string): Promise<Session | undefined> {
    if (!this.current() || !secretPattern.test(sessionId) || !secretPattern.test(grant)) return undefined
    const session = this.sessions.get(sessionId)
    if (!session || !matches(session.grant, grant)) return undefined
    if (session.peer.closed || this.now() - session.touched >= this.timeoutMs) {
      this.retire(session)
      return undefined
    }
    const live = await this.identify(session.pid, session.processStartedAt).catch(() => 'unknown' as const)
    if (!this.current() || this.sessions.get(sessionId) !== session || session.peer.closed || live !== 'alive') {
      this.retire(session)
      return undefined
    }
    session.touched = this.now()
    return session
  }

  async open(request: { readonly pid: number; readonly processStartedAt: string }): Promise<
    | {
      readonly sessionId: string
      readonly grant: string
      readonly documentSecret: string
      readonly policyPublicKey: string
      readonly rendererId: string
      readonly snapshot: Snapshot
    }
    | undefined
  > {
    if (
      !this.current() || !Number.isSafeInteger(request.pid) || request.pid <= 0
      || typeof request.processStartedAt !== 'string' || request.processStartedAt.length === 0
      || request.processStartedAt.length > 256
    ) return undefined
    if (await this.identify(request.pid, request.processStartedAt).catch(() => 'unknown' as const) !== 'alive') {
      return undefined
    }
    if (!this.current()) return undefined
    let releasePermissionFence: (() => Promise<void>) | undefined
    let snapshot: Snapshot
    try {
      releasePermissionFence = await this.input.acquirePermissionFence?.()
      if (
        !this.current()
        || await this.identify(request.pid, request.processStartedAt).catch(() => 'unknown' as const) !== 'alive'
      ) throw new Error('stale')
      snapshot = structuredClone(this.input.snapshot())
      if (
        snapshot.active.profileId !== this.input.scope.profileId
        || snapshot.active.runtimeGeneration !== this.input.scope.generation
        || !Number.isSafeInteger(snapshot.registryEpoch) || snapshot.registryEpoch < 0
      ) throw new Error('stale')
    } catch {
      await releasePermissionFence?.().catch(() => {
        this.fenced = true
      })
      return undefined
    }
    const gateway = { pid: request.pid, processStartedAt: request.processStartedAt, instanceToken: secret() }
    let sessionId: string | undefined
    let peer: ManagerRendererCommandPeer | undefined
    let transferredFence = false
    try {
      sessionId = this.admission.issue(this.input.adapter, gateway)
      const handle = { rendererId: secret(), ownerGeneration: this.input.scope.generation, grant: secret() }
      peer = this.admission.participant.create({ gateway, browserSessionId: sessionId, handle })
      if (!this.current() || !attachmentEqual(this.input.snapshot(), snapshot)) throw new Error('stale')
      const session: Session = {
        id: sessionId,
        grant: handle.grant,
        documentSecret: secret(),
        policySigner: createOwnerPolicySigner(),
        pid: request.pid,
        processStartedAt: request.processStartedAt,
        peer,
        controller: new AbortController(),
        ...(releasePermissionFence === undefined ? {} : { releasePermissionFence }),
        snapshot,
        artifacts: new Map(),
        cancelledArtifacts: new Map(),
        touched: this.now(),
        admitted: false,
      }
      this.sessions.set(sessionId, session)
      transferredFence = true
      peer.onDisconnect(() => this.retire(session))
      this.startMonitor()
      return {
        sessionId,
        grant: handle.grant,
        documentSecret: session.documentSecret,
        policyPublicKey: session.policySigner.publicKey,
        rendererId: handle.rendererId,
        snapshot: structuredClone(snapshot),
      }
    } catch {
      peer?.close()
      if (sessionId) this.admission.revokeGrant(sessionId)
      if (!transferredFence) {
        await releasePermissionFence?.().catch(() => {
          this.fenced = true
        })
      }
      return undefined
    }
  }

  async admit(sessionId: string, grant: string): Promise<boolean> {
    const session = await this.lookup(sessionId, grant)
    if (!session || session.admitted) return false
    session.admission ??= this.admission.participant.attach(session.peer).then(() => {
      if (!this.current() || this.sessions.get(sessionId) !== session || session.peer.closed) return false
      session.admitted = true
      return true
    }).catch(() => false)
    const admitted = await session.admission
    if (!admitted) this.retire(session)
    return admitted
  }

  async poll(sessionId: string, grant: string, timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > Math.min(30_000, this.timeoutMs / 2)) {
      return undefined
    }
    const session = await this.lookup(sessionId, grant)
    if (!session) return undefined
    try {
      const command = await session.peer.next({ timeoutMs })
      if (!this.current() || this.sessions.get(sessionId) !== session || session.peer.closed) return undefined
      session.touched = this.now()
      return { command: command ?? null }
    } catch {
      this.retire(session)
      return undefined
    }
  }

  async acknowledge(sessionId: string, grant: string, receipt: unknown): Promise<boolean> {
    const session = await this.lookup(sessionId, grant)
    if (!session) return false
    const accepted = session.peer.acknowledge(receipt)
    if (!accepted) this.retire(session)
    return accepted
  }

  async end(sessionId: string, grant: string): Promise<boolean> {
    const session = await this.lookup(sessionId, grant)
    if (!session) return false
    this.retire(session)
    return true
  }

  /** A native renderer can request lifecycle work only after joining this owner. */
  async requestLifecycle(sessionId: string, grant: string, payload: unknown): Promise<
    { readonly available: true; readonly value: unknown } | { readonly available: false }
  > {
    return await this.invoke(sessionId, grant, payload, this.input.lifecycle)
  }

  async requestManagement(sessionId: string, grant: string, payload: unknown): Promise<
    { readonly available: true; readonly value: unknown } | { readonly available: false }
  > {
    const registration = Boolean(
      payload && typeof payload === 'object' && !Array.isArray(payload)
        && (payload as Record<string, unknown>).kind === 'permission-key-register',
    )
    return await this.invoke(sessionId, grant, payload, this.input.management, registration, registration)
  }

  async requestDocument(sessionId: string, grant: string, payload: unknown): Promise<
    { readonly available: true; readonly value: unknown } | { readonly available: false }
  > {
    const operation = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).operation
      : undefined
    const read = operation === 'load'
    return await this.invoke(sessionId, grant, payload, this.input.document, read, true)
  }

  /** Read only the owner's redacted shared model-service snapshot. */
  async requestModelServicesRead(sessionId: string, grant: string): Promise<
    { readonly available: true; readonly value: unknown } | { readonly available: false }
  > {
    if (!this.input.modelServicesRead) return { available: false }
    return await this.invoke(
      sessionId,
      grant,
      undefined,
      async () => await this.input.modelServicesRead!(),
      false,
      true,
    )
  }

  /** Artifact downloads belong to the service and cancellation is scoped to the initiating adapter. */
  async requestArtifact(sessionId: string, grant: string, payload: unknown): Promise<
    { readonly available: true; readonly value: unknown } | { readonly available: false }
  > {
    const session = await this.lookup(sessionId, grant)
    if (!session?.admitted || !this.input.artifact) return { available: false }
    const request = parseMarketplaceArtifactBindingRequest(payload)
    for (const [id, expiry] of session.cancelledArtifacts) {
      if (expiry <= this.now()) session.cancelledArtifacts.delete(id)
    }
    if (request.kind === 'cancel') {
      const pending = session.artifacts.get(request.targetRequestId)
      if (pending) pending.abort()
      else {
        if (session.cancelledArtifacts.size >= 64) throw new Error('adapter-artifact-request-unavailable')
        // Cancellation may overtake the first request on the private socket.
        session.cancelledArtifacts.set(request.targetRequestId, this.now() + 180_000)
      }
      return { available: true, value: null }
    }
    if (session.cancelledArtifacts.delete(request.requestId)) return { available: false }
    if (session.artifacts.has(request.requestId) || session.artifacts.size >= 2) {
      throw new Error('adapter-artifact-request-unavailable')
    }
    const controller = new AbortController()
    session.artifacts.set(request.requestId, controller)
    try {
      return await this.invoke(
        sessionId,
        grant,
        request,
        async value => await this.input.artifact!(value, controller.signal),
      )
    } finally {
      if (session.artifacts.get(request.requestId) === controller) session.artifacts.delete(request.requestId)
    }
  }

  private async invoke(
    sessionId: string,
    grant: string,
    payload: unknown,
    handler: ((value: unknown, context: OwnerAdapterManagementContext) => Promise<unknown>) | undefined,
    allowUnadmittedRead = false,
    fenceResult = false,
  ): Promise<{ readonly available: true; readonly value: unknown } | { readonly available: false }> {
    const session = await this.lookup(sessionId, grant)
    if (
      !session || !session.admitted && !allowUnadmittedRead || !handler || this.reservation !== undefined
      || this.calls.size >= 32
    ) {
      return { available: false }
    }
    const context: OwnerAdapterManagementContext = {
      secret: session.documentSecret,
      rendererId: session.peer.identity.rendererId,
      signal: session.controller.signal,
      live: () =>
        this.current() && this.sessions.get(sessionId) === session && session.admitted
        && !session.peer.closed && !session.controller.signal.aborted,
      current: write => {
        try {
          return this.current() && this.sessions.get(sessionId) === session && !session.peer.closed
            && this.reservation === undefined && (session.admitted || !write && allowUnadmittedRead
                && attachmentEqual(this.input.snapshot(), session.snapshot))
        } catch {
          return false
        }
      },
    }
    if (!context.current(!allowUnadmittedRead)) return { available: false }
    const call = Symbol('adapter-owner-call')
    this.calls.add(call)
    this.callOwners.set(call, session)
    try {
      const value = await this.callContext.run(call, async () => await handler(payload, context))
      if (
        !await this.lookup(sessionId, grant) || (fenceResult
          ? !context.current(!allowUnadmittedRead)
          : !session.admitted)
      ) {
        throw new Error('adapter-owner-result-unknown')
      }
      return { available: true, value }
    } finally {
      this.calls.delete(call)
      this.callOwners.delete(call)
      for (const wake of this.callsChanged) wake()
    }
  }

  /** Owner-only identity lookup; a created but unsynchronized session is not live. */
  isLive(identity: RendererAttachmentIdentity): boolean {
    return this.current()
      && [...this.sessions.values()].some(session =>
        session.admitted && !session.peer.closed && attachmentEqual(session.peer.identity, identity)
      )
  }

  /** Sign only for a currently reserved and admitted native participant. */
  signPolicy(peer: ManagerRendererCommandPeer, transition: OwnerPolicyTransition) {
    const session = [...this.sessions.values()].find(item => item.peer === peer)
    if (!this.current() || this.reservation === undefined || !session?.admitted || peer.closed) {
      throw new Error('adapter-policy-handoff-unavailable')
    }
    const checked = parseOwnerPolicyTransition(transition, {
      profileId: this.input.scope.profileId,
      generation: this.input.scope.generation,
      rendererId: peer.identity.rendererId,
    })
    return session.policySigner.sign(checked)
  }

  /** Freeze the exact adapter cohort while the owner changes shared state. */
  reserve() {
    return this.beginReservation(this.callContext.getStore(), false).lease
  }

  /** Stop new calls and wait for other already-dispatched calls before a mutation. */
  async reserveForLifecycle(timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('adapter-reservation-unavailable')
    }
    const origin = this.callContext.getStore()
    const originSession = origin === undefined ? undefined : this.callOwners.get(origin)
    if (origin !== undefined && originSession === undefined) throw new Error('adapter-reservation-unavailable')
    const reservation = this.beginReservation(origin, true)
    const deadline = performance.now() + timeoutMs
    try {
      while (!reservation.ready()) {
        if (!reservation.alive() || performance.now() >= deadline) throw new Error('adapter-reservation-unavailable')
        await new Promise<void>(resolve => {
          const wake = () => {
            clearTimeout(timer)
            this.callsChanged.delete(wake)
            resolve()
          }
          const timer = setTimeout(wake, Math.max(1, deadline - performance.now()))
          this.callsChanged.add(wake)
          if (reservation.ready() || !reservation.alive()) wake()
        })
      }
      return originSession === undefined
        ? reservation.lease
        : { ...reservation.lease, originRendererId: originSession.peer.identity.rendererId }
    } catch {
      reservation.cancelBeforeDispatch()
      throw new Error('adapter-reservation-unavailable')
    }
  }

  private beginReservation(origin: symbol | undefined, allowPending: boolean) {
    if (
      !this.current() || this.reservation !== undefined
      || !allowPending && [...this.calls].some(call => call !== origin)
    ) throw new Error('adapter-reservation-unavailable')
    const inner = this.admission.reserve()
    const unsubscribe = inner.onInvalidated(() => {
      for (const wake of this.callsChanged) wake()
    })
    const reservation = Symbol('adapter-owner-reservation')
    this.reservation = reservation
    let ended = false
    const alive = () => !ended && this.current() && this.reservation === reservation && inner.isCurrent()
    const current = () => alive() && [...this.calls].every(call => call === origin)
    const fence = () => {
      if (ended) return
      ended = true
      this.fenced = true
      this.reservation = undefined
      unsubscribe()
      inner.fence()
    }
    const lease = {
      peers: inner.peers,
      isCurrent: current,
      release: () => {
        if (!current() || !inner.release()) {
          fence()
          return false
        }
        ended = true
        this.reservation = undefined
        unsubscribe()
        return true
      },
      fence,
    }
    return {
      lease,
      ready: current,
      alive,
      cancelBeforeDispatch: () => {
        if (ended) return
        try {
          if (alive() && inner.release()) {
            ended = true
            this.reservation = undefined
            unsubscribe()
          } else fence()
        } catch {
          fence()
        }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const wake of this.callsChanged) wake()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const session of [...this.sessions.values()]) this.retire(session)
    this.admission.close()
  }
}
