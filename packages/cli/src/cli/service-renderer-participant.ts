import { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { ManagerRendererHandle } from './manager-renderer-sessions.js'
import {
  attachmentEqual,
  type RendererAttachmentIdentity,
  type RendererAttachmentScope,
} from '../launcher/renderer-lifecycle-peer.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'

type Snapshot = Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
type Entry = { readonly peer: ManagerRendererCommandPeer; bootstrap?: Snapshot }

/**
 * Owner-private participant registry. Session IDs, renderer IDs and process
 * identity come exclusively from the authenticated manager session authority.
 */
export class ServiceRendererParticipants {
  private readonly entries = new Map<string, Entry>()
  private lifecycle: Pick<OwnerRendererLifecycle, 'snapshot' | 'attach'> | undefined
  private closed = false

  constructor(private readonly scope: RendererAttachmentScope) {}

  bind(lifecycle: Pick<OwnerRendererLifecycle, 'snapshot' | 'attach'>): void {
    if (this.closed || this.lifecycle !== undefined) throw new Error('renderer-participants-unavailable')
    this.lifecycle = lifecycle
  }

  readonly participant = {
    create: (input: {
      readonly gateway: ManagerRendererGatewayProof
      readonly browserSessionId: string
      readonly handle: ManagerRendererHandle
    }): ManagerRendererCommandPeer => {
      const { gateway, browserSessionId, handle } = input
      if (
        this.closed || !this.lifecycle || handle.ownerGeneration !== this.scope.generation
        || this.entries.has(handle.rendererId)
      ) throw new Error('renderer-participants-unavailable')
      const peer = new ManagerRendererCommandPeer({
        scope: this.scope,
        identity: {
          appId: 'manager',
          adapterId: 'independent-manager',
          rendererId: handle.rendererId,
          pid: gateway.pid,
          processStartedAt: gateway.processStartedAt,
        },
        sessionId: browserSessionId,
      })
      this.entries.set(handle.rendererId, { peer })
      peer.onDisconnect(() => {
        if (this.entries.get(handle.rendererId)?.peer === peer) this.entries.delete(handle.rendererId)
      })
      return peer
    },
    attach: async (peer: ManagerRendererCommandPeer): Promise<void> => {
      const entry = this.entries.get(peer.identity.rendererId)
      if (
        this.closed || !this.lifecycle || !entry || entry.peer !== peer || !entry.bootstrap || peer.closed
        || !attachmentEqual(this.lifecycle.snapshot(), entry.bootstrap)
      ) {
        peer.close()
        throw new Error('renderer-bootstrap-unavailable')
      }
      await this.lifecycle.attach(peer)
    },
  }

  /** Used only by an owner bootstrap after the exact composition is built. */
  confirmBootstrap(rendererId: string, snapshot: Snapshot): void {
    const entry = this.entries.get(rendererId)
    if (
      this.closed || !entry || entry.peer.closed || !this.lifecycle
      || !attachmentEqual(this.lifecycle.snapshot(), snapshot)
    ) throw new Error('renderer-bootstrap-stale')
    entry.bootstrap = structuredClone(snapshot)
  }

  isLive(identity: RendererAttachmentIdentity): boolean {
    const entry = this.entries.get(identity.rendererId)
    return !this.closed && entry !== undefined && !entry.peer.closed && entry.bootstrap !== undefined
      && attachmentEqual(entry.peer.identity, identity)
  }

  /** Owner-only lookup after ManagerRendererSessions authenticated the caller. */
  peer(rendererId: string): ManagerRendererCommandPeer | undefined {
    const entry = this.entries.get(rendererId)
    return !this.closed && entry !== undefined && !entry.peer.closed ? entry.peer : undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) entry.peer.close()
    this.entries.clear()
  }
}
