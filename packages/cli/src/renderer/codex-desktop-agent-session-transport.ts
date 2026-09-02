import type { AgentOptions } from '@cordisx/protocol/agents/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import type { CordisXPrivateAgentDriver } from './agent-session-runtime.js'

/** Exact observed Desktop build; this is a closed Host-only transport pin. */
export const CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN = Object.freeze({
  appVersion: '26.818.61809', buildNumber: '7019', buildFlavor: 'prod', hostId: 'local',
})

interface ElectronBridge {
  readonly sendMessageFromView?: (value: unknown) => Promise<unknown> | unknown
  readonly getSentryInitOptions?: () => Promise<unknown> | unknown
}

interface PendingRequest { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
const clone = <Value>(value: Value): Value => structuredClone(value)
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, maximum = 1_000_000): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
const requestId = () => crypto.randomUUID()

/**
 * Minimal direct driver over the current native `local` connection. It never
 * exports the preload bridge. Native responses are command admission only;
 * absent native replay/status evidence remains absent from the Session log.
 */
export class CodexDesktopAgentSessionTransport implements CordisXPrivateAgentDriver {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly nativeThreads = new Map<string, string>()
  private readonly activeTurns = new Map<string, string>()
  private readonly replacements = new Set<() => void>()
  private disposed = false

  private constructor(private readonly bridge: Required<ElectronBridge>) { window.addEventListener('message', this.receive) }

  static async connect(): Promise<CodexDesktopAgentSessionTransport | undefined> {
    const page = globalThis as typeof globalThis & { readonly electronBridge?: ElectronBridge; readonly codexWindowType?: unknown; readonly location?: Location }
    const bridge = page.electronBridge
    if (page.codexWindowType !== 'electron' || page.location?.href !== 'app://-/index.html'
      || typeof bridge?.sendMessageFromView !== 'function' || typeof bridge.getSentryInitOptions !== 'function') return undefined
    try {
      const options = record(await bridge.getSentryInitOptions())
      if (options?.appVersion !== CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN.appVersion
        || options.buildNumber !== CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN.buildNumber
        || options.buildFlavor !== CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN.buildFlavor) return undefined
      return new CodexDesktopAgentSessionTransport(bridge as Required<ElectronBridge>)
    } catch { return undefined }
  }

  async create(input: { readonly sessionId: string; readonly options: AgentOptions }): Promise<{ readonly status: 'accepted'; readonly detail?: { readonly kind: 'host'; readonly ref: string } } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }> {
    const model = input.options.model ?? await this.defaultModel()
    if (model === undefined) return { status: 'unavailable', code: 'host-unavailable' }
    try {
      const result = record(await this.request('thread/start', { model, cwd: '' }))
      const thread = text(record(result?.thread)?.id)
      if (thread === undefined) return { status: 'unavailable', code: 'host-unavailable' }
      this.nativeThreads.set(input.sessionId, thread)
      return { status: 'accepted', detail: { kind: 'host', ref: `codex-thread:${thread}` } }
    } catch { return { status: 'unavailable', code: 'host-unavailable' } }
  }

  async resume(input: { readonly sessionId: string }): Promise<{ readonly status: 'accepted'; readonly detail?: { readonly kind: 'host'; readonly ref: string } } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }> {
    const threadId = this.nativeThreads.get(input.sessionId)
    if (threadId === undefined) return { status: 'unavailable', code: 'unsupported' }
    try {
      const result = record(await this.request('thread/resume', { threadId }))
      if (text(record(result?.thread)?.id) === undefined) return { status: 'unavailable', code: 'host-unavailable' }
      return { status: 'accepted', detail: { kind: 'host', ref: `codex-thread:${threadId}` } }
    } catch { return { status: 'unavailable', code: 'host-unavailable' } }
  }

  async submit(input: { readonly sessionId: string; readonly message: UserMessage }): Promise<'accepted' | 'unavailable'> {
    const threadId = this.nativeThreads.get(input.sessionId)
    const blocks = input.message.content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text, text_elements: [] }] : [])
    if (threadId === undefined || blocks.length !== input.message.content.length) return 'unavailable'
    try {
      const result = record(await this.request('turn/start', { threadId, input: blocks, clientUserMessageId: input.message.id }))
      const turn = text(record(result?.turn)?.id)
      if (turn === undefined) return 'unavailable'
      this.activeTurns.set(input.sessionId, turn)
      return 'accepted'
    } catch { return 'unavailable' }
  }

  async discard(): Promise<'not-found'> { return 'not-found' }
  async cancel(input: { readonly sessionId: string }): Promise<'accepted' | 'unavailable'> {
    const threadId = this.nativeThreads.get(input.sessionId)
    const turnId = this.activeTurns.get(input.sessionId)
    if (threadId === undefined || turnId === undefined) return 'unavailable'
    try { await this.request('turn/interrupt', { threadId, turnId }); return 'accepted' } catch { return 'unavailable' }
  }
  onReplacement(listener: () => void): () => void { this.replacements.add(listener); return () => this.replacements.delete(listener) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.receive)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex Desktop Agent/Session transport disposed')) }
    this.pending.clear(); this.replacements.clear()
  }

  private async defaultModel(): Promise<string | undefined> {
    try {
      const data = record(await this.request('model/list', { limit: 100, includeHidden: false }))?.data
      if (!Array.isArray(data)) return undefined
      const model = data.find(item => record(item)?.isDefault === true) ?? data[0]
      return text(record(model)?.id) ?? text(record(model)?.modelId)
    } catch { return undefined }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error('Codex Desktop Agent/Session transport unavailable')
    const id = requestId()
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex Desktop request timed out')) }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
    })
    try { await this.bridge.sendMessageFromView({ type: 'mcp-request', hostId: CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN.hostId, request: { id, method, params: clone(params) } }) }
    catch (error) { const pending = this.pending.get(id); if (pending !== undefined) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error instanceof Error ? error : new Error('Codex Desktop request rejected')) } }
    return await response
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (this.disposed || event.source !== window) return
    const envelope = record(event.data)
    if (text(envelope?.hostId) !== CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN.hostId) return
    const type = text(envelope?.type)
    if (type === 'codex-app-server-connection-changed' || type === 'codex-app-server-initialized') {
      for (const callback of [...this.replacements]) callback()
      return
    }
    if (type !== 'mcp-response') return
    const message = record(envelope?.message)
    const id = text(message?.id)
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id); clearTimeout(pending.timer)
    if (message?.error !== undefined) pending.reject(new Error(text(record(message.error)?.message) ?? 'Codex Desktop request failed'))
    else pending.resolve(message?.result)
  }
}

export class UnavailableAgentSessionTransport implements CordisXPrivateAgentDriver {
  async create(): Promise<{ readonly status: 'unavailable'; readonly code: 'host-unavailable' }> { return { status: 'unavailable', code: 'host-unavailable' } }
  async resume(): Promise<{ readonly status: 'unavailable'; readonly code: 'host-unavailable' }> { return { status: 'unavailable', code: 'host-unavailable' } }
  async submit(): Promise<'unavailable'> { return 'unavailable' }
  async discard(): Promise<'unavailable'> { return 'unavailable' }
  async cancel(): Promise<'unavailable'> { return 'unavailable' }
  onReplacement(): () => void { return () => {} }
  dispose(): void {}
}
