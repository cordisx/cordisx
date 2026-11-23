import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'
import { adoptStandaloneChannelControl } from './channel-manager-owner-update.js'
import {
  channelConnectionControlAllowed,
  channelConnectionReconnectAllowed,
} from './channel-manager-presentation-scope.js'
import { stateFor } from './channel-manager-state.js'
import { markChannelSnapshotUnavailable } from './channel-manager-unavailable.js'
import type { CordisXChannelManagerService } from './channel-manager.js'

/** Apply action results only while the originating owner and its confirmed projection remain current. */
export async function runChannelManagerAction(
  service: CordisXChannelManagerService,
  action: 'enable' | 'disable' | 'reconnect' | 'archive' | 'restore' | 'unbind',
  request: Record<string, unknown>,
  ownedReadAllowed: () => boolean,
  notify: () => void,
): Promise<ChannelManagerActionResult> {
  const state = stateFor(service)
  if (state.actions === undefined) throw new Error('channel-action-unavailable')
  const coordinatedAction = action === 'reconnect'
    ? channelConnectionReconnectAllowed(service) ? action : undefined
    : (action === 'enable' || action === 'disable') && channelConnectionControlAllowed(service)
    ? action
    : undefined
  const controlled = coordinatedAction !== undefined
  const expectedRevision = state.projection.service.revision
  const uncertain = () => {
    state.connectionControlUncertain = true
    markChannelSnapshotUnavailable(state)
    notify()
  }
  state.refreshSequence += 1
  let result: ChannelManagerActionResult
  try {
    result = await state.actions.run(action, controlled ? { ...request, expectedRevision } : request)
  } catch (error) {
    if (controlled) uncertain()
    throw error
  } finally {
    // Reject reads that began during a failed or completed connection operation too.
    state.refreshSequence += 1
  }
  if (controlled) {
    if (result.status === 'unavailable') return result
    if (
      result.status !== 'applied' || state.disposed || !state.isCurrent() || !ownedReadAllowed()
      || !adoptStandaloneChannelControl(
        service,
        result.channelProjection,
        expectedRevision,
        request.ref,
        coordinatedAction!,
      )
    ) {
      uncertain()
      return { status: 'unavailable', code: 'CHANNEL_CONTROL_RESULT_UNKNOWN' }
    }
    return result
  }
  if (state.disposed || !state.isCurrent() || !ownedReadAllowed()) return result
  if (result.projection !== undefined) state.runtimeProjection = result.projection
  state.cachedProjection = undefined
  if (result.status === 'applied') state.publicController!.invalidate()
  notify()
  return result
}
