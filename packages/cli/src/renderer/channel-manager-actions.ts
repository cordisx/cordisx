import type { ChannelManagerActionsApi } from './channel-manager.js'

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
