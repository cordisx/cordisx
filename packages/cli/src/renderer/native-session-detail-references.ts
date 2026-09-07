import type { AgentDetailReference } from '@cordisx/protocol/agents/v1'
import type {
  AgentDetailNavigationResult,
  AgentSessionDetailReferenceResult,
} from '@cordisx/protocol/agent-detail-navigation/v2'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'

export interface HistoricalAgentDetailProvider {
  get(owner: PluginOwnerIdentity, sessionId: string, active: () => boolean): Promise<AgentSessionDetailReferenceResult>
  open(
    owner: PluginOwnerIdentity,
    target: AgentDetailReference,
    active: () => boolean,
    authorize: (sessionId: string) => Promise<boolean>,
    navigate: (detail: AgentDetailReference, sessionId: string) => Promise<void> | void,
  ): Promise<AgentDetailNavigationResult>
}

export interface NativeSessionDetailClient {
  readonly active: () => boolean
  /** Authenticated Host-only read; never load/resume/recover a native Session. */
  readonly read: (sessionId: string) => Promise<Readonly<{ threadId: string; revision: number }> | undefined>
}

interface IssuedDetail {
  readonly owner: string
  readonly client: NativeSessionDetailClient
  readonly sessionId: string
  readonly threadId: string
  readonly revision: number
  readonly active: () => boolean
}
const ownerKey = (owner: PluginOwnerIdentity): string => JSON.stringify([owner.pluginId, owner.generation])
const validMapping = (value: { threadId: string; revision: number } | undefined): boolean =>
  value !== undefined && typeof value.threadId === 'string' && value.threadId.length > 0
  && Number.isSafeInteger(value.revision) && value.revision > 0

/** Ephemeral capabilities over the existing native mapping authority, not another Session store. */
export class NativeSessionDetailReferences implements HistoricalAgentDetailProvider {
  private readonly owners = new Map<string, NativeSessionDetailClient>()
  private readonly issued = new Map<string, IssuedDetail>()
  private disposed = false

  register(owner: PluginOwnerIdentity, client: NativeSessionDetailClient): () => void {
    if (this.disposed) return () => {}
    const key = ownerKey(owner)
    this.release(key)
    this.owners.set(key, client)
    return () => {
      if (this.owners.get(key) === client) this.release(key)
    }
  }

  private release(key: string): void {
    this.owners.delete(key)
    for (const [ref, issued] of this.issued) if (issued.owner === key) this.issued.delete(ref)
  }

  async get(
    owner: PluginOwnerIdentity,
    sessionId: string,
    active: () => boolean,
  ): Promise<AgentSessionDetailReferenceResult> {
    const key = ownerKey(owner)
    const client = this.owners.get(key)
    const current = () => !this.disposed && active() && client?.active() === true && this.owners.get(key) === client
    if (!current()) return { status: 'unavailable', code: 'generation-replaced' }
    try {
      const mapping = await client!.read(sessionId)
      if (!current()) return { status: 'unavailable', code: 'generation-replaced' }
      if (!validMapping(mapping)) return { status: 'unavailable', code: 'detail-unavailable' }
      const confirmed = await client!.read(sessionId)
      if (
        !current() || !validMapping(confirmed) || confirmed!.threadId !== mapping!.threadId
        || confirmed!.revision !== mapping!.revision
      ) {
        return { status: 'unavailable', code: 'detail-unavailable' }
      }
      // Reissue after any mapping change; never revive a previous capability.
      for (const [ref, issued] of this.issued) {
        if (issued.owner !== key || issued.sessionId !== sessionId) continue
        if (
          issued.client === client && issued.active() && issued.threadId === mapping!.threadId
          && issued.revision === mapping!.revision
        ) {
          return { status: 'accepted', sessionId, target: Object.freeze({ kind: 'host', ref }) }
        }
        this.issued.delete(ref)
      }
      const ref = `native-session-detail-v2:${crypto.randomUUID()}`
      this.issued.set(ref, {
        owner: key,
        client: client!,
        sessionId,
        threadId: mapping!.threadId,
        revision: mapping!.revision,
        active,
      })
      return { status: 'accepted', sessionId, target: Object.freeze({ kind: 'host', ref }) }
    } catch {
      return { status: 'unavailable', code: 'detail-unavailable' }
    }
  }

  async open(
    owner: PluginOwnerIdentity,
    target: AgentDetailReference,
    active: () => boolean,
    authorize: (sessionId: string) => Promise<boolean>,
    navigate: (detail: AgentDetailReference, sessionId: string) => Promise<void> | void,
  ): Promise<AgentDetailNavigationResult> {
    const key = ownerKey(owner)
    const issued = this.issued.get(target.ref)
    if (target.kind !== 'host' || issued?.owner !== key) return { status: 'unavailable', code: 'unknown-detail' }
    const current = () =>
      !this.disposed && active() && issued.active() && issued.client.active()
      && this.owners.get(key) === issued.client && this.issued.get(target.ref) === issued
    if (!current()) return { status: 'unavailable', code: 'stale-reference' }
    try {
      if (!await authorize(issued.sessionId)) return { status: 'denied', code: 'permission-denied' }
      if (!current()) return { status: 'unavailable', code: 'stale-reference' }
      const mapping = await issued.client.read(issued.sessionId)
      if (
        !current() || !validMapping(mapping) || mapping!.threadId !== issued.threadId
        || mapping!.revision !== issued.revision
      ) {
        this.issued.delete(target.ref)
        return { status: 'unavailable', code: 'stale-reference' }
      }
      await navigate(Object.freeze({ kind: 'host', ref: `codex-thread:${mapping!.threadId}` }), issued.sessionId)
      return current() ? { status: 'accepted', code: 'opened' } : { status: 'unavailable', code: 'stale-reference' }
    } catch {
      return { status: 'unavailable', code: 'stale-reference' }
    }
  }

  dispose(): void {
    this.disposed = true
    this.owners.clear()
    this.issued.clear()
  }
}
