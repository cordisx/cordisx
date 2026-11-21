import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { CdpPluginLifecycleRuntime } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import { attachmentHomeDigest } from '../launcher/renderer-lifecycle-peer.js'
import { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { createServiceRendererProjector } from './service-renderer-projection.js'
import { createManagerRendererModelServicesChannel } from './manager-renderer-model-services.js'

/** Compose the optional Manager inside an already-authorized Desktop owner. */
export function createDesktopManagerOwner(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly appId: string
  readonly profileId: string
  readonly generation: string
  readonly cdp: CdpPluginLifecycleRuntime
  readonly artifactServer: PluginGenerationArtifactServer
  readonly store: PluginActivationStore
  /** The Desktop owner's current, revision-checked model-service authority. */
  readonly codex?: (operation: string, request: unknown) => Promise<unknown>
}) {
  const scope = {
    homeDigest: attachmentHomeDigest(input.homeDir),
    ownerAppId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
  }
  const participants = new ServiceRendererParticipants(scope)
  const lifecycle = new DesktopOwnerRendererLifecycle({
    scope,
    cdp: input.cdp,
    artifactServer: input.artifactServer,
    projectManagerMutation: createServiceRendererProjector({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.generation,
      isLive: identity => participants.isLive(identity),
    }),
  })
  participants.bind(lifecycle)
  const unsubscribeNoSeats = input.cdp.onNoReadySessions(() => participants.disconnectAll())
  const participant = {
    create: (request: Parameters<typeof participants.participant.create>[0]) => {
      // No private session may outlive or precede its last admitted Desktop seat.
      lifecycle.snapshot()
      return participants.participant.create(request)
    },
    attach: participants.participant.attach,
  }
  const bootstrap = new ServiceRendererBootstrap({
    homeDir: input.homeDir,
    configPath: input.configPath,
    appId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
    lifecycle,
    participants,
    store: input.store,
  })
  let closed = false
  const rendererModelServices = input.codex === undefined
    ? undefined
    : createManagerRendererModelServicesChannel({
      profileId: input.profileId,
      generation: input.generation,
      isCurrent: context => !closed && participants.peer(context.rendererId) !== undefined,
      call: input.codex,
    })
  return {
    lifecycle,
    managementOptions: {
      rendererParticipant: participant,
      rendererBootstrap: bootstrap.channel(),
      rendererRetirement: (rendererId: string) => bootstrap.waitForRetirement(rendererId),
      rendererWriteLifetimes: bootstrap.writeLifetimes,
      ...(rendererModelServices === undefined ? {} : { rendererModelServices }),
    },
    initialize(active: CordisXPluginActivationRecordV1, recoveryPending: boolean) {
      lifecycle.initialize(active, recoveryPending)
    },
    close() {
      if (closed) return
      closed = true
      unsubscribeNoSeats()
      bootstrap.close()
      participants.close()
      lifecycle.close()
    },
  }
}

/** Preserve the current Desktop path for profiles we cannot safely project yet. */
export async function createDesktopManagerOwnerIfEligible(
  input: Parameters<typeof createDesktopManagerOwner>[0] & {
    readonly ownerVerified: boolean
    readonly attach: boolean
    readonly configuredPluginCount: number
  },
): Promise<ReturnType<typeof createDesktopManagerOwner> | undefined> {
  if (
    !input.ownerVerified || input.attach || input.configuredPluginCount !== 0
    || (await input.store.loadActive()).plugins.length !== 0
  ) return undefined
  return createDesktopManagerOwner(input)
}
