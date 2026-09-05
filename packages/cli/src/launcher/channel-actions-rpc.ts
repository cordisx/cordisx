import type { ChannelManagerActionResult, ChannelManagerApi } from './channel-manager-api.js'

export const CHANNEL_ACTIONS_BINDING = '__cordisxChannelActionsRequestV1'
export const CHANNEL_ACTIONS_RECEIVER = '__cordisxChannelActionsReceiveV1'

export interface ChannelActionsBridgeHandler {
  readonly token: string
  handle(value: unknown): Promise<ChannelManagerActionResult>
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid channel action')
  return value as Record<string, unknown>
}
/** Token-bound narrow proxy for the formal launcher action API. */
export function createChannelActionsBridgeHandler(
  input: { readonly token: string; readonly api: ChannelManagerApi },
): ChannelActionsBridgeHandler {
  return {
    token: input.token,
    async handle(value) {
      const request = record(value)
      if (request.version !== 1 || request.token !== input.token) throw new Error('unauthorized channel action')
      const action = request.action
      const generation = typeof request.generation === 'string' ? request.generation : undefined
      if (typeof action !== 'string') throw new Error('invalid channel action')
      if (['enable', 'disable', 'reconnect'].includes(action)) {
        const ref = record(request.ref)
        const inputValue = {
          ref: { adapterId: String(ref.adapterId), accountId: String(ref.accountId), tenantId: String(ref.tenantId) },
          ...(generation === undefined ? {} : { generation }),
        }
        return await input.api.connections[action as 'enable' | 'disable' | 'reconnect'](inputValue)
      }
      if (['archive', 'restore', 'unbind'].includes(action) && typeof request.bindingId === 'string') {
        return await input.api.bindings[action as 'archive' | 'restore' | 'unbind']({
          bindingId: request.bindingId,
          ...(generation === undefined ? {} : { generation }),
        })
      }
      throw new Error('invalid channel action')
    },
  }
}
