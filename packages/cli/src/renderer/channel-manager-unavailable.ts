import type { ChannelManagerState } from './channel-manager-state.js'
import { normalizeProjection, withRuntimeProjection } from './channel-manager-projection.js'
import type { ChannelManagerRuntimeProjection } from '../launcher/channel-manager-api.js'

/** A failed status read cannot continue to display an old connection as live. */
export function markChannelSnapshotUnavailable(state: ChannelManagerState): boolean {
  if (
    state.runtimeProjection === undefined && state.projection.accounts.every(account => (
      account.connectionState === 'unavailable'
    ))
  ) return false
  const observedAt = state.runtimeProjection?.observedAt ?? state.projection.observedAt
  state.projection = normalizeProjection({
    ...state.projection,
    ...(observedAt === undefined ? {} : { observedAt }),
    accounts: state.projection.accounts.map(account => ({ ...account, connectionState: 'unavailable' })),
  })
  delete state.runtimeProjection
  state.cachedProjection = undefined
  state.publicController?.invalidate()
  return true
}

export function adoptChannelSnapshot(
  state: ChannelManagerState,
  projection: ChannelManagerRuntimeProjection,
  changed: () => void,
): void {
  try {
    withRuntimeProjection(state.projection, projection)
  } catch (error) {
    if (state.snapshotOnly && markChannelSnapshotUnavailable(state)) changed()
    throw error
  }
  state.runtimeProjection = projection
}

/** Sequence-fence an async read so an old failure cannot mask a newer success. */
export async function readChannelSnapshot(
  state: ChannelManagerState,
  signal: AbortSignal,
  changed: () => void,
): Promise<{ readonly projection: ChannelManagerRuntimeProjection; readonly sequence: number } | undefined> {
  if (state.actions === undefined || state.disposed || !state.isCurrent()) return undefined
  const sequence = ++state.refreshSequence
  const live = () => !signal.aborted && !state.disposed && state.isCurrent() && state.refreshSequence === sequence
  try {
    const result = await state.actions.run('snapshot', {})
    if (!live()) return undefined
    if (result.projection !== undefined && (!state.snapshotOnly || result.status === 'applied')) {
      return { projection: result.projection, sequence }
    }
    if (state.snapshotOnly && markChannelSnapshotUnavailable(state)) changed()
    return undefined
  } catch (error) {
    if (live() && state.snapshotOnly && markChannelSnapshotUnavailable(state)) changed()
    throw error
  }
}
