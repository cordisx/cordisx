import { fenceManagerOrigin, type ManagerOriginFence } from './manager-origin-fence.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import { createManagerRendererPermissionChannel } from './manager-renderer-permission.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { ServiceRendererPermissionConsumerFence } from './service-renderer-permission-handoff.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { ServiceRendererPermissionEvidence } from './service-renderer-permission-access.js'

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
  readonly reserveOtherConsumers: (
    origin: ManagerOriginFence,
    evidence: ServiceRendererPermissionEvidence,
  ) => Promise<ServiceRendererPermissionConsumerFence>
}) {
  return createManagerRendererPermissionChannel({
    profileId: input.profileId,
    configPath: input.configPath,
    identityAllowed: (identity, context) => {
      try {
        const evidence = input.bootstrap.permissionAccess.evidence(context, identity.id)
        return evidence.identity.id === identity.id && evidence.identity.source === identity.source
      } catch {
        return false
      }
    },
    identityProjection: {
      resolve: (records, context) => input.bootstrap.permissionAccess.resolve(records, context),
      project: (records, context, target) => input.bootstrap.permissionAccess.project(records, context, target.id),
    },
    authority: {
      isAdmitted: context => {
        try {
          return context.admitted === true && !context.signal.aborted
            && input.bootstrap.permissionAccess.snapshot(context) !== undefined
        } catch {
          return false
        }
      },
      snapshot: context => input.bootstrap.permissionAccess.snapshot(context),
      authorize: (context, request, expected, proof) => {
        try {
          const targetId = request.records[0]?.key.identity.pluginId
          if (!targetId) return false
          const evidence = input.bootstrap.permissionAccess.evidence(context, targetId)
          if (
            request.records.some(record =>
              record.key.identity.source !== evidence.ownerIdentity.source
              || record.key.identity.pluginId !== evidence.ownerIdentity.id
            )
          ) return false
          return input.proof.authorize({
            context,
            requestId: request.requestId,
            // The decision was signed in the renderer's alias, never the private source.
            records: input.bootstrap.permissionAccess.project(request.records, context, targetId),
            expected: input.bootstrap.permissionAccess.project(expected, context, targetId),
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
          const targetId = request.records[0]?.key.identity.pluginId
          if (!targetId) throw new Error('renderer-permission-consumers-unavailable')
          const evidence = input.bootstrap.permissionAccess.evidence(context, targetId)
          if (
            !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
            || request.records.some(record =>
              record.key.identity.pluginId !== evidence.ownerIdentity.id
              || record.key.identity.source !== evidence.ownerIdentity.source
            )
          ) throw new Error('renderer-permission-consumers-unavailable')
          consumers = await input.reserveOtherConsumers(origin, evidence)
          if (!origin.isCurrent() || !consumers.isCurrent()) {
            throw new Error('renderer-permission-consumers-unavailable')
          }
          return await input.bootstrap.permissionAccess.reserve(
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
