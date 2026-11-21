import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type { ChannelManagerState } from './channel-manager-state.js'
import { compositeRef, normalizeProjection } from './channel-manager-projection.js'

/** Adopt a committed configuration without changing account identity or runtime state. */
export function adoptChannelConfigurationUpdate(
  state: ChannelManagerState,
  ref: ChannelCredentialRef,
  patch: { displayName?: string; selectors?: readonly string[] },
  revision: number,
): void {
  const key = compositeRef(ref)
  state.projection = normalizeProjection({
    ...state.projection,
    connections: state.projection.connections.map(item =>
      compositeRef(item.ref) === key
        ? { ...item, ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }) }
        : item
    ),
    accounts: state.projection.accounts.map(item =>
      compositeRef(item.ref) === key
        ? { ...item, ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }) }
        : item
    ),
    service: { ...state.projection.service, revision, lastGoodRevision: revision },
  })
  state.publicController!.invalidate()
}
