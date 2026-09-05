import type { HostServiceConfigMutation, HostServiceConfigMutationResult } from '../launcher/service-config.js'

const BINDING = '__cordisxChannelCredentialRequestV1'
const RECEIVER = '__cordisxChannelCredentialReceiveV1'
type Binding = (payload: string) => void

declare global {
  // eslint-disable-next-line no-var
  var __cordisxChannelCredentialRequestV1: Binding | undefined
  // eslint-disable-next-line no-var
  var __cordisxChannelCredentialReceiveV1: ((payload: string) => void) | undefined
}

/** Token-bound client for the one-shot private credential+config Host operation. */
export class BrowserChannelCredentialBridge {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: HostServiceConfigMutationResult) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private constructor(private readonly token: string) {
    globalThis[RECEIVER] = this.receive
  }
  static connect(token: string): BrowserChannelCredentialBridge {
    return new BrowserChannelCredentialBridge(token)
  }
  async create(
    input: {
      readonly account: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
      readonly secret: string
      readonly mutation: HostServiceConfigMutation
    },
  ): Promise<HostServiceConfigMutationResult> {
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function') throw new Error('channel-credential-unavailable')
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return await new Promise<HostServiceConfigMutationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('channel-credential-timeout'))
      }, 5_000)
      this.pending.set(requestId, { resolve, reject, timer })
      binding(JSON.stringify({ version: 1, token: this.token, requestId, ...input }))
    })
  }
  private readonly receive = (payload: string): void => {
    let response: { requestId?: unknown; ok?: unknown; value?: unknown; code?: unknown }
    try {
      response = JSON.parse(payload) as typeof response
    } catch {
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value as HostServiceConfigMutationResult)
    else pending.reject(new Error(typeof response.code === 'string' ? response.code : 'channel-credential-unavailable'))
  }
}
