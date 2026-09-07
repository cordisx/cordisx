import type { AgentDetailReference, AgentSetup } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { CordisXPersistedSession, CordisXSessionEventPersistence } from './agent-session-runtime.js'
import type { BrowserOwnerDocumentBridge, OwnerDocumentPrincipalBinding } from './owner-documents.js'
import { beginAgentToolRecovery } from './plugin-agent-tools.js'

export interface NativeSessionRecoveryStore {
  saveBinding(
    owner: PluginOwnerIdentity,
    input: { sessionId: string; threadId: string; setup?: AgentSetup; completedTurns: number },
  ): Promise<void>
  resolveBinding(
    owner: PluginOwnerIdentity,
    input: { sessionId: string; setup?: AgentSetup },
  ): Promise<{ threadId: string; completedTurns: number; setupDigest: string } | undefined>
}
interface OwnerClient {
  readonly principal: OwnerDocumentPrincipalBinding
  readonly active: () => boolean
}
const ownerKey = (owner: PluginOwnerIdentity): string => JSON.stringify([owner.pluginId, owner.generation])
let current: NativeAgentSessionPersistence | undefined

/** Reuses the runtime's authenticated owner-document transport, never plugin-supplied ownership. */
export class NativeAgentSessionPersistence implements CordisXSessionEventPersistence, NativeSessionRecoveryStore {
  private owners = new Map<string, OwnerClient>()
  private sessions = new Map<string, OwnerDocumentPrincipalBinding>()
  private details = new Map<string, { owner: string; client: OwnerClient; sessionId: string; threadId: string }>()
  private closed = false
  constructor(
    private readonly bridge: Pick<BrowserOwnerDocumentBridge, 'request'>,
    private readonly principals: readonly OwnerDocumentPrincipalBinding[],
    private readonly hostToken: string,
  ) {
    current = this
  }
  register(owner: PluginOwnerIdentity, client: OwnerClient): () => void {
    const key = ownerKey(owner)
    this.owners.set(key, client)
    return () => {
      if (this.owners.get(key) === client) this.owners.delete(key)
      for (const [ref, detail] of this.details) if (detail.client === client) this.details.delete(ref)
    }
  }
  private owner(owner: PluginOwnerIdentity): OwnerClient {
    const client = this.owners.get(ownerKey(owner))
    if (this.closed || client === undefined || !client.active()) throw new Error('native Session owner unavailable')
    return client
  }
  private call(principal: OwnerDocumentPrincipalBinding, operation: string, input: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('native Session persistence disposed'))
    return this.bridge.request(principal.token, { ...input, operation, nativeToken: this.hostToken })
  }
  async load(): Promise<readonly CordisXPersistedSession[]> {
    const sessions: CordisXPersistedSession[] = []
    for (const principal of this.principals) {
      const records = await this.call(principal, 'native-session-list', {}) as readonly {
        sessionId: string
        session?: CordisXPersistedSession
      }[]
      for (const record of records) {
        if (this.sessions.has(record.sessionId)) throw new Error('native Session has ambiguous owner')
        this.sessions.set(record.sessionId, principal)
        if (record.session !== undefined) sessions.push(record.session)
      }
    }
    return sessions
  }
  async saveBinding(
    owner: PluginOwnerIdentity,
    input: { sessionId: string; threadId: string; setup?: AgentSetup; completedTurns: number },
  ): Promise<void> {
    const client = this.owner(owner)
    await this.call(client.principal, 'native-session-save-binding', input)
    this.sessions.set(input.sessionId, client.principal)
  }
  async resolveBinding(
    owner: PluginOwnerIdentity,
    input: { sessionId: string; setup?: AgentSetup },
  ): Promise<{ threadId: string; completedTurns: number; setupDigest: string } | undefined> {
    const client = this.owner(owner)
    const result = await this.call(client.principal, 'native-session-load', input) as {
      threadId: string
      completedTurns: number
      setupDigest: string
    } | null
    if (result === null) return undefined
    await beginAgentToolRecovery(input.sessionId)
    this.sessions.set(input.sessionId, client.principal)
    return result
  }
  /** View-only capability issuance; does not begin recovery or change a Session ledger. */
  async getDetail(owner: PluginOwnerIdentity, sessionId: string): Promise<AgentDetailReference | undefined> {
    const client = this.owner(owner)
    const binding = await this.call(client.principal, 'native-session-detail', { sessionId }) as
      | { threadId: string }
      | null
    if (this.owner(owner) !== client || binding === null) return undefined
    for (const [ref, detail] of this.details) {
      if (detail.client === client && detail.sessionId === sessionId && detail.threadId === binding.threadId) {
        return Object.freeze({ kind: 'host', ref })
      }
    }
    const ref = `native-session-detail:${crypto.randomUUID()}`
    this.details.set(ref, { owner: ownerKey(owner), client, sessionId, threadId: binding.threadId })
    return Object.freeze({ kind: 'host', ref })
  }
  async resolveDetail(owner: PluginOwnerIdentity, target: AgentDetailReference): Promise<
    {
      sessionId: string
      detail: AgentDetailReference
    } | undefined
  > {
    const client = this.owner(owner)
    const issued = this.details.get(target.ref)
    if (target.kind !== 'host' || issued?.client !== client || issued.owner !== ownerKey(owner)) return undefined
    const binding = await this.call(client.principal, 'native-session-detail', {
      sessionId: issued.sessionId,
    }) as { threadId: string } | null
    if (this.owner(owner) !== client || binding?.threadId !== issued.threadId) return undefined
    return { sessionId: issued.sessionId, detail: { kind: 'host', ref: `codex-thread:${binding.threadId}` } }
  }
  private principal(sessionId: string): OwnerDocumentPrincipalBinding {
    const principal = this.sessions.get(sessionId)
    if (principal === undefined) throw new Error('native Session mapping must be committed before its ledger')
    return principal
  }
  async create(session: CordisXPersistedSession): Promise<void> {
    await this.call(this.principal(session.id), 'native-session-create', { sessionId: session.id, session })
  }
  async append(input: Parameters<CordisXSessionEventPersistence['append']>[0]): Promise<void> {
    await this.call(this.principal(input.sessionId), 'native-session-append', input)
  }
  async updateSetup(input: Parameters<NonNullable<CordisXSessionEventPersistence['updateSetup']>>[0]): Promise<void> {
    await this.call(this.principal(input.sessionId), 'native-session-update-setup', input)
  }
  dispose(): void {
    this.closed = true
    this.details.clear()
    this.owners.clear()
    this.sessions.clear()
    if (current === this) current = undefined
  }
}

export function registerNativeSessionOwner(
  owner: PluginOwnerIdentity,
  principal: OwnerDocumentPrincipalBinding | undefined,
  active: () => boolean,
): () => void {
  if (current === undefined || principal === undefined) return () => {}
  return current.register(owner, { principal, active })
}
export async function saveNativeSessionBinding(
  owner: PluginOwnerIdentity,
  input: Parameters<NativeSessionRecoveryStore['saveBinding']>[1],
): Promise<void> {
  if (current === undefined) throw new Error('native Session persistence unavailable')
  await current.saveBinding(owner, input)
}
export async function resolveNativeSessionBinding(
  owner: PluginOwnerIdentity,
  input: Parameters<NativeSessionRecoveryStore['resolveBinding']>[1],
): ReturnType<NativeSessionRecoveryStore['resolveBinding']> {
  return await current?.resolveBinding(owner, input)
}
export const nativeSessionRecoveryStore: NativeSessionRecoveryStore = {
  saveBinding: saveNativeSessionBinding,
  resolveBinding: resolveNativeSessionBinding,
}

export async function getNativeSessionDetail(owner: PluginOwnerIdentity, sessionId: string) {
  return await current?.getDetail(owner, sessionId)
}
export async function resolveNativeSessionDetail(owner: PluginOwnerIdentity, target: AgentDetailReference) {
  return await current?.resolveDetail(owner, target)
}
