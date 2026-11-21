import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AttachedRendererPeer, RendererAttachmentScope } from '../launcher/renderer-lifecycle-peer.js'
import { parseAttachmentScope } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { ManagerRendererHandle } from './manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from './manager-renderer-peer.js'

type Adapter = Readonly<{ appId: string; adapterId: string }>
type Grant = Readonly<{ adapter: Adapter; gateway: ManagerRendererGatewayProof; expires: number }>
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
      this.closed || !adapter || typeof adapter.appId !== 'string' || typeof adapter.adapterId !== 'string'
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

  readonly participant = {
    create: (request: {
      readonly gateway: ManagerRendererGatewayProof
      readonly browserSessionId: string
      readonly handle: ManagerRendererHandle
    }): ManagerRendererCommandPeer => {
      const grant = this.grants.get(request.browserSessionId)
      if (
        this.closed || !grant || grant.expires <= (this.input.now ?? (() => performance.now()))()
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
      peer.onDisconnect(() => this.peers.delete(peer))
      return peer
    },
    attach: async (peer: ManagerRendererCommandPeer): Promise<void> => {
      if (this.closed || peer.closed || !this.peers.has(peer)) throw new Error('adapter-admission-unavailable')
      try {
        await this.input.attach(peer)
        if (this.closed || peer.closed || !this.peers.has(peer)) throw new Error('adapter-admission-unavailable')
      } catch (error) {
        peer.close()
        throw error
      }
    },
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.grants.clear()
    for (const peer of this.peers) peer.close()
    this.peers.clear()
  }
}
