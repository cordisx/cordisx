import type { ChannelManagerActionResult, ChannelManagerApi } from './channel-manager-api.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'

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
  input: {
    readonly token: string
    readonly api: ChannelManagerApi
    readonly conversations?: import('./channel-conversation-management.js').ChannelConversationManagement
    readonly consumer?: Pick<
      ChannelConversationConsumer,
      'policy' | 'policySet' | 'executionOperation' | 'bindingLabels' | 'taskSettings'
    >
    readonly execution?: (
      operation: string,
      args: Record<string, unknown>,
    ) => Promise<{ status: string; code?: string }>
  },
): ChannelActionsBridgeHandler {
  return {
    token: input.token,
    async handle(value) {
      const request = record(value)
      if (request.version !== 1 || request.token !== input.token) throw new Error('unauthorized channel action')
      const action = request.action
      const generation = typeof request.generation === 'string' ? request.generation : undefined
      if (typeof action !== 'string') throw new Error('invalid channel action')
      if (['model-list', 'task-config', 'task-config-set', 'task-settings', 'task-settings-set'].includes(action)) {
        if (!input.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        const { version: _version, token: _token, requestId: _id, action: _action, generation: _generation, ...args } =
          request
        try {
          const value = await input.consumer.taskSettings.call(action, args) as { status: string; code?: string }
          return value.status === 'ok'
            ? { status: 'applied', task: value }
            : { status: 'unavailable', code: value.code ?? 'TASK_SETTINGS_UNAVAILABLE' }
        } catch (error) {
          return {
            status: 'unavailable',
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'TASK_SETTINGS_UNAVAILABLE',
          }
        }
      }
      if (
        [
          'conversation-page',
          'conversation-detail',
          'conversation-activity',
          'conversation-bindings',
          'binding-navigation',
        ].includes(action)
      ) {
        if (!input.conversations) return { status: 'unavailable', code: 'CHANNEL_CONVERSATIONS_UNAVAILABLE' }
        const { version: _version, token: _token, requestId: _id, action: _action, ...args } = request
        try {
          return { status: 'applied', ...await input.conversations.read(action, args) }
        } catch (error) {
          return {
            status: 'unavailable',
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'CHANNEL_CONVERSATIONS_UNAVAILABLE',
          }
        }
      }
      if (
        [
          'execution-defaults',
          'execution-defaults-set',
          'execution-settings',
          'execution-settings-set',
          'binding-labels',
        ].includes(action)
      ) {
        if (
          action === 'binding-labels' && !input.consumer
          || action !== 'binding-labels' && !input.consumer && !input.execution
        ) return { status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
        try {
          if (action === 'binding-labels') {
            return { status: 'applied', bindingLabels: await input.consumer!.bindingLabels() }
          }
          const { version: _version, token: _token, requestId: _id, action: _action, ...args } = request
          const value =
            await (input.execution ? input.execution(action, args) : input.consumer!.executionOperation(action, args))
          return value.status === 'ok'
            ? { status: 'applied', execution: value }
            : { status: 'unavailable', code: value.code ?? 'EXECUTION_SETTINGS_UNAVAILABLE' }
        } catch (error) {
          return {
            status: 'unavailable',
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'EXECUTION_SETTINGS_UNAVAILABLE',
          }
        }
      }
      if (action === 'policy') {
        return input.consumer === undefined
          ? { status: 'unavailable' }
          : { status: 'applied', conversationPolicy: input.consumer.policy() }
      }
      if (action === 'policy-set') {
        if (!input.consumer || !Number.isSafeInteger(request.expectedRevision)) return { status: 'unavailable' }
        try {
          return {
            status: 'applied',
            conversationPolicy: await input.consumer.policySet(request.policy, Number(request.expectedRevision)),
          }
        } catch (error) {
          return {
            status: 'unavailable',
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'POLICY_CONFIGURATION_FAILED',
          }
        }
      }
      if (action === 'snapshot') {
        const projection = input.api.snapshot()
        return projection === undefined ? { status: 'unavailable' } : { status: 'applied', projection }
      }
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
