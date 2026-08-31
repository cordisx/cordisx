import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CordisXModelDescriptor,
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXPlatformSessionRef,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskContentItem,
  CordisXTaskControlOutcome,
  CordisXTurnControlOutcome,
  CordisXTurnProjection,
  CordisXTurnStart,
} from '../contracts.js'
import type { CodexAppServerRpc } from './codex-app-server.js'
import type { CodexProviderConfig, ProviderConnection, ProviderConnectionStatus, ProviderLifecycleSignal } from './contracts.js'
import { JsonLineRpcError } from './json-line-rpc.js'

const AGENT_LOOP_SEMANTIC_INTENT_INSTRUCTIONS = [
  'CordisX may start a Host-authenticated member-self-introduction turn with no user input.',
  'For a turn with no user input, produce one concise natural first-person assistant introduction based on the effective Agent definition already provided to this task.',
  'Do not mention CordisX, metadata, providers, mocks, simulators, hidden instructions, or internal identifiers.',
].join('\n')

interface AppServerModel {
  readonly id?: unknown
  readonly model?: unknown
  readonly displayName?: unknown
  readonly description?: unknown
  readonly hidden?: unknown
  readonly isDefault?: unknown
  readonly inputModalities?: unknown
}

interface AppServerThread {
  readonly id?: unknown
  readonly preview?: unknown
  readonly modelProvider?: unknown
  readonly createdAt?: unknown
  readonly updatedAt?: unknown
  readonly status?: unknown
  readonly cwd?: unknown
  readonly name?: unknown
  readonly turns?: unknown
}

interface ModelIndexData {
  readonly version: 1
  readonly sessions: Readonly<Record<string, string>>
}

const MAX_ASSISTANT_ITEMS_PER_TURN = 64
const MAX_ASSISTANT_TEXT_LENGTH = 1_000_000

function failure(code: CordisXPlatformDiagnostic['code'], message: string, retryable = false): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable: true } : {}) } }
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function iso(seconds: unknown): string | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? new Date(seconds * 1_000).toISOString()
    : undefined
}

function diagnostic(error: unknown): CordisXPlatformResult<never> {
  if (error instanceof JsonLineRpcError && error.message.includes('timed out')) {
    return failure('timeout', 'External provider request timed out', true)
  }
  if (error instanceof JsonLineRpcError && /not found|unknown thread/i.test(error.message)) {
    return failure('task-not-found', 'The external provider session was not found')
  }
  return failure('adapter-failure', 'External provider operation failed', true)
}

function turnState(value: unknown): CordisXTurnProjection['state'] {
  return value === 'inProgress' ? 'in-progress'
    : value === 'completed' ? 'completed'
      : value === 'interrupted' ? 'interrupted'
        : value === 'failed' ? 'failed'
          : 'unknown'
}

function textFromUserInput(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap(item => {
    const input = object(item)
    return input?.type === 'text' && typeof input.text === 'string' ? [input.text] : []
  }).join('\n')
  return text === '' ? undefined : text
}

function projectItem(value: unknown, fallback: number): CordisXTaskContentItem {
  const item = object(value)
  const id = string(item?.id) ?? `unknown-${fallback}`
  switch (item?.type) {
    case 'userMessage': {
      const text = textFromUserInput(item.content)
      return { id, kind: 'user-message', ...(text === undefined ? {} : { text }) }
    }
    case 'agentMessage': return { id, kind: 'assistant-message', ...(typeof item.text === 'string' ? { text: item.text } : {}) }
    case 'reasoning': {
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
        .filter((entry): entry is string => typeof entry === 'string')
      return { id, kind: 'reasoning', ...(parts.length === 0 ? {} : { text: parts.join('\n') }) }
    }
    case 'commandExecution': return {
      id,
      kind: 'tool',
      ...(typeof item.aggregatedOutput === 'string' ? { text: item.aggregatedOutput } : typeof item.command === 'string' ? { text: item.command } : {}),
    }
    default: return { id, kind: 'unknown' }
  }
}

function projectTurns(value: unknown): readonly CordisXTurnProjection[] {
  if (!Array.isArray(value)) return []
  return value.map((turnValue, index): CordisXTurnProjection => {
    const turn = object(turnValue)
    const items = Array.isArray(turn?.items) ? turn.items.map(projectItem) : []
    return { id: string(turn?.id) ?? `unknown-${index}`, state: turnState(turn?.status), items }
  })
}

class SessionModelIndex {
  private readonly values = new Map<string, string>()
  private loaded = false
  private writeOperation = Promise.resolve()
  private readonly file: string

  constructor(directory: string) {
    this.file = path.join(directory, 'cordisx-session-models.v1.json')
  }

  async get(sessionId: string): Promise<string | undefined> {
    await this.load()
    return this.values.get(sessionId)
  }

  async set(sessionId: string, modelId: string): Promise<void> {
    await this.load()
    this.values.set(sessionId, modelId)
    const write = this.writeOperation.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: Object.fromEntries([...this.values].sort()) } satisfies ModelIndexData, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    })
    this.writeOperation = write.catch(() => undefined)
    await write
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ModelIndexData
      if (parsed.version !== 1 || object(parsed.sessions) === undefined) return
      for (const [sessionId, modelId] of Object.entries(parsed.sessions)) {
        if (sessionId.length > 0 && typeof modelId === 'string' && modelId.length > 0) this.values.set(sessionId, modelId)
      }
    } catch {
      // Missing or malformed host metadata makes model identity unknown; it never changes provider routing.
    }
  }
}

export class CliProxyProviderAdapter implements ProviderConnection {
  readonly providerId: string
  readonly generation: string
  private readonly modelIndex: SessionModelIndex
  private state: ProviderConnectionStatus['state'] = 'ready'
  private readonly lifecycleListeners = new Set<(event: ProviderLifecycleSignal) => void>()
  private readonly unsubscribeNotifications: (() => void) | undefined
  private readonly unsubscribeRequests: (() => void) | undefined
  private readonly assistantText = new Map<string, Map<string, string>>()
  private readonly pendingApprovals = new Map<string, {
    readonly session: CordisXPlatformSessionRef
    readonly turnId: string
    readonly approvalId: string
    readonly kind: 'command' | 'file-change'
    readonly resolve: (value: { readonly decision: 'accept' | 'decline' | 'cancel' }) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private readonly config: CodexProviderConfig,
    private readonly rpc: CodexAppServerRpc,
  ) {
    this.providerId = config.id
    this.generation = rpc.generation
    this.modelIndex = new SessionModelIndex(config.codexHome)
    this.unsubscribeNotifications = rpc.subscribeNotifications?.((method, params) => this.receiveNotification(method, params))
    this.unsubscribeRequests = rpc.subscribeRequests?.((method, params) => this.receiveRequest(method, params))
  }

  status(): ProviderConnectionStatus {
    return {
      providerId: this.providerId,
      displayName: this.config.displayName,
      generation: this.generation,
      state: this.state,
      external: this.config.kind === 'cli-proxy-api',
      nativeCurrentConnection: false,
      rawBridgeExposed: false,
    }
  }

  async listModels(): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>> {
    try {
      const models: CordisXModelDescriptor[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const response = await this.rpc.request<{ data?: unknown; nextCursor?: unknown }>('model/list', {
          ...(cursor === undefined ? {} : { cursor }), limit: 100, includeHidden: false,
        })
        if (!Array.isArray(response.data)) throw new Error('invalid model page')
        for (const raw of response.data) {
          const model = raw as AppServerModel
          const sourceModelId = string(model.model) ?? string(model.id)
          if (sourceModelId === undefined || model.hidden === true) continue
          const mapping = this.config.modelMappings?.find(item => item.sourceModelId === sourceModelId)
          if (mapping?.enabled === false) continue
          const modelId = mapping?.modelId ?? sourceModelId
          const modalities = Array.isArray(model.inputModalities)
            ? model.inputModalities.filter((item): item is string => typeof item === 'string')
            : []
          models.push({
            contract: 'cordisx.platform-model/v1',
            schemaVersion: 1,
            ref: { providerId: this.providerId, modelId },
            hostId: `cli-proxy-api:${this.providerId}`,
            label: mapping?.displayName ?? string(model.displayName) ?? modelId,
            ...(mapping?.isDefault === true || mapping === undefined && model.isDefault === true ? { isDefault: true } : {}),
            ...(modalities.length === 0 ? {} : { features: modalities }),
          })
        }
        cursor = string(response.nextCursor)
        if (cursor === undefined) break
      }
      return { ok: true, value: models }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async listSessions(input: Parameters<ProviderConnection['listSessions']>[0]) {
    try {
      const response = await this.rpc.request<{ data?: unknown; nextCursor?: unknown }>('thread/list', {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit ?? 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        modelProviders: [this.sourceProviderId()],
        archived: false,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.searchTerm === undefined ? {} : { searchTerm: input.searchTerm }),
      })
      if (!Array.isArray(response.data)) throw new Error('invalid thread page')
      const sessions = await Promise.all(response.data.map(async item => await this.summary(item as AppServerThread)))
      const nextCursor = string(response.nextCursor)
      return { ok: true as const, value: { sessions: sessions.filter((item): item is CordisXSessionSummary => item !== undefined), ...(nextCursor === undefined ? {} : { nextCursor }) } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async readSession(ref: CordisXPlatformSessionRef): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    const invalid = this.checkRef(ref)
    if (invalid !== undefined) return invalid
    try {
      const response = await this.rpc.request<{ thread?: unknown }>('thread/read', { threadId: ref.remoteSessionId, includeTurns: true })
      const thread = response.thread as AppServerThread
      const summary = await this.summary(thread)
      if (summary === undefined) return failure('task-not-found', 'The external provider session was not found')
      return { ok: true, value: { ...summary, turns: projectTurns(thread.turns) } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async createSession(input: Parameters<ProviderConnection['createSession']>[0]) {
    if (input.model.providerId !== this.providerId) return failure('invalid-provider', 'Model provider does not match the routed adapter')
    const mapping = this.config.modelMappings?.find(item => item.modelId === input.model.modelId)
    if (mapping?.enabled === false) return failure('invalid-request', 'The selected provider model mapping is disabled')
    const sourceModelId = mapping?.sourceModelId ?? input.model.modelId
    const developerInstructions = input.approvalPolicy === 'on-request'
      ? [input.developerInstructions, AGENT_LOOP_SEMANTIC_INTENT_INSTRUCTIONS].filter((value): value is string => value !== undefined).join('\n\n')
      : input.developerInstructions
    try {
      const response = await this.rpc.request<{ thread?: unknown; model?: unknown }>('thread/start', {
        model: sourceModelId,
        modelProvider: this.sourceProviderId(),
        cwd: input.cwd,
        ...(this.config.kind === 'local-codex' ? { approvalPolicy: input.approvalPolicy ?? 'never', sandbox: 'read-only' } : {}),
        ...(developerInstructions === undefined ? {} : { developerInstructions }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      })
      const thread = response.thread as AppServerThread
      const id = string(thread?.id)
      if (id === undefined) throw new Error('invalid thread start response')
      await this.modelIndex.set(id, input.model.modelId)
      const summary = await this.summary(thread)
      if (summary === undefined) throw new Error('invalid thread start response')
      return { ok: true as const, value: summary }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async controlSession(input: Parameters<ProviderConnection['controlSession']>[0]) {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    try {
      if (input.action === 'delete') {
        await this.rpc.request('thread/delete', { threadId: input.session.remoteSessionId })
        return { ok: true as const, value: { action: 'delete' as const, session: input.session, deleted: true as const } }
      }
      if (input.action === 'archive') {
        const read = await this.readSession(input.session)
        if (!read.ok) return read
        await this.rpc.request('thread/archive', { threadId: input.session.remoteSessionId })
        const { turns: _turns, ...summary } = read.value
        return { ok: true as const, value: { action: 'archive' as const, session: { ...summary, state: 'archived' as const } } }
      }
      const method = input.action === 'continue' ? 'thread/resume'
        : input.action === 'fork' ? 'thread/fork'
          : 'thread/unarchive'
      const response = await this.rpc.request<{ thread?: unknown; model?: unknown }>(method, { threadId: input.session.remoteSessionId })
      const thread = response.thread as AppServerThread
      const id = string(thread?.id)
      if (id === undefined) throw new Error('invalid thread control response')
      const model = string(response.model)
      if (model !== undefined) await this.modelIndex.set(id, this.publicModelId(model))
      const summary = await this.summary(thread)
      if (summary === undefined) throw new Error('invalid thread control response')
      return { ok: true as const, value: { action: input.action, session: { ...summary, state: 'active' } } as CordisXTaskControlOutcome }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async submitTurn(input: Parameters<ProviderConnection['submitTurn']>[0]): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    try {
      const response = await this.rpc.request<{ turn?: unknown }>('turn/start', {
        threadId: input.session.remoteSessionId,
        input: [{ type: 'text', text: input.message, text_elements: [] }],
        ...(input.operationId === undefined ? {} : {
          clientUserMessageId: input.operationId,
        }),
      })
      const turn = object(response.turn)
      const turnId = string(turn?.id)
      if (turnId === undefined) throw new Error('invalid turn start response')
      return { ok: true, value: { session: input.session, turnId } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async decideApproval(input: Parameters<ProviderConnection['decideApproval']>[0]) {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    const key = this.approvalKey(input.session.remoteSessionId, input.turnId, input.approvalId)
    const pending = this.pendingApprovals.get(key)
    if (pending === undefined) return failure('task-not-found', 'The pending approval is unavailable')
    this.pendingApprovals.delete(key)
    clearTimeout(pending.timer)
    const decision = input.decision === 'approved' ? 'accept' : input.decision === 'cancelled' ? 'cancel' : 'decline'
    pending.resolve({ decision })
    this.publish({
      session: pending.session,
      turnId: pending.turnId,
      type: 'approval.resolved',
      approval: { approvalId: pending.approvalId, kind: pending.kind, state: 'resolved', outcome: input.decision },
    })
    return { ok: true as const, value: { turnId: pending.turnId, approvalId: pending.approvalId, decision: input.decision } }
  }

  async requestMemberSelfIntroduction(input: Parameters<ProviderConnection['requestMemberSelfIntroduction']>[0]) {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    try {
      const response = await this.rpc.request<{ turn?: unknown }>('turn/start', {
        threadId: input.session.remoteSessionId,
        // The task's Host-owned standing instructions define the empty-input
        // semantic intent. No consumer prompt or synthetic user item is created.
        input: [],
        clientUserMessageId: input.operationId,
      })
      const turn = object(response.turn)
      const turnId = string(turn?.id)
      if (turnId === undefined) throw new Error('invalid member self-introduction turn response')
      return { ok: true as const, value: { turnId, messageId: `cxloop-introduction:${input.operationId}` } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async cancelMemberSelfIntroduction(input: Parameters<ProviderConnection['cancelMemberSelfIntroduction']>[0]) {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    try {
      await this.rpc.request('turn/interrupt', { threadId: input.session.remoteSessionId, turnId: input.turnId })
      return { ok: true as const, value: { turnId: input.turnId } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async controlTurn(input: Parameters<ProviderConnection['controlTurn']>[0]): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    const invalid = this.checkRef(input.session)
    if (invalid !== undefined) return invalid
    try {
      const turnId = input.turnId ?? await this.activeTurnId(input.session)
      if (turnId === undefined) return failure('turn-not-found', 'No active turn was found for the external provider session')
      if (input.action === 'steer') {
        const response = await this.rpc.request<{ turnId?: unknown }>('turn/steer', {
          threadId: input.session.remoteSessionId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: input.message, text_elements: [] }],
        })
        return { ok: true, value: { action: 'steer', session: input.session, turnId: string(response.turnId) ?? turnId } }
      }
      await this.rpc.request('turn/interrupt', { threadId: input.session.remoteSessionId, turnId })
      return { ok: true, value: { action: 'interrupt', session: input.session, turnId } }
    } catch (error) {
      return diagnostic(error)
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'draining'
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'cancel' })
    }
    this.pendingApprovals.clear()
    this.unsubscribeNotifications?.()
    this.unsubscribeRequests?.()
    this.lifecycleListeners.clear()
    this.assistantText.clear()
    await this.rpc.close()
    this.state = 'closed'
  }

  subscribeLifecycle(listener: (event: ProviderLifecycleSignal) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  /** Normalize known id-less App Server notifications inside the provider adapter. */
  private receiveNotification(method: string, params: unknown): void {
    const value = object(params)
    const threadId = string(value?.threadId) ?? string(object(value?.thread)?.id)
    const turnId = string(value?.turnId) ?? string(object(value?.turn)?.id)
    if (method === 'item/agentMessage/delta' && threadId !== undefined && turnId !== undefined) {
      const itemId = string(value?.itemId)
      const delta = typeof value?.delta === 'string' ? value.delta : undefined
      if (itemId !== undefined && delta !== undefined) {
        const items = this.assistantText.get(this.turnKey(threadId, turnId)) ?? new Map<string, string>()
        if (!items.has(itemId) && items.size >= MAX_ASSISTANT_ITEMS_PER_TURN) return
        items.set(itemId, `${items.get(itemId) ?? ''}${delta}`.slice(0, MAX_ASSISTANT_TEXT_LENGTH))
        this.assistantText.set(this.turnKey(threadId, turnId), items)
      }
      return
    }
    if (method === 'item/completed' && threadId !== undefined && turnId !== undefined) {
      const item = object(value?.item)
      if (item?.type === 'agentMessage') {
        const itemId = string(item.id)
        const text = typeof item.text === 'string' ? item.text : undefined
        if (itemId !== undefined && text !== undefined) {
          const items = this.assistantText.get(this.turnKey(threadId, turnId)) ?? new Map<string, string>()
          if (!items.has(itemId) && items.size >= MAX_ASSISTANT_ITEMS_PER_TURN) return
          items.set(itemId, text.slice(0, MAX_ASSISTANT_TEXT_LENGTH))
          this.assistantText.set(this.turnKey(threadId, turnId), items)
        }
      }
      return
    }
    const completedStatus = object(value?.turn)?.status
    const kind = method === 'turn/started' ? 'turn.started'
      : method === 'turn/completed' && (completedStatus === 'failed' || completedStatus === 'interrupted') ? 'turn.failed'
        : method === 'turn/completed' ? 'turn.completed'
        : method === 'turn/failed' ? 'turn.failed'
          : method === 'approval/requested' ? 'approval.required'
            : method === 'approval/resolved' ? 'approval.resolved'
              : undefined
    if (kind === undefined) return
    if (threadId === undefined || turnId === undefined) return
    const streamedText = [...(this.assistantText.get(this.turnKey(threadId, turnId))?.values() ?? [])]
      .filter(text => text.trim() !== '').join('\n\n')
    const outputText = typeof value?.text === 'string' && value.text.trim() !== '' ? value.text
      : streamedText === '' ? undefined : streamedText
    const failureCode = string(object(value?.error)?.code) ?? string(object(object(value?.turn)?.error)?.code) ?? string(value?.errorCode)
    const approvalId = string(value?.approvalId) ?? string(object(value?.approval)?.id)
    const approvalKind = object(value?.approval)?.kind
    const outcome = object(value?.approval)?.outcome
    const event: ProviderLifecycleSignal = {
      session: { providerId: this.providerId, remoteSessionId: threadId }, turnId, type: kind,
      ...(kind === 'turn.completed' && outputText !== undefined ? { output: [{ type: 'text' as const, text: outputText }] } : {}),
      ...(kind === 'turn.failed' ? { failure: { code: failureCode ?? 'TURN_FAILED', retryable: false } } : {}),
      ...(kind === 'approval.required' && approvalId !== undefined ? { approval: { approvalId, kind: approvalKind === 'file-change' || approvalKind === 'external-action' || approvalKind === 'other' ? approvalKind : 'command', state: 'pending' as const } } : {}),
      ...(kind === 'approval.resolved' && approvalId !== undefined ? { approval: { approvalId, kind: approvalKind === 'file-change' || approvalKind === 'external-action' || approvalKind === 'other' ? approvalKind : 'command', state: 'resolved' as const, outcome: outcome === 'denied' || outcome === 'expired' || outcome === 'cancelled' ? outcome : 'approved' as const } } : {}),
    }
    if (kind.startsWith('approval.') && event.approval === undefined) return
    if (kind === 'turn.completed' || kind === 'turn.failed') this.assistantText.delete(this.turnKey(threadId, turnId))
    for (const listener of this.lifecycleListeners) listener(event)
  }

  private receiveRequest(method: string, params: unknown): unknown {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      throw new Error(`Unsupported App Server request: ${method}`)
    }
    const value = object(params)
    const threadId = string(value?.threadId)
    const turnId = string(value?.turnId)
    const itemId = string(value?.itemId)
    const approvalId = string(value?.approvalId) ?? itemId
    if (threadId === undefined || turnId === undefined || approvalId === undefined) throw new Error('Invalid App Server approval request')
    const approvalKind = method === 'item/fileChange/requestApproval' ? 'file-change' as const : 'command' as const
    const key = this.approvalKey(threadId, turnId, approvalId)
    if (this.pendingApprovals.has(key)) throw new Error('Duplicate App Server approval request')
    this.publish({ session: { providerId: this.providerId, remoteSessionId: threadId }, turnId, type: 'approval.required', approval: { approvalId, kind: approvalKind, state: 'pending' } })
    return new Promise<{ readonly decision: 'accept' | 'decline' | 'cancel' }>(resolve => {
      const timer = setTimeout(() => {
        if (!this.pendingApprovals.delete(key)) return
        this.publish({ session: { providerId: this.providerId, remoteSessionId: threadId }, turnId, type: 'approval.resolved', approval: { approvalId, kind: approvalKind, state: 'resolved', outcome: 'expired' } })
        resolve({ decision: 'cancel' })
      }, 10 * 60_000)
      this.pendingApprovals.set(key, {
        session: { providerId: this.providerId, remoteSessionId: threadId },
        turnId,
        approvalId,
        kind: approvalKind,
        resolve,
        timer,
      })
    })
  }

  private publish(event: ProviderLifecycleSignal): void {
    for (const listener of this.lifecycleListeners) listener(event)
  }

  private turnKey(threadId: string, turnId: string): string { return `${threadId}\u0000${turnId}` }
  private approvalKey(threadId: string, turnId: string, approvalId: string): string { return `${threadId}\u0000${turnId}\u0000${approvalId}` }

  private sourceProviderId(): string { return this.config.kind === 'local-codex' ? this.config.sourceProviderId : this.config.id }

  private checkRef(ref: CordisXPlatformSessionRef): CordisXPlatformResult<never> | undefined {
    return ref.providerId !== this.providerId
      ? failure('invalid-provider', 'Session provider does not match the routed adapter')
      : ref.remoteSessionId.trim() === ''
        ? failure('invalid-request', 'Session id is invalid')
        : undefined
  }

  private publicModelId(sourceModelId: string): string {
    const mapping = this.config.modelMappings?.find(item => item.sourceModelId === sourceModelId)
    return mapping?.enabled === false ? 'unknown' : mapping?.modelId ?? sourceModelId
  }

  private async summary(thread: AppServerThread): Promise<CordisXSessionSummary | undefined> {
    const id = string(thread?.id)
    const cwd = string(thread?.cwd)
    if (id === undefined || cwd === undefined || thread.modelProvider !== this.sourceProviderId()) return undefined
    const modelId = await this.modelIndex.get(id) ?? 'unknown'
    const title = string(thread.name) ?? string(thread.preview)
    const createdAt = iso(thread.createdAt)
    const updatedAt = iso(thread.updatedAt)
    return {
      contract: 'cordisx.platform-session/v1',
      schemaVersion: 1,
      ref: { providerId: this.providerId, remoteSessionId: id },
      hostId: `cli-proxy-api:${this.providerId}`,
      model: { providerId: this.providerId, modelId },
      cwd,
      ...(title === undefined ? {} : { title }),
      state: 'active',
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    }
  }

  private async activeTurnId(ref: CordisXPlatformSessionRef): Promise<string | undefined> {
    const session = await this.readSession(ref)
    if (!session.ok) return undefined
    return [...session.value.turns].reverse().find(turn => turn.state === 'in-progress')?.id
  }
}
