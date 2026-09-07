import { handleAgentTaskStore } from './agent-task-store.js'
import type { AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { CordisXJsonValue } from '../contracts.js'
import type { CordisXPersistedSession } from '../renderer/agent-session-runtime.js'
import { nativeAgentInstructions } from '../renderer/codex-desktop-agent-setup.js'
import { validatePersistedAgentSession } from '../playground/agent-session-store.js'
import { type OwnerDocumentPrincipal, verifyOwnerDocumentPrincipalToken } from './owner-document-rpc.js'
import { type OwnerDocumentIdentity, OwnerDocumentStore, type OwnerDocumentStoreScope } from './owner-document-store.js'

const CONTRACT = 'cordisx.native-agent-session/v1'
const INDEX = 'native-session-index'
export function issueNativeSessionHostToken(input: { secret: string; profileId: string; generation: string }): string {
  return createHmac('sha256', input.secret).update(
    JSON.stringify(['cordisx.native-session-host/v1', input.profileId, input.generation]),
  ).digest('hex')
}
/** Native binding facts are Host-owned, not writable through a plugin's documents service. */
export function nativeSessionStoreScope(profileId: string, identity: OwnerDocumentIdentity): OwnerDocumentStoreScope {
  const owner = createHash('sha256').update(JSON.stringify([identity.source, identity.pluginId])).digest('hex')
  return { profileId, identity: { source: `file:///cordisx-native-session-owners/${owner}/host`, pluginId: 'host' } }
}
export interface NativeAgentSessionRecord {
  readonly contract: typeof CONTRACT
  readonly sessionId: string
  readonly threadId: string
  readonly setupDigest: string
  readonly setup?: AgentSetup
  readonly context?: AgentTaskResolvedContext
  readonly completedTurns: number
  readonly session?: CordisXPersistedSession
  /** Explicit one-time restoration evidence, never fabricated old SessionEvents. */
  readonly recoveryEvidence?: Readonly<Record<string, string | number>>
}
const key = (id: string): string => `native-session.${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
const digest = (setup?: AgentSetup): string =>
  createHash('sha256').update(nativeAgentInstructions(setup) ?? '').digest('hex')
const json = (value: unknown): CordisXJsonValue => JSON.parse(JSON.stringify(value)) as CordisXJsonValue
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid native Session request')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512) {
    throw new Error('invalid native Session identity')
  }
  return value
}
function turns(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid native turn checkpoint')
  return value as number
}
function parsed(value: unknown, sessionId: string): NativeAgentSessionRecord {
  const valueRecord = record(value)
  if (valueRecord.contract !== CONTRACT || valueRecord.sessionId !== sessionId) {
    throw new Error('native Session scope mismatch')
  }
  id(valueRecord.threadId)
  turns(valueRecord.completedTurns)
  if (valueRecord.setupDigest !== digest(valueRecord.setup as AgentSetup | undefined)) {
    throw new Error('native Session setup digest mismatch')
  }
  if (valueRecord.session !== undefined) {
    const session = validatePersistedAgentSession(valueRecord.session)
    if (session.id !== sessionId || digest(session.setup) !== valueRecord.setupDigest) {
      throw new Error('native Session ledger mismatch')
    }
  }
  return valueRecord as unknown as NativeAgentSessionRecord
}
export function isNativeAgentSessionRequest(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'operation' in value
    && String(value.operation).startsWith('native-session-')
}

/** One owner-scoped native Session record, backed by the existing locked CAS document store. */
export class NativeAgentSessionBridge {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly input: {
      readonly secret: string
      readonly profileId: string
      readonly generation: string
      readonly store: OwnerDocumentStore
      readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
    },
  ) {}

  handle(value: unknown): Promise<unknown> {
    const result = this.queue.then(() => this.execute(value))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async execute(value: unknown): Promise<unknown> {
    const request = record(value)
    const hostToken = request.nativeToken
    if (
      typeof hostToken !== 'string' || !/^[a-f0-9]{64}$/.test(hostToken)
      || !timingSafeEqual(Buffer.from(hostToken, 'hex'), Buffer.from(issueNativeSessionHostToken(this.input), 'hex'))
    ) {
      throw new Error('Host native Session authority unavailable')
    }
    if (request.version !== 1 || typeof request.requestId !== 'string') {
      throw new Error('native Session envelope invalid')
    }
    const principal = verifyOwnerDocumentPrincipalToken(
      this.input.secret,
      typeof request.token === 'string' ? request.token : '',
    )
    if (
      principal === undefined || principal.profileId !== this.input.profileId
      || principal.generation !== this.input.generation
      || !this.input.principalAllowed(principal)
    ) throw new Error('native Session principal is stale')
    const scope = nativeSessionStoreScope(principal.profileId, principal.identity)
    const load = async (documentId: string) => {
      const result = await this.input.store.load(scope, documentId)
      if (result.status === 'missing') return undefined
      if (result.status !== 'loaded') throw new Error('native Session store unavailable')
      return result.snapshot
    }
    const write = async (documentId: string, revision: number, value: unknown) => {
      if (!this.input.principalAllowed(principal)) throw new Error('native Session principal replaced')
      const result = await this.input.store.replace({
        scope,
        documentId,
        expectedRevision: revision,
        schemaVersion: 1,
        value: json(value),
        commitAllowed: () => this.input.principalAllowed(principal),
      })
      if (result.status !== 'accepted') throw new Error('native Session checkpoint conflict')
    }
    if (String(request.operation).startsWith('native-session-task-')) {
      return await handleAgentTaskStore(request, {
        load,
        write,
        context: async sessionId => {
          const saved = await load(key(id(sessionId)))
          return saved === undefined ? undefined : parsed(saved.value, sessionId).context
        },
      })
    }
    if (request.operation === 'native-session-list') {
      const index = await load(INDEX)
      const entries = index === undefined ? [] : record(index.value).sessionIds
      if (!Array.isArray(entries) || entries.length > 48) throw new Error('native Session index invalid')
      const records = []
      for (const sessionId of entries) {
        const snapshot = await load(key(id(sessionId)))
        if (snapshot !== undefined) records.push(parsed(snapshot.value, sessionId))
      }
      return records
    }
    const sessionId = id(request.sessionId)
    const documentId = key(sessionId)
    const snapshot = await load(documentId)
    const existing = snapshot === undefined ? undefined : parsed(snapshot.value, sessionId)
    if (request.operation === 'native-session-load') {
      if (existing === undefined) return null
      if (digest(request.setup as AgentSetup | undefined) !== existing.setupDigest) {
        throw new Error('native Session definition changed')
      }
      return { threadId: existing.threadId, completedTurns: existing.completedTurns, setupDigest: existing.setupDigest }
    }
    if (request.operation === 'native-session-save-binding') {
      if (
        existing?.context !== undefined && request.context !== undefined
        && JSON.stringify(existing.context) !== JSON.stringify(request.context)
      ) throw new Error('Native execution context is immutable')
      const threadId = id(request.threadId)
      const setup = request.setup as AgentSetup | undefined
      const setupDigest = digest(setup)
      const completedTurns = turns(request.completedTurns)
      if (
        existing !== undefined && (existing.threadId !== threadId || existing.setupDigest !== setupDigest
          || completedTurns < existing.completedTurns)
      ) throw new Error('native Session binding conflict')
      if (existing === undefined) {
        const index = await load(INDEX)
        const entries = index === undefined ? [] : record(index.value).sessionIds
        if (!Array.isArray(entries) || entries.length >= 48) throw new Error('native Session index full')
        if (!entries.includes(sessionId)) {
          await write(INDEX, index?.revision ?? 0, { sessionIds: [...entries, sessionId] })
        }
      }
      await write(documentId, snapshot?.revision ?? 0, {
        ...existing,
        contract: CONTRACT,
        sessionId,
        threadId,
        setupDigest,
        ...(setup === undefined ? {} : { setup }),
        completedTurns,
        ...(request.context === undefined ? {} : { context: request.context }),
      })
      return null
    }
    if (existing === undefined) throw new Error('native Session mapping unavailable')
    let session: CordisXPersistedSession
    if (request.operation === 'native-session-create') {
      session = validatePersistedAgentSession(request.session)
      if (existing.session !== undefined && JSON.stringify(existing.session) !== JSON.stringify(session)) {
        throw new Error('native Session already exists')
      }
    } else if (request.operation === 'native-session-append') {
      if (
        existing.session === undefined || request.sessionGeneration !== existing.session.generation
        || !Number.isSafeInteger(request.expectedSeq) || !Array.isArray(request.events)
      ) throw new Error('native Session cursor invalid')
      const expectedSeq = request.expectedSeq as number
      if (expectedSeq !== existing.session.events.length) {
        if (
          JSON.stringify(existing.session.events.slice(expectedSeq, expectedSeq + request.events.length))
            === JSON.stringify(request.events)
        ) return null
        throw new Error('native Session cursor conflict')
      }
      session = validatePersistedAgentSession({
        ...existing.session,
        events: [...existing.session.events, ...request.events],
      })
    } else if (request.operation === 'native-session-update-setup') {
      if (
        existing.session === undefined || request.sessionGeneration !== existing.session.generation
        || digest(request.setup as AgentSetup) !== existing.setupDigest
      ) throw new Error('native Session setup conflict')
      session = validatePersistedAgentSession({ ...existing.session, setup: request.setup })
    } else throw new Error('unsupported native Session operation')
    if (session.id !== sessionId || digest(session.setup) !== existing.setupDigest) {
      throw new Error('native Session identity mismatch')
    }
    await write(documentId, snapshot!.revision, { ...existing, session })
    return null
  }
}
