import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { isPermissionPolicyRecordV2, persistedPermissionRecordKey } from '../permission-persistence.js'
import { ownerDeclaredRuntimePolicy } from './owner-adapter-runtime-declaration.js'
import { withDeclaredRuntimeAskPolicies } from './permission-decision-history.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { ServiceRendererDocuments } from './service-renderer-documents.js'
import type { startServiceModelApi } from '../launcher/service-model-api.js'

/** A plugin may read only the core catalog covered by its current owner policy or one-use receipt. */
export function createServiceRendererModels(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly documents: ServiceRendererDocuments
  readonly bootstrap: ServiceRendererBootstrap
  readonly catalog: Awaited<ReturnType<typeof startServiceModelApi>>['catalog']
  readonly loadPackage?: typeof loadStagedPluginPackage
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 8 * 1024 || context.admitted !== true) {
        throw new Error('renderer-models-unavailable')
      }
      const raw: unknown = JSON.parse(payload)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('renderer-models-unavailable')
      const request = raw as Record<string, unknown>
      if (
        Object.keys(request).some(key =>
          !['version', 'requestId', 'token', 'authorizationRequestId', 'providerIds'].includes(key)
        )
        || request.version !== 1 || typeof request.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId)
        || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/u.test(request.token)
        || typeof request.authorizationRequestId !== 'string'
        || !/^[A-Za-z0-9-]{1,96}$/u.test(request.authorizationRequestId)
        || request.providerIds !== undefined && (
            !Array.isArray(request.providerIds) || request.providerIds.length > 32
            || request.providerIds.some(id =>
              typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)
            )
            || new Set(request.providerIds).size !== request.providerIds.length
          )
      ) throw new Error('renderer-models-unavailable')
      const requestId = request.requestId
      const authorizationRequestId = request.authorizationRequestId
      const providerIds = (request.providerIds ?? []) as string[]
      const principal = input.documents.principal(context, request.token)
      const evidence = input.bootstrap.permissionAccess.evidence(context, principal.identity.id)
      const snapshot = input.bootstrap.permissionAccess.snapshot(context)
      const current = () =>
        principal.isCurrent() && input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
        && attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context))
      if (
        !current() || context.profileId !== input.profileId
        || !attachmentEqual(principal.identity, evidence.identity)
        || !attachmentEqual(principal.ownerIdentity, evidence.ownerIdentity)
        || principal.moduleGeneration !== evidence.moduleGeneration
      ) throw new Error('renderer-models-unavailable')
      return {
        // A read consumes an owner-issued once grant and must not be retried automatically.
        mode: 'write',
        channelConfigurationIndependent: true,
        dispatch: async () => {
          const staged = await (input.loadPackage ?? loadStagedPluginPackage)(input.homeDir, evidence.digest)
          if (
            !current() || staged.identitySource !== principal.ownerIdentity.source
            || staged.digest !== evidence.digest || staged.manifest.id !== principal.identity.id
            || staged.manifest.version !== evidence.artifact.version
            || (staged.artifactIntegrity ?? staged.digest) !== evidence.artifact.integrity
          ) throw new Error('renderer-models-unavailable')
          const records = withDeclaredRuntimeAskPolicies(
            [],
            input.profileId,
            principal.ownerIdentity,
            staged.manifest.runtimeManifest,
          )
            .filter(record => isPermissionPolicyRecordV2(record) && record.key.capability === 'models.read')
          if (records.length !== 1 || !isPermissionPolicyRecordV2(records[0]!)) {
            throw new Error('renderer-models-unavailable')
          }
          const record = records[0]!
          if (Object.keys(record.key.scope).some(key => key !== 'providers')) {
            throw new Error('renderer-models-unavailable')
          }
          const allowedProviders = record.key.scope.providers
          if (allowedProviders && providerIds.some(id => !allowedProviders.includes(id))) {
            throw new Error('renderer-models-unavailable')
          }
          const matches = snapshot.filter(policy =>
            persistedPermissionRecordKey(policy) === persistedPermissionRecordKey(record)
          )
          if (matches.length > 1) throw new Error('renderer-models-unavailable')
          const policy = matches[0]
          if (
            policy
            && (!isPermissionPolicyRecordV2(policy)
              || !ownerDeclaredRuntimePolicy({
                manifest: staged.manifest.runtimeManifest,
                pluginId: principal.identity.id,
                record: policy,
              }))
          ) {
            throw new Error('renderer-models-unavailable')
          }
          if (
            policy?.policy !== 'allow-persistent' && !(policy === undefined || policy.policy === 'ask')
            || (policy === undefined || policy.policy === 'ask')
              && !input.bootstrap.permissionAccess.runtimeOnceGrants.consume(context, {
                requestId: authorizationRequestId,
                record,
                moduleGeneration: principal.moduleGeneration,
              })
          ) throw new Error('renderer-models-unavailable')
          const providers = await input.catalog()
          if (!current()) throw new Error('renderer-models-unavailable')
          const models = providers.filter(provider =>
            (providerIds.length === 0 || providerIds.includes(provider.providerId))
            && (!allowedProviders || allowedProviders.includes(provider.providerId))
          ).flatMap(provider =>
            provider.models.map(model => ({
              contract: 'cordisx.platform-model/v1' as const,
              schemaVersion: 1 as const,
              ref: { providerId: provider.providerId, modelId: model.id },
              hostId: 'cordisx-service',
              label: model.label,
            }))
          )
          if (models.length > 10_000 || Buffer.byteLength(JSON.stringify(models)) > 512 * 1024) {
            throw new Error('renderer-models-unavailable')
          }
          return {
            requestId,
            ok: true,
            value: {
              ok: true,
              value: {
                contract: 'cordisx.platform-model-page/v1',
                schemaVersion: 1,
                providerIds,
                models,
              },
            },
          }
        },
      }
    },
  }
}
