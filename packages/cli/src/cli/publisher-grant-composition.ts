import type { HomeConfig } from '../config/home-config.js'
import {
  DirectPublisherGrantAuthority,
  DirectPublisherGrantStore,
  MacOSMachineIdentityProvider,
  StaticPublisherKeyRegistry,
} from '../launcher/publisher-grants.js'
import { createPublisherGrantBridgeHandler } from '../launcher/publisher-grant-rpc.js'

/** Construct the existing publisher-grant bridge from the selected Host configuration. */
export async function createPublisherGrantForHome(
  homeDir: string,
  issuers: HomeConfig['publisherGrantIssuers'],
) {
  return createPublisherGrantBridgeHandler(
    new DirectPublisherGrantAuthority(
      new StaticPublisherKeyRegistry(issuers),
      new MacOSMachineIdentityProvider(),
      await DirectPublisherGrantStore.open(homeDir),
    ),
  )
}
