import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'

const BINDING = '__cordisxChannelActionsRequestV1'
const RECEIVER = '__cordisxChannelActionsReceiveV1'

declare global {
  // eslint-disable-next-line no-var
  var __cordisxChannelActionsRequestV1: ((payload: string) => void) | undefined
  // eslint-disable-next-line no-var
  var __cordisxChannelActionsReceiveV1: ((payload: string) => void) | undefined
}

/** Token-bound browser client for the narrow launcher-owned Channel action API. */
export class BrowserChannelActionsBridge {
  private readonly pending = new Map<string, {
    readonly resolve: (value: ChannelManagerActionResult) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()

  private constructor(private readonly token: string) {
    globalThis[RECEIVER] = payload => {
      let value: { requestId?: unknown; ok?: unknown; value?: unknown }
      try { value = JSON.parse(payload) as typeof value } catch { return }
      if (typeof value.requestId !== 'string') return
      const pending = this.pending.get(value.requestId)
      if (pending === undefined) return
      this.pending.delete(value.requestId)
      clearTimeout(pending.timer)
      if (value.ok === true && value.value !== undefined) pending.resolve(value.value as ChannelManagerActionResult)
      else pending.reject(new Error('channel-action-unavailable'))
    }
  }

  static connect(token: string): BrowserChannelActionsBridge { return new BrowserChannelActionsBridge(token) }

  async run(action: string, input: Record<string, unknown>): Promise<ChannelManagerActionResult> {
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function') throw new Error('channel-action-unavailable')
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return await new Promise<ChannelManagerActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('channel-action-timeout'))
      }, 5_000)
      this.pending.set(requestId, { resolve, reject, timer })
      binding(JSON.stringify({ version: 1, token: this.token, requestId, action, ...input }))
    })
  }
}
