import type { StandalonePermissionSigner } from '../independent-manager/standalone-permission-signer.js'

const REQUEST = '__cordisxPermissionOnceRequestV1'
const RECEIVE = '__cordisxPermissionOnceReceiveV1'

declare global {
  var __cordisxPermissionOnceRequestV1: ((payload: string) => void) | undefined
  var __cordisxPermissionOnceReceiveV1: ((payload: string) => void) | undefined
}

/** A one-time decision must be accepted and attributed by the current owner before use. */
export class BrowserPermissionOnceBinding {
  private readonly pending = new Map<
    string,
    { resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private closed = false
  private constructor(private readonly token: string, private readonly binding: (payload: string) => void) {
    globalThis[RECEIVE] = this.receive
  }

  static connect(token: string | undefined): BrowserPermissionOnceBinding | undefined {
    const binding = globalThis[REQUEST]
    if (!token || typeof binding !== 'function' || globalThis[RECEIVE] !== undefined) return undefined
    return new BrowserPermissionOnceBinding(token, binding)
  }

  async authorize(
    signer: StandalonePermissionSigner,
    review: Parameters<StandalonePermissionSigner['signOnce']>[1],
    plan: Parameters<StandalonePermissionSigner['signOnce']>[2],
    decision: Parameters<StandalonePermissionSigner['signOnce']>[3],
  ): Promise<boolean> {
    if (this.closed) return false
    const requestId = globalThis.crypto.randomUUID()
    const signed = await signer.signOnce(requestId, review, plan, decision)
    return await this.submit(requestId, signed)
  }

  async authorizeRuntime(
    signer: StandalonePermissionSigner,
    plan: Parameters<StandalonePermissionSigner['signRuntimeOnce']>[1],
    decision: Parameters<StandalonePermissionSigner['signRuntimeOnce']>[2],
  ): Promise<boolean> {
    if (this.closed) return false
    const requestId = globalThis.crypto.randomUUID()
    const signed = await signer.signRuntimeOnce(requestId, plan, decision)
    return await this.submit(requestId, signed)
  }

  async authorizeWebRuntime(
    signer: StandalonePermissionSigner,
    artifact: Parameters<StandalonePermissionSigner['signWebRuntimeOnce']>[1],
    plan: Parameters<StandalonePermissionSigner['signWebRuntimeOnce']>[2],
    decision: Parameters<StandalonePermissionSigner['signWebRuntimeOnce']>[3],
  ): Promise<boolean> {
    if (this.closed) return false
    const requestId = globalThis.crypto.randomUUID()
    const signed = await signer.signWebRuntimeOnce(requestId, artifact, plan, decision)
    return await this.submit(requestId, signed)
  }

  private async submit(requestId: string, signed: {
    readonly record: unknown
    readonly decision: 'allow-once' | 'deny-once'
    readonly proof: unknown
  }): Promise<boolean> {
    if (this.closed) return false
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(false)
      }, 15_000)
      this.pending.set(requestId, { resolve, timer })
      try {
        this.binding(JSON.stringify({ requestId, token: this.token, ...signed }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(false)
      }
    })
  }

  private readonly receive = (payload: string): void => {
    try {
      const response = JSON.parse(payload) as { requestId?: unknown; ok?: unknown; value?: unknown }
      if (typeof response.requestId !== 'string') return
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      clearTimeout(pending.timer)
      pending.resolve(response.ok === true && response.value === true)
    } catch { /* An invalid response cannot authorize a grant. */ }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[RECEIVE] === this.receive) globalThis[RECEIVE] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.pending.clear()
  }
}
