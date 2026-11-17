import type { AgentContextBridge } from './agent-context-service.js'

const BINDING = '__cordisxAgentContextRequestV1'
const RECEIVER = '__cordisxAgentContextReceiveV1'
declare global {
  var __cordisxAgentContextRequestV1: ((payload: string) => void) | undefined
  var __cordisxAgentContextReceiveV1: ((payload: string) => void) | undefined
}

/** One token-bound document client; plugin code is never given this client or its handles. */
export class BrowserAgentContextBridge implements AgentContextBridge {
  private readonly pending = new Map<string, {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  private disposed = false
  private readonly receive = (payload: string) => {
    let reply: { requestId?: unknown; ok?: unknown; value?: unknown }
    try {
      reply = JSON.parse(payload) as typeof reply
    } catch {
      return
    }
    if (typeof reply.requestId !== 'string') return
    const pending = this.pending.get(reply.requestId)
    if (!pending) return
    this.pending.delete(reply.requestId)
    clearTimeout(pending.timer)
    if (reply.ok === true && reply.value !== undefined) pending.resolve(reply.value)
    else pending.reject(new Error('agent-context-unavailable'))
  }
  private constructor(private readonly token: string) {
    globalThis[RECEIVER] = this.receive
  }
  static connect(token: string): BrowserAgentContextBridge {
    return new BrowserAgentContextBridge(token)
  }
  private request(method: 'read' | 'open' | 'next' | 'close', input: Record<string, unknown>): Promise<unknown> {
    const binding = globalThis[BINDING]
    if (this.disposed || typeof binding !== 'function') return Promise.reject(new Error('agent-context-unavailable'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('agent-context-timeout'))
      }, 15_000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({ version: 1, token: this.token, requestId, method, ...input }))
      } catch {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new Error('agent-context-unavailable'))
      }
    })
  }
  async read(input: Parameters<AgentContextBridge['read']>[0]): ReturnType<AgentContextBridge['read']> {
    return await this.request('read', input) as Awaited<ReturnType<AgentContextBridge['read']>>
  }
  async open(input: Parameters<AgentContextBridge['open']>[0]): ReturnType<AgentContextBridge['open']> {
    return await this.request('open', input) as Awaited<ReturnType<AgentContextBridge['open']>>
  }
  async next(input: Parameters<AgentContextBridge['next']>[0]): ReturnType<AgentContextBridge['next']> {
    return await this.request('next', input) as Awaited<ReturnType<AgentContextBridge['next']>>
  }
  async close(input: Parameters<AgentContextBridge['close']>[0]): Promise<void> {
    await this.request('close', input)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (globalThis[RECEIVER] === this.receive) globalThis[RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('agent-context-unavailable'))
    }
    this.pending.clear()
  }
}
