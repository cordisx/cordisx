import type {
  ChannelManagerRequestV2,
  ChannelManagerResultV2,
  ChannelManagerSnapshotV3,
  ChannelManagerTargetRequestV1,
  ChannelManagerTargetResultV1,
} from '@cordisx/protocol/channel-manager/v2'
import type { ChannelManagerSnapshotV4 } from '@cordisx/protocol/channel-manager/v3'
import { serviceOwnerFor, stateFor } from './channel-manager-state.js'

/** An old read-only facade is never widened when a new configuration facade exists. */
export function channelConfigurationAllowed(service: object): boolean {
  const state = stateFor(service)
  return !state.snapshotOnly || state.configurationOnly && serviceOwnerFor(service)?.scope === 'configuration'
}

export function channelPresentationSnapshot<T extends ChannelManagerSnapshotV3 | ChannelManagerSnapshotV4>(
  service: object,
  snapshot: T,
): T {
  if (!stateFor(service).configurationOnly) return snapshot
  const configurationAllowed = channelConfigurationAllowed(service)
  return Object.freeze({
    ...snapshot,
    accounts: Object.freeze(snapshot.accounts.map(account =>
      Object.freeze({
        ...account,
        availableOperations: Object.freeze(
          account.availableOperations.filter(operation =>
            operation !== 'target.credential.capture.rotate' && operation !== 'connection.rotate-credential'
            && (configurationAllowed || operation !== 'connection.update')
          ),
        ),
      })
    )),
  }) as unknown as T
}

export function unavailableChannelTarget(
  request: ChannelManagerTargetRequestV1,
  revision: number,
): ChannelManagerTargetResultV1 {
  return {
    ...request,
    contract: 'cordisx.channel-manager-target-result/v1',
    schemaVersion: 1,
    revision,
    status: 'rejected',
    code: 'OPERATION_UNAVAILABLE',
  }
}

export function unavailableChannelOperation(
  request: ChannelManagerRequestV2,
  revision: number,
): ChannelManagerResultV2 {
  return {
    ...request,
    contract: 'cordisx.channel-manager-result/v2',
    schemaVersion: 2,
    revision,
    status: 'rejected',
    code: 'OPERATION_UNAVAILABLE',
  }
}
