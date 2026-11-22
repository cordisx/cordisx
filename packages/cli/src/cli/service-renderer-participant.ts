import { randomBytes } from 'node:crypto'
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
import { ServiceRendererLifecycleProjection } from './service-renderer-lifecycle-projection.js'

type Snapshot = Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
type Entry = {
  readonly peer: ManagerRendererCommandPeer
  bootstrap?: Snapshot
  readOnlyIdentity?: boolean
  identityProjection?: ServiceRendererLifecycleProjection
}

/**
 * Owner-private participant registry. Session IDs, renderer IDs and process
 * identity come exclusively from the authenticated manager session authority.
 */
export class ServiceRendererParticipants {
  private readonly entries = new Map<string, Entry>()
  private lifecycle: Pick<OwnerRendererLifecycle, 'snapshot' | 'attach'> | undefined
  private closed = false
  private fenced = false
  private quiescence: symbol | undefined

  constructor(private readonly scope: RendererAttachmentScope) {}

  bind(lifecycle: Pick<OwnerRendererLifecycle, 'snapshot' | 'attach'>): void {
    if (this.closed || this.lifecycle !== undefined) throw new Error('renderer-participants-unavailable')
    this.lifecycle = lifecycle
  }

  /** Owner-only checks used to bind the fence to this exact lifecycle fleet. */
  isBoundTo(lifecycle: Pick<OwnerRendererLifecycle, 'snapshot' | 'attach'>): boolean {
    return !this.closed && this.lifecycle === lifecycle
  }

  ownerPeers(): readonly ManagerRendererCommandPeer[] {
    if (this.closed || this.fenced || this.quiescence !== undefined || !this.lifecycle) {
      throw new Error('renderer-quiescence-unavailable')
    }
    return [...this.entries.values()].map(entry => entry.peer)
  }

  readonly participant = {
    create: (input: {
      readonly gateway: ManagerRendererGatewayProof
      readonly browserSessionId: string
      readonly handle: ManagerRendererHandle
    }): ManagerRendererCommandPeer => {
      const { gateway, browserSessionId, handle } = input
      if (
        this.closed || this.fenced || this.quiescence !== undefined || !this.lifecycle
        || handle.ownerGeneration !== this.scope.generation
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
        this.closed || this.fenced || this.quiescence !== undefined || !this.lifecycle
        || !entry || entry.peer !== peer || !entry.bootstrap || peer.closed
        || !attachmentEqual(this.lifecycle.snapshot(), entry.bootstrap)
      ) {
        peer.close()
        throw new Error('renderer-bootstrap-unavailable')
      }
      await this.lifecycle.attach(peer)
      if (this.closed || this.fenced || this.quiescence !== undefined || peer.closed) {
        peer.close()
        throw new Error('renderer-bootstrap-unavailable')
      }
    },
  }

  /** Used only by an owner bootstrap after the exact composition is built. */
  confirmBootstrap(
    rendererId: string,
    snapshot: Snapshot,
    projected?: Snapshot,
    resolve?: (alias: string, pluginId: string) => { readonly source: string; readonly digest: string },
  ): void {
    const entry = this.entries.get(rendererId)
    if (
      this.closed || this.fenced || this.quiescence !== undefined || !entry || entry.peer.closed || !this.lifecycle
      || !attachmentEqual(this.lifecycle.snapshot(), snapshot)
    ) throw new Error('renderer-bootstrap-stale')
    const ownerSnapshot = structuredClone(snapshot)
    if (projected !== undefined) {
      if (!resolve) throw new Error('renderer-bootstrap-stale')
      const projection = new ServiceRendererLifecycleProjection({
        owner: ownerSnapshot,
        renderer: projected,
        rendererId,
        current: () => !this.closed && !this.fenced && this.entries.get(rendererId) === entry && !entry.peer.closed,
        resolve,
      })
      entry.peer.bindOwnerProjection(projection.project)
      entry.identityProjection = projection
      entry.readOnlyIdentity = true
    }
    entry.bootstrap = ownerSnapshot
  }

  isLive(identity: RendererAttachmentIdentity): boolean {
    const entry = this.entries.get(identity.rendererId)
    return !this.closed && entry !== undefined && !entry.peer.closed && entry.bootstrap !== undefined
      && attachmentEqual(entry.peer.identity, identity)
  }

  /** Reject mutations at preflight while any participant has only a snapshot projection. */
  canMutate(identity: RendererAttachmentIdentity): boolean {
    const entry = this.entries.get(identity.rendererId)
    return this.isLive(identity) && entry?.readOnlyIdentity !== true
  }

  /** Owner-only lookup after ManagerRendererSessions authenticated the caller. */
  peer(rendererId: string): ManagerRendererCommandPeer | undefined {
    const entry = this.entries.get(rendererId)
    return !this.closed && entry !== undefined && !entry.peer.closed ? entry.peer : undefined
  }

  /**
   * Stop Manager peers and block new admissions until the owner releases the
   * lease. This is only one part of a profile barrier: the caller must also
   * fence other consumers and writers and drain their in-flight operations.
   */
  async quiesceManagers(): Promise<{ isCurrent(): boolean; release(): boolean; fence(): void }> {
    if (this.closed || this.fenced || this.quiescence !== undefined || !this.lifecycle) {
      throw new Error('renderer-quiescence-unavailable')
    }
    const reservation = Symbol('manager-quiescence')
    this.quiescence = reservation
    const peers = [...this.entries.values()].map(entry => entry.peer)
    try {
      await Promise.all(peers.map(async peer => await this.quiescePeer(peer)))
      if (this.closed || this.quiescence !== reservation || this.entries.size !== 0) {
        throw new Error('renderer-quiescence-unavailable')
      }
      let ended = false
      const current = () =>
        !ended && !this.closed && !this.fenced && this.quiescence === reservation && this.entries.size === 0
      return {
        isCurrent: current,
        release: () => {
          if (ended) return false
          if (!current()) {
            ended = true
            this.fenced = true
            this.disconnectAll()
            return false
          }
          ended = true
          this.quiescence = undefined
          return true
        },
        fence: () => {
          if (ended) return
          ended = true
          this.fenced = true
          this.disconnectAll()
        },
      }
    } catch {
      this.fenced = true
      this.disconnectAll()
      throw new Error('renderer-quiescence-unavailable')
    }
  }

  private async quiescePeer(peer: ManagerRendererCommandPeer): Promise<void> {
    const fenceId = randomBytes(32).toString('hex')
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const disconnected = new Promise<void>(resolve => {
      unsubscribe = peer.onDisconnect(resolve)
    })
    try {
      const receipt = await peer.request('quiesce', { fenceId })
      if (
        !attachmentEqual(receipt, {
          fenceId,
          rendererId: peer.identity.rendererId,
          ownerGeneration: this.scope.generation,
          quiesced: true,
        })
      ) throw new Error('renderer-quiescence-unavailable')
      const timeout = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 5_000)
        timer.unref()
      })
      if (!await Promise.race([disconnected.then(() => true), timeout])) {
        throw new Error('renderer-quiescence-unavailable')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }

  /** Revoke current peers without preventing a later, freshly admitted session. */
  disconnectAll(): void {
    for (const entry of this.entries.values()) entry.peer.close()
    this.entries.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.disconnectAll()
  }
}
