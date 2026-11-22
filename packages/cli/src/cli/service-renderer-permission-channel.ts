import { fenceManagerOrigin } from './manager-origin-fence.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import { createManagerRendererPermissionChannel } from './manager-renderer-permission.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { ServiceRendererPermissionConsumerFence } from './service-renderer-permission-handoff.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'

/**
 * Compose the owner-verified decision and profile handoff. The caller must
 * supply a real fence for every policy consumer outside the Manager fleet.
 */
export function createServiceRendererPermissionChannel(input: {
  readonly profileId: string
  readonly configPath: string
  readonly bootstrap: ServiceRendererBootstrap
  readonly proof: ManagerPermissionProofAuthority
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ServiceRendererLifecycle
  readonly sessions: () => ManagerRendererSessions
  readonly reserveOtherConsumers: () => Promise<ServiceRendererPermissionConsumerFence>
}) {
  return createManagerRendererPermissionChannel({
    profileId: input.profileId,
    configPath: input.configPath,
    identityAllowed: (identity, context) => {
      try {
        const evidence = input.bootstrap.permissionEvidence(context)
        return evidence.identity.id === identity.id && evidence.identity.source === identity.source
      } catch {
        return false
      }
    },
    identityProjection: {
      resolve: (records, context) => input.bootstrap.resolvePermissionPolicies(records, context),
      project: (records, context) => input.bootstrap.projectPermissionPolicies(records, context),
    },
    authority: {
      isAdmitted: context => {
        try {
          return context.admitted === true && !context.signal.aborted
            && input.bootstrap.permissionEvidence(context) !== undefined
        } catch {
          return false
        }
      },
      snapshot: context => input.bootstrap.permissionSnapshot(context),
      authorize: (context, request, expected, proof) => {
        try {
          const evidence = input.bootstrap.permissionEvidence(context)
          return input.proof.authorize({
            context,
            requestId: request.requestId,
            // The decision was signed in the renderer's alias, never the private source.
            records: input.bootstrap.projectPermissionPolicies(request.records, context),
            expected: input.bootstrap.projectPermissionPolicies(expected, context),
            moduleGeneration: evidence.moduleGeneration,
            artifact: evidence.artifact,
            proof,
          })
        } catch {
          return false
        }
      },
      acquire: async (context, request, expected) => {
        const origin = await fenceManagerOrigin({
          sessions: input.sessions(),
          participants: input.participants,
          lifecycle: input.lifecycle,
          allowAdditionalManagers: true,
        })
        let consumers: ServiceRendererPermissionConsumerFence | undefined
        try {
          consumers = await input.reserveOtherConsumers()
          if (!origin.isCurrent() || !consumers.isCurrent()) {
            throw new Error('renderer-permission-consumers-unavailable')
          }
          return await input.bootstrap.reservePermissionPolicy(
            origin,
            context,
            request.requestId,
            expected,
            request.records,
            consumers,
          )
        } catch (error) {
          try {
            consumers?.fence()
          } catch { /* keep fencing the origin */ }
          try {
            origin.fence()
          } catch { /* the reservation remains unavailable */ }
          throw error
        }
      },
    },
  })
}
