import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'

/** This renderer client can invoke only the launcher allowlist and receives only the redacted result projection. */
export interface ChannelManagerActionsApi {
  /** Only a current redacted snapshot can be requested through this bridge. */
  readonly snapshotOnly?: true
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
export function restrictChannelManagerActions(actions: ChannelManagerActionsApi | undefined, snapshotOnly = false) {
  if (!actions || !snapshotOnly && actions.snapshotOnly !== true) return actions
  return {
    snapshotOnly: true as const,
    run: async (action, request) =>
      action === 'snapshot' && Object.keys(request).length === 0
        ? await actions.run(action, request)
        : { status: 'unavailable' as const, code: 'CHANNEL_READ_ONLY' },
  } satisfies ChannelManagerActionsApi
}
