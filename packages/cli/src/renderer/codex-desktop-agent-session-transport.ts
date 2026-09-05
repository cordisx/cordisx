import type { AgentOptions } from '@cordisx/protocol/agents/v1'
import type { ApprovalOutcome, UserMessage } from '@cordisx/protocol/sessions/v1'
import type {
  CordisXDriverAgentStatus,
  CordisXDriverApprovalRequest,
  CordisXDriverMessageClaimed,
  CordisXDriverSessionEvent,
  CordisXPrivateAgentDriver,
} from './agent-session-runtime.js'

/**
 * Exact audited Desktop bridge revisions. New builds are additive entries only;
 * unknown version/build/flavor triples remain unavailable rather than guessing
 * that a private Electron bridge is compatible.
 */
export const CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS = Object.freeze([
  Object.freeze({
    appVersion: '26.818.61809', buildNumber: '7019', buildFlavor: 'prod', hostId: 'local',
  }),
  Object.freeze({
    appVersion: '26.901.41600', buildNumber: '7982', buildFlavor: 'prod', hostId: 'local',
  }),
] as const)
/** Historical first audited pin, retained for existing callers and fixtures. */
export const CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN = CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[0]
type CodexDesktopAgentSessionTransportPin = typeof CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[number]

interface ElectronBridge {
  readonly sendMessageFromView?: (value: unknown) => Promise<unknown> | unknown
  readonly getSentryInitOptions?: () => Promise<unknown> | unknown
}
interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}
interface QueuedMessage {
  readonly message: UserMessage
  readonly target: 'next-turn' | 'next-step'
  readonly wakeup: boolean
}
interface ActiveTurn {
  readonly id: string
  readonly ordinal: number
  terminal: boolean
  readonly assistant: Map<string, string>
  readonly emittedTools: Set<string>
}
interface NativeSession {
  readonly sessionId: string
  readonly threadId: string
  nextTurn: number
  active?: ActiveTurn
  starting?: { readonly ordinal: number; readonly message: UserMessage }
  readonly queue: QueuedMessage[]
  status: 'idle' | 'running'
}

const clone = <Value>(value: Value): Value => structuredClone(value)
const object = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
const text = (value: unknown, maximum = 1_000_000): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
)
const integer = (value: unknown): number | undefined => Number.isSafeInteger(value) ? value as number : undefined
const id = (): string => crypto.randomUUID()
const messageInput = (message: UserMessage): readonly Record<string, unknown>[] | undefined => {
  const input: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (block.type === 'text') input.push({ type: 'text', text: block.text, text_elements: [] })
    else if (block.type === 'image') input.push({ type: 'image', url: block.ref })
    else return undefined
  }
  return input
}
const injectedItems = (message: UserMessage): readonly Record<string, unknown>[] | undefined => {
  const content: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'input_text', text: block.text })
    else if (block.type === 'image') content.push({ type: 'input_image', image_url: block.ref })
    else return undefined
  }
  return [{ type: 'message', role: 'user', content }]
}

/**
 * Host-private transport over the Desktop renderer's already-existing local
 * app-server connection. It never creates a provider/process and never exports
 * the preload bridge, request ids, native thread ids, or raw native payloads.
 */
export class CodexDesktopAgentSessionTransport implements CordisXPrivateAgentDriver {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly sessions = new Map<string, NativeSession>()
  private readonly byThread = new Map<string, NativeSession>()
  private readonly replacements = new Set<() => void>()
  private readonly eventListeners = new Set<(event: CordisXDriverSessionEvent) => void>()
  private readonly statusListeners = new Set<(event: CordisXDriverAgentStatus) => void>()
  private readonly claimedListeners = new Set<(event: CordisXDriverMessageClaimed) => void>()
  private readonly approvalListeners = new Set<(request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>>()
  private disposed = false
  private connectionReplaced = false
  /** The first connected/initialized pair belongs to this renderer's bootstrap. */
  private connectionBootstrapped = false

  private constructor(
    private readonly bridge: Required<ElectronBridge>,
    private readonly pin: CodexDesktopAgentSessionTransportPin,
  ) {
    window.addEventListener('message', this.receive, true)
  }

  static async connect(): Promise<CodexDesktopAgentSessionTransport | undefined> {
    const page = globalThis as typeof globalThis & {
      readonly electronBridge?: ElectronBridge
      readonly codexWindowType?: unknown
      readonly location?: Location
    }
    const bridge = page.electronBridge
    if (
      page.codexWindowType !== 'electron' || page.location?.href !== 'app://-/index.html'
      || typeof bridge?.sendMessageFromView !== 'function' || typeof bridge.getSentryInitOptions !== 'function'
    ) return undefined
    try {
      const options = object(await bridge.getSentryInitOptions())
      const pin = CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS.find(candidate => (
        options?.appVersion === candidate.appVersion
        && options.buildNumber === candidate.buildNumber
        && options.buildFlavor === candidate.buildFlavor
      ))
      if (pin === undefined) return undefined
      return new CodexDesktopAgentSessionTransport(bridge as Required<ElectronBridge>, pin)
    } catch {
      return undefined
    }
  }

  async create(input: { readonly sessionId: string; readonly options: AgentOptions }): Promise<
    | { readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } }
    | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }
  > {
    if (this.disposed || this.connectionReplaced) return { status: 'unavailable', code: 'host-unavailable' }
    if (this.sessions.has(input.sessionId)) return { status: 'unavailable', code: 'unsupported' }
    const model = input.options.model ?? await this.defaultModel()
    if (model === undefined) return { status: 'unavailable', code: 'host-unavailable' }
    try {
      const result = object(await this.request('thread/start', { model, cwd: '' }))
      const threadId = text(object(result?.thread)?.id)
      if (threadId === undefined || this.byThread.has(threadId)) {
        return { status: 'unavailable', code: 'host-unavailable' }
      }
      const session: NativeSession = { sessionId: input.sessionId, threadId, nextTurn: 0, queue: [], status: 'idle' }
      this.sessions.set(input.sessionId, session)
      this.byThread.set(threadId, session)
      return { status: 'accepted', detail: { kind: 'host', ref: `codex-thread:${threadId}` } }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }

  async resume(input: { readonly sessionId: string }): Promise<
    | { readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } }
    | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }
  > {
    if (this.disposed || this.connectionReplaced) return { status: 'unavailable', code: 'host-unavailable' }
    const known = this.sessions.get(input.sessionId)
    const threadId = known?.threadId
      ?? (input.sessionId.startsWith('codex-thread:') ? input.sessionId.slice('codex-thread:'.length) : input.sessionId)
    try {
      const result = object(await this.request('thread/resume', { threadId }))
      const resumed = text(object(result?.thread)?.id)
      if (resumed !== threadId) return { status: 'unavailable', code: 'host-unavailable' }
      if (known === undefined) {
        const session: NativeSession = { sessionId: input.sessionId, threadId, nextTurn: 0, queue: [], status: 'idle' }
        this.sessions.set(input.sessionId, session)
        this.byThread.set(threadId, session)
      }
      return { status: 'accepted', detail: { kind: 'host', ref: `codex-thread:${threadId}` } }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }

  async submit(input: {
    readonly sessionId: string
    readonly message: UserMessage
    readonly target: 'next-turn' | 'next-step'
    readonly wakeup: boolean
  }): Promise<'accepted' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'unavailable'
    if (input.target === 'next-turn' && (session.active !== undefined || session.starting !== undefined)) {
      session.queue.push({ message: clone(input.message), target: input.target, wakeup: input.wakeup })
      return 'accepted'
    }
    if (input.target === 'next-step' && input.wakeup === false) return await this.inject(session, input.message)
    if (input.target === 'next-step' && session.active !== undefined) return await this.steer(session, input.message)
    return await this.startTurn(session, input.message)
  }

  async discard(
    input: { readonly sessionId: string; readonly messageId: string },
  ): Promise<'accepted' | 'not-found' | 'already-claimed' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'unavailable'
    const index = session.queue.findIndex(item => item.message.id === input.messageId)
    if (index >= 0) {
      session.queue.splice(index, 1)
      return 'accepted'
    }
    if (session.starting?.message.id === input.messageId || session.active !== undefined) return 'already-claimed'
    return 'not-found'
  }

  async cancel(
    input: { readonly sessionId: string; readonly keepInbox: boolean },
  ): Promise<'accepted' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    const active = session?.active
    if (this.disposed || session === undefined || active === undefined || active.terminal) return 'unavailable'
    try {
      await this.request('turn/interrupt', { threadId: session.threadId, turnId: active.id })
      if (!input.keepInbox) session.queue.splice(0)
      return 'accepted'
    } catch {
      return 'unavailable'
    }
  }

  onSessionEvent(listener: (event: CordisXDriverSessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }
  onAgentStatus(listener: (event: CordisXDriverAgentStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }
  onMessageClaimed(listener: (event: CordisXDriverMessageClaimed) => void): () => void {
    this.claimedListeners.add(listener)
    return () => this.claimedListeners.delete(listener)
  }
  onApprovalRequest(listener: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }
  onReplacement(listener: () => void): () => void {
    this.replacements.add(listener)
    return () => this.replacements.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.receive, true)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex Desktop Agent/Session transport disposed'))
    }
    this.pending.clear()
    this.sessions.clear()
    this.byThread.clear()
    this.replacements.clear()
    this.eventListeners.clear()
    this.statusListeners.clear()
    this.claimedListeners.clear()
    this.approvalListeners.clear()
  }

  private async startTurn(session: NativeSession, message: UserMessage): Promise<'accepted' | 'unavailable'> {
    const input = messageInput(message)
    if (input === undefined || session.starting !== undefined || session.active !== undefined) return 'unavailable'
    const ordinal = ++session.nextTurn
    session.starting = { ordinal, message: clone(message) }
    this.emitStatus({ sessionId: session.sessionId, status: 'running' })
    try {
      const result = object(
        await this.request('turn/start', {
          threadId: session.threadId,
          input,
          clientUserMessageId: message.id,
        }),
      )
      const turnId = text(object(result?.turn)?.id)
      if (turnId === undefined) throw new Error('turn/start returned no turn id')
      const observed = session.active as ActiveTurn | undefined
      if (observed === undefined) {
        session.active = { id: turnId, ordinal, terminal: false, assistant: new Map(), emittedTools: new Set() }
      } else if (observed.id !== turnId) throw new Error('turn/start notification did not match response')
      delete session.starting
      this.deferClaim(session.sessionId, message.id, ordinal)
      return 'accepted'
    } catch {
      delete session.starting
      if (session.active === undefined) this.emitStatus({ sessionId: session.sessionId, status: 'idle' })
      return 'unavailable'
    }
  }

  private async steer(session: NativeSession, message: UserMessage): Promise<'accepted' | 'unavailable'> {
    const input = messageInput(message)
    const active = session.active
    if (input === undefined || active === undefined || active.terminal) return 'unavailable'
    try {
      await this.request('turn/steer', {
        threadId: session.threadId,
        expectedTurnId: active.id,
        input,
        clientUserMessageId: message.id,
      })
      this.deferClaim(session.sessionId, message.id, active.ordinal)
      return 'accepted'
    } catch {
      return 'unavailable'
    }
  }

  private async inject(session: NativeSession, message: UserMessage): Promise<'accepted' | 'unavailable'> {
    const items = injectedItems(message)
    if (items === undefined) return 'unavailable'
    try {
      await this.request('thread/inject_items', { threadId: session.threadId, items })
      this.deferClaim(session.sessionId, message.id, session.active?.ordinal ?? session.nextTurn + 1)
      return 'accepted'
    } catch {
      return 'unavailable'
    }
  }

  private deferClaim(sessionId: string, messageId: string, turn: number): void {
    setTimeout(() => {
      if (this.disposed) return
      const event = { sessionId, messageId, turn }
      for (const listener of [...this.claimedListeners]) listener(clone(event))
    }, 0)
  }

  private async defaultModel(): Promise<string | undefined> {
    try {
      const data = object(await this.request('model/list', { limit: 100, includeHidden: false }))?.data
      if (!Array.isArray(data)) return undefined
      const model = data.find(item => object(item)?.isDefault === true) ?? data[0]
      return text(object(model)?.id) ?? text(object(model)?.modelId)
    } catch {
      return undefined
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || this.connectionReplaced) throw new Error('Codex Desktop Agent/Session transport unavailable')
    const requestId = id()
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Codex Desktop request timed out'))
      }, 30_000)
      this.pending.set(requestId, { resolve, reject, timer })
    })
    try {
      await this.bridge.sendMessageFromView({
        type: 'mcp-request',
        hostId: this.pin.hostId,
        request: { id: requestId, method, params: clone(params) },
      })
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending !== undefined) {
        this.pending.delete(requestId)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error('Codex Desktop request rejected'))
      }
    }
    return await response
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (this.disposed || (event.source !== null && event.source !== window)) return
    const envelope = object(event.data)
    if (text(envelope?.hostId) !== this.pin.hostId) return
    const type = text(envelope?.type)
    if (type === 'codex-app-server-connection-changed' || type === 'codex-app-server-initialized') {
      const state = text(envelope?.state)
      // Desktop 7982 can publish connected/initialized after the first
      // thread/start response. They establish the connection backing this
      // renderer, not a replacement of it. Once initialized, every later
      // lifecycle event remains an exact first-terminal replacement fence.
      if (!this.connectionBootstrapped) {
        if (type === 'codex-app-server-initialized') this.connectionBootstrapped = true
        else if (state === 'connected') return
        else this.connectionBootstrapped = true
        return
      }
      if (this.sessions.size > 0 || this.pending.size > 0) {
        this.connectionReplaced = true
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Codex Desktop app-server connection replaced'))
        }
        this.pending.clear()
        this.sessions.clear()
        this.byThread.clear()
        for (const callback of [...this.replacements]) callback()
      }
      return
    }
    if (type === 'mcp-response') {
      this.receiveResponse(object(envelope?.message) ?? object(envelope?.response))
      return
    }
    if (type === 'mcp-notification') {
      this.receiveNotification(object(envelope?.message) ?? object(envelope?.notification))
      return
    }
    if (type === 'mcp-request') this.receiveServerRequest(event, object(envelope?.request) ?? object(envelope?.message))
  }

  private receiveResponse(message: Record<string, unknown> | undefined): void {
    const requestId = text(message?.id)
    if (requestId === undefined) return
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    if (message?.error !== undefined) {
      pending.reject(new Error(text(object(message.error)?.message) ?? 'Codex Desktop request failed'))
    } else pending.resolve(message?.result)
  }

  private receiveNotification(message: Record<string, unknown> | undefined): void {
    const method = text(message?.method)
    const params = object(message?.params)
    const threadId = text(params?.threadId)
    if (method === undefined || params === undefined || threadId === undefined) return
    const session = this.byThread.get(threadId)
    if (session === undefined) return
    const nativeTurn = object(params.turn)
    const turnId = text(params.turnId) ?? text(nativeTurn?.id)
    if (method === 'turn/started') {
      if (turnId === undefined) return
      const ordinal = session.starting?.ordinal ?? ++session.nextTurn
      session.active ??= { id: turnId, ordinal, terminal: false, assistant: new Map(), emittedTools: new Set() }
      this.emitStatus({ sessionId: session.sessionId, status: 'running' })
      this.emit({ sessionId: session.sessionId, type: 'turn/start', data: { turn: session.active.ordinal } })
      this.emit({ sessionId: session.sessionId, type: 'step/start', data: { turn: session.active.ordinal, step: 1 } })
      return
    }
    const active = session.active
    if (active === undefined || (turnId !== undefined && active.id !== turnId) || active.terminal) return
    if (method === 'item/agentMessage/delta') {
      const itemId = text(params.itemId)
      const delta = typeof params.delta === 'string' ? params.delta : undefined
      if (itemId === undefined || delta === undefined) return
      active.assistant.set(itemId, (active.assistant.get(itemId) ?? '') + delta)
      this.emit({
        sessionId: session.sessionId,
        type: 'assistant/chunk',
        data: {
          turn: active.ordinal,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: delta },
        },
      })
      return
    }
    if (method === 'item/completed' || method === 'item/started') {
      this.observeItem(session, active, object(params.item), method === 'item/completed')
      return
    }
    if (method === 'turn/completed') this.completeTurn(session, active, nativeTurn)
  }

  private observeItem(
    session: NativeSession,
    active: ActiveTurn,
    item: Record<string, unknown> | undefined,
    completed: boolean,
  ): void {
    if (item === undefined) return
    const kind = text(item?.type)
    const itemId = text(item?.id)
    if (kind === undefined || itemId === undefined) return
    if (kind === 'agentMessage' && completed) {
      const content = text(item?.text) ?? active.assistant.get(itemId) ?? ''
      active.assistant.delete(itemId)
      const block = { type: 'text' as const, text: content }
      this.emit({
        sessionId: session.sessionId,
        type: 'assistant/message',
        data: {
          turn: active.ordinal,
          step: 1,
          message: {
            id: itemId,
            role: 'assistant',
            content: [block],
            source: { kind: 'model', provider: 'codex-desktop', model: 'current-thread' },
          },
        },
      })
      return
    }
    const tool = this.toolObservation(item, completed)
    if (tool === undefined) return
    if (!active.emittedTools.has(itemId)) {
      active.emittedTools.add(itemId)
      this.emit({
        sessionId: session.sessionId,
        type: 'tool/call',
        data: {
          turn: active.ordinal,
          step: 1,
          callId: itemId,
          name: tool.name,
          arguments: tool.arguments,
        },
      })
    }
    if (completed) {
      this.emit({
        sessionId: session.sessionId,
        type: 'tool/result',
        data: {
          turn: active.ordinal,
          step: 1,
          message: {
            id: `tool-result:${itemId}`,
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: itemId,
              content: [{ type: 'text', text: tool.result }],
              ...(tool.error ? { isError: true } : {}),
            }],
            source: { kind: 'tool', callId: itemId },
          },
          ...(tool.error ? { error: { name: tool.name, code: 'native-tool-failed' } } : {}),
          meta: { nativeItemType: text(item.type) ?? 'unknown' },
        },
      })
    }
  }

  private toolObservation(
    item: Record<string, unknown>,
    completed: boolean,
  ): { name: string; arguments: string; result: string; error: boolean } | undefined {
    const kind = text(item.type)
    if (kind === 'commandExecution') {
      const command = typeof item.command === 'string' ? item.command : JSON.stringify(item.command ?? '')
      return {
        name: 'codex.commandExecution',
        arguments: JSON.stringify({ command }),
        result: completed ? text(item.aggregatedOutput) ?? '' : '',
        error: item.status === 'failed',
      }
    }
    if (kind === 'fileChange') {
      return {
        name: 'codex.fileChange',
        arguments: JSON.stringify(item.changes ?? []),
        result: completed ? String(item.status ?? 'completed') : '',
        error: item.status === 'failed',
      }
    }
    if (kind === 'mcpToolCall') {
      const server = text(item.server) ?? 'mcp'
      const tool = text(item.tool) ?? 'tool'
      return {
        name: `${server}.${tool}`,
        arguments: JSON.stringify(item.arguments ?? {}),
        result: completed ? JSON.stringify(item.result ?? item.error ?? null) : '',
        error: item.error !== undefined || item.status === 'failed',
      }
    }
    if (kind === 'dynamicToolCall') {
      return {
        name: text(item.tool) ?? 'codex.dynamicTool',
        arguments: JSON.stringify(item.arguments ?? {}),
        result: completed ? JSON.stringify(item.content ?? item.error ?? null) : '',
        error: item.error !== undefined || item.status === 'failed',
      }
    }
    return undefined
  }

  private completeTurn(session: NativeSession, active: ActiveTurn, turn: Record<string, unknown> | undefined): void {
    if (active.terminal) return
    active.terminal = true
    const status = text(turn?.status)
    const error = object(turn?.error)
    const reason = status === 'completed'
      ? { kind: 'completed' as const }
      : status === 'interrupted'
      ? { kind: 'interrupted' as const }
      : {
        kind: 'error' as const,
        error: {
          message: text(error?.message) ?? 'Codex Desktop turn failed',
          code: text(error?.code) ?? status ?? 'turn-failed',
        },
      }
    this.emit({ sessionId: session.sessionId, type: 'step/end', data: { turn: active.ordinal, step: 1 } })
    this.emit({ sessionId: session.sessionId, type: 'turn/end', data: { turn: active.ordinal, reason } })
    if (session.active === active) delete session.active
    void this.dispatchNext(session)
  }

  private async dispatchNext(session: NativeSession): Promise<void> {
    const next = session.queue.shift()
    if (next === undefined) {
      this.emitStatus({ sessionId: session.sessionId, status: 'idle' })
      return
    }
    const result = next.target === 'next-step' && next.wakeup === false
      ? await this.inject(session, next.message)
      : await this.startTurn(session, next.message)
    if (result !== 'accepted') {
      this.emitStatus({ sessionId: session.sessionId, status: 'idle' })
    }
  }

  private receiveServerRequest(event: MessageEvent<unknown>, request: Record<string, unknown> | undefined): void {
    const method = text(request?.method)
    const requestId = text(request?.id)
    const params = object(request?.params)
    const threadId = text(params?.threadId)
    const session = threadId === undefined ? undefined : this.byThread.get(threadId)
    if (
      method === undefined || requestId === undefined || params === undefined || session === undefined
      || !this.isApprovalMethod(method)
    ) return
    event.stopImmediatePropagation()
    event.preventDefault()
    void this.answerNativeApproval(requestId, method, params, session)
  }

  private async answerNativeApproval(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
    session: NativeSession,
  ): Promise<void> {
    const itemId = text(params.itemId)
    const toolName = method.includes('commandExecution') || method === 'execCommandApproval'
      ? 'codex.commandExecution'
      : method.includes('fileChange') || method === 'applyPatchApproval'
      ? 'codex.fileChange'
      : method.includes('permissions')
      ? 'codex.permissions'
      : 'codex.approval'
    let outcome: ApprovalOutcome = 'unavailable'
    const request: CordisXDriverApprovalRequest = {
      sessionId: session.sessionId,
      toolName,
      ...(itemId === undefined ? {} : { callId: itemId }),
      ...(text(params.reason) === undefined ? {} : { reason: text(params.reason)! }),
    }
    for (const listener of this.approvalListeners) {
      try {
        outcome = await listener(clone(request))
      } catch {
        outcome = 'unavailable'
      }
      break
    }
    const decision = outcome === 'allowed-once' ? 'accept' : outcome === 'cancelled' ? 'cancel' : 'decline'
    try {
      await this.bridge.sendMessageFromView({
        type: 'mcp-response',
        hostId: this.pin.hostId,
        requestMethod: method,
        response: { id: requestId, result: { decision } },
      })
    } catch {
      // The Session authority already records fail-closed unavailable/denied.
    }
  }

  private isApprovalMethod(method: string): boolean {
    return method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval'
      || method === 'item/permissions/requestApproval'
      || method === 'execCommandApproval'
      || method === 'applyPatchApproval'
  }

  private emit(event: CordisXDriverSessionEvent): void {
    for (const listener of [...this.eventListeners]) listener(clone(event))
  }
  private emitStatus(event: CordisXDriverAgentStatus): void {
    const session = this.sessions.get(event.sessionId)
    if (session !== undefined) {
      if (session.status === event.status) return
      session.status = event.status
    }
    for (const listener of [...this.statusListeners]) listener(clone(event))
  }
}

export class UnavailableAgentSessionTransport implements CordisXPrivateAgentDriver {
  async create(): Promise<{ readonly status: 'unavailable'; readonly code: 'host-unavailable' }> {
    return { status: 'unavailable', code: 'host-unavailable' }
  }
  async resume(): Promise<{ readonly status: 'unavailable'; readonly code: 'host-unavailable' }> {
    return { status: 'unavailable', code: 'host-unavailable' }
  }
  async submit(): Promise<'unavailable'> {
    return 'unavailable'
  }
  async discard(): Promise<'unavailable'> {
    return 'unavailable'
  }
  async cancel(): Promise<'unavailable'> {
    return 'unavailable'
  }
  onReplacement(): () => void {
    return () => {}
  }
  dispose(): void {}
}
