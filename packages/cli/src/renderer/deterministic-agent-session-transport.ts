import type { AgentOptions } from '@cordisx/protocol/agents/v1'
import type { AgentCancelCause, ApprovalOutcome, MessageId, UserMessage } from '@cordisx/protocol/sessions/v1'
import type {
  CordisXDriverApprovalRequest,
  CordisXDriverAgentStatus,
  CordisXDriverMessageClaimed,
  CordisXDriverSessionEvent,
  CordisXPrivateAgentDriver,
} from './agent-session-runtime.js'

const clone = <Value>(value: Value): Value => structuredClone(value)

interface PlaygroundRun {
  readonly turn: number
  readonly message: UserMessage
  cancelled: boolean
}

/**
 * Explicit development-only deterministic transport. It has no network, Codex
 * provider, App Server, preload bridge, or persistence. The enclosing Host
 * Session authority appends every emitted event and owns replay/live delivery.
 */
export class DeterministicAgentSessionTransport implements CordisXPrivateAgentDriver {
  private readonly sessions = new Map<string, { nextTurn: number; active?: PlaygroundRun; queue: UserMessage[] }>()
  private readonly replacements = new Set<() => void>()
  private readonly eventListeners = new Set<(event: CordisXDriverSessionEvent) => void>()
  private readonly approvalListeners = new Set<(request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>>()
  private readonly statusListeners = new Set<(event: CordisXDriverAgentStatus) => void>()
  private readonly claimedListeners = new Set<(event: CordisXDriverMessageClaimed) => void>()
  private disposed = false

  async create(input: { readonly sessionId: string; readonly options: AgentOptions }): Promise<{ readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } }> {
    if (this.disposed || this.sessions.has(input.sessionId)) throw new Error('Playground Agent Session creation is unavailable')
    this.sessions.set(input.sessionId, { nextTurn: 0, queue: [] })
    return { status: 'accepted', detail: { kind: 'host', ref: `deterministic-agent-session:${input.sessionId}` } }
  }

  async resume(input: { readonly sessionId: string }): Promise<{ readonly status: 'accepted'; readonly detail: { readonly kind: 'host'; readonly ref: string } } | { readonly status: 'unavailable'; readonly code: 'unsupported' }> {
    if (this.disposed) return { status: 'unavailable', code: 'unsupported' }
    if (!this.sessions.has(input.sessionId)) this.sessions.set(input.sessionId, { nextTurn: 0, queue: [] })
    return { status: 'accepted', detail: { kind: 'host', ref: `deterministic-agent-session:${input.sessionId}` } }
  }

  async submit(input: { readonly sessionId: string; readonly message: UserMessage }): Promise<'accepted' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'unavailable'
    if (session.active !== undefined) {
      session.queue.push(clone(input.message))
      return 'accepted'
    }
    const run: PlaygroundRun = { turn: ++session.nextTurn, message: clone(input.message), cancelled: false }
    session.active = run
    this.emitStatus({ sessionId: input.sessionId, status: 'running' })
    setTimeout(() => this.emitClaimed({ sessionId: input.sessionId, messageId: input.message.id, turn: run.turn }), 0)
    const text = input.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    // Defer past the admission continuation so the Host appends the user
    // message before any fixture turn/assistant fact is observed.
    if (!text.includes('[pending]')) setTimeout(() => { void this.complete(input.sessionId, run, input.message) }, 0)
    return 'accepted'
  }

  async discard(input: { readonly sessionId: string; readonly messageId: MessageId }): Promise<'accepted' | 'not-found' | 'already-claimed'> {
    const session = this.sessions.get(input.sessionId)
    if (this.disposed || session === undefined) return 'not-found'
    const index = session.queue.findIndex(message => message.id === input.messageId)
    if (session.active?.message.id === input.messageId) return 'already-claimed'
    if (index < 0) return 'not-found'
    session.queue.splice(index, 1)
    return 'accepted'
  }

  async cancel(input: { readonly sessionId: string; readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted' | 'unavailable'> {
    const session = this.sessions.get(input.sessionId)
    const active = session?.active
    if (this.disposed || session === undefined || active === undefined) return 'unavailable'
    active.cancelled = true
    this.emit({ sessionId: input.sessionId, type: 'turn/end', data: { turn: active.turn, reason: { kind: 'interrupted' } } })
    delete session.active
    if (!input.keepInbox) session.queue.splice(0)
    this.emitStatus({ sessionId: input.sessionId, status: 'idle' })
    return 'accepted'
  }

  onSessionEvent(listener: (event: CordisXDriverSessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onApprovalRequest(listener: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  onAgentStatus(listener: (event: CordisXDriverAgentStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onMessageClaimed(listener: (event: CordisXDriverMessageClaimed) => void): () => void {
    this.claimedListeners.add(listener)
    return () => this.claimedListeners.delete(listener)
  }

  onReplacement(listener: () => void): () => void { this.replacements.add(listener); return () => this.replacements.delete(listener) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sessions.clear(); this.replacements.clear(); this.eventListeners.clear(); this.approvalListeners.clear(); this.statusListeners.clear(); this.claimedListeners.clear()
  }

  private async complete(sessionId: string, run: PlaygroundRun, message: UserMessage): Promise<void> {
    if (this.disposed || run.cancelled || this.sessions.get(sessionId)?.active !== run) return
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    this.emit({ sessionId, type: 'turn/start', data: { turn: run.turn } })
    this.emit({ sessionId, type: 'step/start', data: { turn: run.turn, step: 1 } })
    let approval: ApprovalOutcome | undefined
    if (text.includes('[approval]')) approval = await this.ask({ sessionId, toolName: 'playground.fixture', reason: 'deterministic fixture approval' })
    if (this.disposed || run.cancelled || this.sessions.get(sessionId)?.active !== run) return
    if (text.includes('[tool]')) {
      const callId = `playground-tool:${sessionId}:${run.turn}`
      this.emit({ sessionId, type: 'tool/call', data: { turn: run.turn, step: 1, callId, name: 'playground.fixture.echo', arguments: JSON.stringify({ fixture: true, text }) } })
      this.emit({ sessionId, type: 'tool/result', data: {
        turn: run.turn, step: 1,
        message: { id: `playground-tool-result:${sessionId}:${run.turn}`, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'deterministic playground tool result' }] }], source: { kind: 'tool', callId } },
        meta: { fixture: 'deterministic-agent-session', deterministic: true },
      } })
    }
    const response = approval === undefined
      ? `Playground Agent/Session fixture reply: ${text || 'empty message'}`
      : `Playground Agent/Session fixture approval: ${approval}`
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'text-delta', index: 0, text: response } } })
    const block = { type: 'text' as const, text: response }
    this.emit({ sessionId, type: 'assistant/chunk', data: { turn: run.turn, step: 1, chunk: { type: 'block-end', index: 0, block } } })
    this.emit({ sessionId, type: 'assistant/message', data: {
      turn: run.turn, step: 1,
      message: { id: `deterministic-assistant:${sessionId}:${run.turn}`, role: 'assistant', content: [block], source: { kind: 'model', provider: 'deterministic-agent-session', model: 'deterministic-v1', replayState: { fixture: true } } },
    } })
    this.emit({ sessionId, type: 'step/end', data: { turn: run.turn, step: 1 } })
    this.emit({ sessionId, type: 'turn/end', data: { turn: run.turn, reason: { kind: 'completed' } } })
    const session = this.sessions.get(sessionId)
    if (session?.active === run) delete session.active
    const next = session?.queue.shift()
    if (next === undefined) this.emitStatus({ sessionId, status: 'idle' })
    else void this.submit({ sessionId, message: next })
  }

  private async ask(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome> {
    for (const listener of this.approvalListeners) return await listener(clone(request))
    return 'unavailable'
  }

  private emit(event: CordisXDriverSessionEvent): void {
    for (const listener of [...this.eventListeners]) listener(clone(event))
  }

  private emitStatus(event: CordisXDriverAgentStatus): void {
    for (const listener of [...this.statusListeners]) listener(clone(event))
  }

  private emitClaimed(event: CordisXDriverMessageClaimed): void {
    if (this.disposed) return
    for (const listener of [...this.claimedListeners]) listener(clone(event))
  }
}
