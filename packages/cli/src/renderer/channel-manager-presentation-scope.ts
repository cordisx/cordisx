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

export function channelOwnerSupportsControl(state: ReturnType<typeof stateFor>): boolean {
  return state.configurationOnly && !state.connectionControlUncertain
    && state.projection.service.writable && state.projection.service.connectionControl === 'enable-disable'
    && state.actions?.connectionControl === 'enable-disable'
}

export function channelOwnerSupportsReconnect(state: ReturnType<typeof stateFor>): boolean {
  return channelOwnerSupportsControl(state) && state.projection.service.connectionReconnect === true
    && state.actions?.connectionReconnect === true
}

export function channelConnectionControlAllowed(service: object): boolean {
  return serviceOwnerFor(service)?.scope === 'configuration' && channelOwnerSupportsControl(stateFor(service))
}

export function channelConnectionReconnectAllowed(service: object): boolean {
  return serviceOwnerFor(service)?.scope === 'configuration' && channelOwnerSupportsReconnect(stateFor(service))
}

/** Credential creation requires the owner-bound configuration facade and private bridge. */
export function channelCredentialCreationAllowed(service: object): boolean {
  const state = stateFor(service)
  return state.configurationOnly && channelConfigurationAllowed(service)
    && state.projection.service.writable && state.credentials !== undefined
}

/** Pending resolution also needs the owner-projected configuration and private credential bridge. */
export function channelPendingTenantResolutionAllowed(service: object): boolean {
  const state = stateFor(service)
  return channelCredentialCreationAllowed(service) && state.serviceConfig !== undefined
    && state.projection.service.pendingTenantResolution === true
}

export function channelSnapshotOperationAllowed(
  service: object,
  operation: ChannelManagerRequestV2['operation'],
): boolean {
  return !stateFor(service).snapshotOnly || operation === 'connection.update' && channelConfigurationAllowed(service)
    || (operation === 'credential.capture' || operation === 'connection.create')
      && channelCredentialCreationAllowed(service)
    || (operation === 'connection.enable' || operation === 'connection.disable')
      && channelConnectionControlAllowed(service)
    || operation === 'connection.reconnect' && channelConnectionReconnectAllowed(service)
}

export function channelPresentationSnapshot<T extends ChannelManagerSnapshotV3 | ChannelManagerSnapshotV4>(
  service: object,
  snapshot: T,
): T {
  if (!stateFor(service).configurationOnly) return snapshot
  const configurationAllowed = channelConfigurationAllowed(service)
  const creationAllowed = channelCredentialCreationAllowed(service)
  const connectionControlAllowed = channelConnectionControlAllowed(service)
  const connectionReconnectAllowed = channelConnectionReconnectAllowed(service)
  return Object.freeze({
    ...snapshot,
    availableOperations: Object.freeze(snapshot.availableOperations.filter(operation =>
      creationAllowed && [
        'target.credential.capture.create',
        'credential.capture',
        'target.connection.create',
        'connection.create',
      ].includes(operation)
    )),
    accounts: Object.freeze(snapshot.accounts.map(account =>
      Object.freeze({
        ...account,
        availableOperations: Object.freeze(
          account.availableOperations.filter(operation =>
            operation !== 'target.credential.capture.rotate' && operation !== 'connection.rotate-credential'
            && (configurationAllowed || operation !== 'connection.update')
            && (connectionControlAllowed || operation !== 'connection.enable' && operation !== 'connection.disable')
            && (connectionReconnectAllowed || operation !== 'connection.reconnect')
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
