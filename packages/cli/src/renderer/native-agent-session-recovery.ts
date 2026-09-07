import type { AgentTaskContext, AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import type { AgentTaskRecord } from '../agent-task-record.js'
import type { TaskContextResolution } from '../launcher/agent-task-context.js'
import {
  type HistoricalAgentDetailProvider,
  NativeSessionDetailReferences,
} from './native-session-detail-references.js'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { CordisXPersistedSession, CordisXSessionEventPersistence } from './agent-session-runtime.js'
import type { BrowserOwnerDocumentBridge, OwnerDocumentPrincipalBinding } from './owner-documents.js'
import { beginAgentToolRecovery } from './plugin-agent-tools.js'

export interface NativeSessionRecoveryStore {
  saveBinding(
    owner: PluginOwnerIdentity,
    input: {
      sessionId: string
      threadId: string
      setup?: AgentSetup
      completedTurns: number
      context?: AgentTaskResolvedContext
    },
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
  readonly details = new NativeSessionDetailReferences()
  private closed = false
  constructor(
    private readonly bridge: BrowserOwnerDocumentBridge,
    private readonly principals: readonly OwnerDocumentPrincipalBinding[],
    private readonly hostToken: string,
  ) {
    current = this
  }
  register(owner: PluginOwnerIdentity, client: OwnerClient): () => void {
    const key = ownerKey(owner)
    this.owners.set(key, client)
    const releaseDetails = this.details.register(owner, {
      active: () => !this.closed && this.owners.get(key) === client && client.active(),
      read: async sessionId => {
        const value = await this.call(client.principal, 'native-session-detail', { sessionId }) as {
          threadId: string
          revision: number
        } | null
        return value ?? undefined
      },
    })
    return () => {
      releaseDetails()
      if (this.owners.get(key) === client) this.owners.delete(key)
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
    input: {
      sessionId: string
      threadId: string
      setup?: AgentSetup
      completedTurns: number
      context?: AgentTaskResolvedContext
    },
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
  async taskCall(owner: PluginOwnerIdentity, operation: string, input: object): Promise<unknown> {
    return await this.call(this.owner(owner).principal, `native-session-task-${operation}`, input)
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
    this.details.dispose()
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

export function nativeAgentTaskClient(owner: PluginOwnerIdentity) {
  const call = async (operation: string, input: object): Promise<unknown> => {
    if (current === undefined) throw new Error('Native task persistence unavailable')
    return await current.taskCall(owner, operation, input)
  }
  return {
    store: {
      recover: async (operationId: string): Promise<{ claimed: boolean; record: AgentTaskRecord }> =>
        await call('recover', { operationId }) as { claimed: boolean; record: AgentTaskRecord },
      load: async (operationId: string): Promise<AgentTaskRecord | undefined> =>
        (await call('load', { operationId }) as AgentTaskRecord | null) ?? undefined,
      claim: async (record: AgentTaskRecord): Promise<{ claimed: boolean; record: AgentTaskRecord }> =>
        await call('claim', { operationId: record.operationId, record }) as {
          claimed: boolean
          record: AgentTaskRecord
        },
      save: async (record: AgentTaskRecord): Promise<void> => {
        await call('save', { operationId: record.operationId, record })
      },
    },
    resolveContext: async (context: AgentTaskContext): Promise<TaskContextResolution> =>
      await call('context', { context }) as TaskContextResolution,
  }
}

/** View-only detail capability path; never calls resolveBinding or starts recovery. */
export const historicalNativeSessionDetails: HistoricalAgentDetailProvider = {
  get: async (owner, sessionId, active) =>
    current === undefined
      ? { status: 'unavailable', code: 'unsupported' }
      : await current.details.get(owner, sessionId, active),
  open: async (owner, target, active, authorize, navigate) =>
    current === undefined
      ? { status: 'unavailable', code: 'unsupported' }
      : await current.details.open(owner, target, active, authorize, navigate),
}
