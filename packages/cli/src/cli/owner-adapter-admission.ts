import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AttachedRendererPeer, RendererAttachmentScope } from '../launcher/renderer-lifecycle-peer.js'
import { parseAttachmentScope } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { ManagerRendererHandle } from './manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from './manager-renderer-peer.js'

type Adapter = Readonly<{ appId: string; adapterId: string }>
type Grant = Readonly<{ adapter: Adapter; gateway: ManagerRendererGatewayProof; expires: number }>
type Reservation = {
  readonly peers: readonly ManagerRendererCommandPeer[]
  readonly listeners: Set<() => void>
  invalid: boolean
  ended: boolean
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const secret = /^[a-f0-9]{64}$/u

function validGateway(value: ManagerRendererGatewayProof): boolean {
  return value !== null && typeof value === 'object' && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.processStartedAt === 'string' && value.processStartedAt.length > 0
    && value.processStartedAt.length <= 256 && typeof value.instanceToken === 'string'
    && secret.test(value.instanceToken)
}

function sameGateway(left: ManagerRendererGatewayProof, right: ManagerRendererGatewayProof): boolean {
  return validGateway(left) && validGateway(right) && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt
    && timingSafeEqual(Buffer.from(left.instanceToken, 'hex'), Buffer.from(right.instanceToken, 'hex'))
}

/**
 * Owner-only opt-in admission primitive for independently transported adapters.
 * The owner supplies trusted identities and gateway bindings; the peer cannot
 * request or modify either through this interface. Nothing exposes `issue` on
 * a public channel. The existing private session authority authenticates the
 * gateway before `create`, and generates the renderer ID and session grant.
 */
export class OwnerAdapterAdmission {
  private readonly scope: RendererAttachmentScope
  private readonly grants = new Map<string, Grant>()
  private readonly peers = new Set<ManagerRendererCommandPeer>()
  private readonly attached = new Set<ManagerRendererCommandPeer>()
  private readonly attaching = new Set<ManagerRendererCommandPeer>()
  private reservation: Reservation | undefined
  private fenced = false
  private closed = false

  constructor(
    private readonly input: {
      readonly scope: RendererAttachmentScope
      readonly attach: (peer: AttachedRendererPeer) => Promise<void>
      readonly now?: () => number
    },
  ) {
    this.scope = Object.freeze({ ...parseAttachmentScope(input.scope) })
  }

  /** Called only by authenticated owner code; returned capability is private and single-use. */
  issue(adapter: Adapter, gateway: ManagerRendererGatewayProof): string {
    if (
      this.closed || this.fenced || this.reservation || !adapter
      || typeof adapter.appId !== 'string' || typeof adapter.adapterId !== 'string'
      || !identifier.test(adapter.appId) || !identifier.test(adapter.adapterId)
      || !validGateway(gateway)
    ) throw new Error('adapter-admission-unavailable')
    const now = (this.input.now ?? (() => performance.now()))()
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token)
    if (this.grants.size + this.peers.size >= 16) throw new Error('adapter-admission-unavailable')
    const token = randomBytes(32).toString('hex')
    if (this.grants.has(token)) throw new Error('adapter-admission-unavailable')
    this.grants.set(token, {
      adapter: Object.freeze({ appId: adapter.appId, adapterId: adapter.adapterId }),
      gateway: Object.freeze({
        pid: gateway.pid,
        processStartedAt: gateway.processStartedAt,
        instanceToken: gateway.instanceToken,
      }),
      expires: now + 60_000,
    })
    return token
  }

  /** Withdraw an unused grant when its owner cancels adapter startup. */
  revokeGrant(token: string): boolean {
    return !this.closed && !this.fenced && secret.test(token) && this.grants.delete(token)
  }

  readonly participant = {
    create: (request: {
      readonly gateway: ManagerRendererGatewayProof
      readonly browserSessionId: string
      readonly handle: ManagerRendererHandle
    }): ManagerRendererCommandPeer => {
      const grant = this.grants.get(request.browserSessionId)
      if (
        this.closed || this.fenced || this.reservation || !grant
        || grant.expires <= (this.input.now ?? (() => performance.now()))()
        || !sameGateway(grant.gateway, request.gateway) || request.handle.ownerGeneration !== this.scope.generation
        || !secret.test(request.handle.rendererId) || !secret.test(request.handle.grant)
      ) throw new Error('adapter-admission-unavailable')
      this.grants.delete(request.browserSessionId)
      const peer = new ManagerRendererCommandPeer({
        scope: this.scope,
        identity: {
          ...grant.adapter,
          rendererId: request.handle.rendererId,
          pid: grant.gateway.pid,
          processStartedAt: grant.gateway.processStartedAt,
        },
        sessionId: request.browserSessionId,
      })
      this.peers.add(peer)
      peer.onDisconnect(() => {
        this.peers.delete(peer)
        this.attached.delete(peer)
        this.attaching.delete(peer)
        const reservation = this.reservation
        if (reservation?.peers.includes(peer)) this.invalidate(reservation)
      })
      return peer
    },
    attach: async (peer: ManagerRendererCommandPeer): Promise<void> => {
      if (
        this.closed || this.fenced || this.reservation || peer.closed || !this.peers.has(peer)
        || this.attaching.has(peer) || this.attached.has(peer)
      ) throw new Error('adapter-admission-unavailable')
      this.attaching.add(peer)
      try {
        await this.input.attach(peer)
        if (this.closed || this.fenced || this.reservation || peer.closed || !this.peers.has(peer)) {
          throw new Error('adapter-admission-unavailable')
        }
        this.attached.add(peer)
      } catch (error) {
        peer.close()
        throw error
      } finally {
        this.attaching.delete(peer)
      }
    },
  }

  private invalidate(reservation: Reservation): void {
    if (this.reservation !== reservation || reservation.invalid || reservation.ended) return
    reservation.invalid = true
    this.fenced = true
    this.grants.clear()
    for (const listener of reservation.listeners) {
      try {
        listener()
      } catch { /* continue fencing the remaining adapters */ }
    }
    reservation.listeners.clear()
    for (const peer of [...this.peers]) peer.close()
  }

  /**
   * Freeze admission around an exact attached-adapter cohort. This does not
   * itself drain adapter work or prove that policies were adopted.
   */
  reserve(): {
    readonly peers: readonly ManagerRendererCommandPeer[]
    isCurrent(): boolean
    onInvalidated(listener: () => void): () => void
    release(): boolean
    fence(): void
  } {
    if (this.closed || this.fenced || this.reservation) throw new Error('adapter-reservation-unavailable')
    const now = (this.input.now ?? (() => performance.now()))()
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token)
    const peers = Object.freeze([...this.peers])
    if (
      this.grants.size !== 0 || this.attaching.size !== 0
      || peers.some(peer => peer.closed || !this.attached.has(peer))
    ) throw new Error('adapter-reservation-unavailable')
    const reservation: Reservation = { peers, listeners: new Set(), invalid: false, ended: false }
    this.reservation = reservation
    const current = () =>
      !this.closed && !this.fenced && this.reservation === reservation && !reservation.invalid && !reservation.ended
      && this.grants.size === 0 && this.attaching.size === 0 && this.peers.size === peers.length
      && peers.every(peer => this.peers.has(peer) && this.attached.has(peer) && !peer.closed)
    const fence = () => this.invalidate(reservation)
    return Object.freeze({
      peers,
      isCurrent: current,
      onInvalidated: (listener: () => void) => {
        if (!current()) listener()
        else reservation.listeners.add(listener)
        return () => reservation.listeners.delete(listener)
      },
      release: () => {
        if (reservation.ended) return false
        if (!current()) {
          fence()
          reservation.ended = true
          return false
        }
        reservation.ended = true
        reservation.listeners.clear()
        this.reservation = undefined
        return true
      },
      fence,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.reservation) this.invalidate(this.reservation)
    this.grants.clear()
    for (const peer of [...this.peers]) peer.close()
    this.peers.clear()
    this.attached.clear()
    this.attaching.clear()
  }
}
