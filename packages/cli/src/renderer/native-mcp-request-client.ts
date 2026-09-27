export interface NativeMcpBridge {
  readonly sendMessageFromView?: (value: unknown) => Promise<unknown> | unknown
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const record = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
const string = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= 1_000_000 ? value : undefined
)

export class NativeMcpRequestClient {
  private readonly pending = new Map<string, PendingRequest>()
  private disposed = false

  constructor(private readonly bridge: Required<NativeMcpBridge>, private readonly hostId: string) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error('Native model provider transport unavailable')
    const requestId = `cordisx-native-model-provider:${crypto.randomUUID()}`
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Codex Desktop ${method} timed out`))
      }, 30_000)
      this.pending.set(requestId, { resolve, reject, timer })
    })
    try {
      await this.bridge.sendMessageFromView({
        type: 'mcp-request',
        hostId: this.hostId,
        request: { id: requestId, method, params: structuredClone(params) },
      })
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending !== undefined) {
        this.pending.delete(requestId)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(`Codex Desktop ${method} rejected`))
      }
    }
    return await response
  }

  receive(message: Record<string, unknown> | undefined): boolean {
    const requestId = string(message?.id)
    if (requestId === undefined) return false
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    if (message?.error === undefined) pending.resolve(message?.result)
    else pending.reject(new Error(string(record(message.error)?.message) ?? 'Codex Desktop request failed'))
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Native model provider transport disposed'))
    }
    this.pending.clear()
  }
}
