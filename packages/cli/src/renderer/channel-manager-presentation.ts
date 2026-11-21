import type { ChannelManagerV14 } from '@cordisx/protocol/channel-manager/v14'
import { CordisXChannelManagerService } from './channel-manager.js'
import { stateFor } from './channel-manager-state.js'

/** Experimental local implementation of the proposed owner-bound presentation contract. */
export class CordisXChannelManagerPresentationService extends CordisXChannelManagerService {
  presentationCapabilities() {
    this.assertOwnedRead()
    return Object.freeze({
      contract: 'cordisx.channel-manager-presentation-capabilities/v1' as const,
      schemaVersion: 1 as const,
      mode: stateFor(this).snapshotOnly ? 'snapshot-only' as const : 'standard' as const,
    })
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
