import type { ChannelManagerV14 } from '@cordisx/protocol/channel-manager/v14'
import { CordisXChannelManagerService } from './channel-manager.js'
import { serviceOwnerFor, stateFor } from './channel-manager-state.js'
import { channelConnectionControlAllowed } from './channel-manager-presentation-scope.js'

/** Experimental local implementation of the proposed owner-bound presentation contract. */
export class CordisXChannelManagerPresentationService extends CordisXChannelManagerService {
  presentationCapabilities() {
    this.assertOwnedRead()
    if (serviceOwnerFor(this)?.scope === 'configuration') throw new Error('OPERATION_UNAVAILABLE')
    return Object.freeze({
      contract: 'cordisx.channel-manager-presentation-capabilities/v1' as const,
      schemaVersion: 1 as const,
      mode: stateFor(this).snapshotOnly ? 'snapshot-only' as const : 'standard' as const,
    })
  }

  configurationPresentationCapabilities() {
    this.assertOwnedRead()
    if (!stateFor(this).configurationOnly || serviceOwnerFor(this)?.scope !== 'configuration') {
      throw new Error('OPERATION_UNAVAILABLE')
    }
    return Object.freeze({
      contract: 'cordisx.channel-manager-configuration-presentation-capabilities/v1' as const,
      schemaVersion: 1 as const,
      mode: 'configuration-only' as const,
      ...(channelConnectionControlAllowed(this) ? { connectionControl: 'enable-disable' as const } : {}),
    })
  }

  forOwnConfigurationPresentationService() {
    return this.createOwnService(true) as
      | (ChannelManagerV14 & Pick<CordisXChannelManagerPresentationService, 'configurationPresentationCapabilities'>)
      | undefined
  }

  forOwnPresentationService() {
    return this.forOwnService() as
      | (
        & ChannelManagerV14
        & Pick<
          CordisXChannelManagerPresentationService,
          'presentationCapabilities' | 'forOwnPresentationService'
        >
      )
      | undefined
  }
}
