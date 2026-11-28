import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'

/** This renderer client can invoke only the launcher allowlist and receives only the redacted result projection. */
export interface ChannelManagerActionsApi {
  /** Only a current redacted snapshot can be requested through this bridge. */
  readonly snapshotOnly?: true
  /** A coordinated configuration facade may additionally toggle an existing connection. */
  readonly connectionControl?: 'enable-disable'
  /** The same owner can coordinate a reconnect for an enabled connection. */
  readonly connectionReconnect?: true
  run(
    action:
      | 'enable'
      | 'disable'
      | 'reconnect'
      | 'archive'
      | 'restore'
      | 'unbind'
      | 'snapshot'
      | 'policy'
      | 'policy-set'
      | 'continuation-defaults'
      | 'continuation-defaults-set'
      | 'execution-defaults'
      | 'execution-defaults-set'
      | 'channel-execution-defaults'
      | 'channel-execution-defaults-set'
      | 'execution-settings'
      | 'execution-settings-set'
      | 'model-list'
      | 'task-config'
      | 'task-config-set'
      | 'task-settings'
      | 'task-settings-set'
      | 'binding-labels'
      | 'conversation-page'
      | 'conversation-detail'
      | 'conversation-activity'
      | 'conversation-bindings'
      | 'binding-navigation',
    input: Record<string, unknown>,
  ): Promise<ChannelManagerActionResult>
}

/** A read-only transport cannot be used for any action other than snapshot. */
export function restrictChannelManagerActions(
  actions: ChannelManagerActionsApi | undefined,
  snapshotOnly = false,
  allowConnectionControl = false,
  allowConnectionReconnect = false,
) {
  if (!actions || !snapshotOnly && actions.snapshotOnly !== true) return actions
  const control = allowConnectionControl && actions.connectionControl === 'enable-disable'
  const reconnect = control && allowConnectionReconnect && actions.connectionReconnect === true
  return {
    snapshotOnly: true as const,
    ...(control ? { connectionControl: 'enable-disable' as const } : {}),
    ...(reconnect ? { connectionReconnect: true as const } : {}),
    run: async (action, request) =>
      action === 'snapshot' && Object.keys(request).length === 0
        || control && (action === 'enable' || action === 'disable')
        || reconnect && action === 'reconnect'
        ? await actions.run(action, request)
        : { status: 'unavailable' as const, code: 'CHANNEL_READ_ONLY' },
  } satisfies ChannelManagerActionsApi
}
