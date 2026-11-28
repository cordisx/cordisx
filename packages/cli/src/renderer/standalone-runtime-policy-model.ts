import type { CordisXPluginIdentity } from '../contracts.js'
import type { CordisXPermissionCapabilityV2, CordisXPermissionPolicyV2 } from '../permission-contracts.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'
import type { ManagerModel } from './manager.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import {
  consumeStandaloneRuntimePolicyClick,
  standaloneRuntimePolicyReviewer,
} from './standalone-runtime-policy-review.js'

/** Bind a settings decision to the owner-selected active graph and authenticated session. */
export function createStandaloneRuntimePolicyModel(
  runtime: RuntimeClosureScope,
): ManagerModel['standaloneRuntimeReview'] {
  const metadata = runtime.metadata()!
  const broker = runtime.broker()!
  const authorize = standaloneRuntimePolicyReviewer(broker)
  const verifySession = metadata.standaloneReviewSession
  const native = metadata.nativeOwnerPermissionReview === true && metadata.ownerPermissionSnapshot === true
  if (metadata.hostKind !== 'standalone' && !native || !authorize || !verifySession) return undefined

  const select = (identity: CordisXPluginIdentity) => {
    if (
      runtime.disposed
      || !(native ? isNativeManagerDomTarget : isStandaloneManagerDomTarget)(identity, 'manager.content')
    ) {
      return undefined
    }
    const controller = runtime.activeController()!(identity.id, identity.source)
    if (
      !controller || controller.status !== 'active' || !controller.principalLive
      || controller.manifest.schemaVersion === 1
      || !runtime.activeControllers()!().includes(controller) || controller.identity.id !== identity.id
      || controller.identity.source !== identity.source
    ) return undefined
    const moduleGeneration = runtime.moduleGenerationOf()!(controller)
    const item = controller.item
    const configured = item.package === undefined && (
      item.standaloneConfiguredGraph === true
      || native && item.distributionArtifact !== undefined && item.artifactGeneration === moduleGeneration
    )
    let artifact = configured ? item.distributionArtifact : undefined
    if (!configured && (native || item.standaloneInstalledGraph === true) && item.package !== undefined) {
      const activation = runtime.currentActivation
      const matches = activation.plugins.filter(plugin => plugin.id === identity.id)
      const active = matches[0]
      if (
        activation.recordKind !== 'active' || activation.profileId !== metadata.profileId
        || activation.runtimeGeneration !== runtime.generation() || matches.length !== 1 || !active?.enabled
        || active.digest !== item.package.digest || active.version !== item.package.version
        || active.moduleGeneration !== item.package.moduleGeneration
        || moduleGeneration !== item.package.moduleGeneration
        || active.canonicalSource !== item.package.canonicalSource
        || item.package.canonicalSource !== undefined && item.package.canonicalSource !== identity.source
      ) return undefined
      artifact = { version: item.package.version, integrity: item.package.artifactIntegrity ?? item.package.digest }
    }
    const eligible = configured && (
          native || identity.id === 'channel' && metadata.standaloneConfiguredPolicyReview === true
          || metadata.standaloneConfiguredPluginPolicyReview?.includes(identity.id) === true
        )
      || (native || item.standaloneInstalledGraph === true)
        && (native || metadata.standaloneInstalledPolicyReview === true)
    if (!artifact || !moduleGeneration || !eligible) return undefined
    return { controller, moduleGeneration, artifact, digest: item.package?.digest }
  }

  const prepare = (identity: CordisXPluginIdentity, capability: string, fingerprint: string) => {
    const selected = select(identity)
    if (!selected) return undefined
    try {
      const name = capability as CordisXPermissionCapabilityV2
      const initial = broker.reviewPolicyV2(identity, name, 'ask')
      if (initial.record.key.securityFingerprint !== fingerprint) return undefined
      const options: CordisXPermissionPolicyV2[] = []
      for (const policy of ['ask', 'allow-persistent', 'deny-persistent'] as const) {
        try {
          broker.reviewPolicyV2(identity, name, policy)
          options.push(policy)
        } catch { /* the capability catalog does not permit this decision */ }
      }
      return { selected, name, policy: initial.observed, options }
    } catch {
      return undefined
    }
  }

  return {
    native,
    describe(identity, capability, fingerprint) {
      const value = prepare(identity, capability, fingerprint)
      return value ? { policy: value.policy, options: value.options } : undefined
    },
    async set(identity, capability, fingerprint, policy, event) {
      const target = { id: identity.id, source: identity.source }
      const prepared = prepare(target, capability, fingerprint)
      if (
        !prepared || !prepared.options.includes(policy) || prepared.policy === policy
        || !consumeStandaloneRuntimePolicyClick(event, target, prepared.name, fingerprint, policy)
      ) return false
      const original = broker.reviewPolicyV2(target, prepared.name, policy)
      try {
        if (!await verifySession() || runtime.disposed) return false
        if (native) {
          const management = runtime.pluginManagementBinding()!
          if (!management) return false
          await management.query()
        }
        const current = prepare(target, capability, fingerprint)
        const next = broker.reviewPolicyV2(target, prepared.name, policy)
        if (
          !current || current.selected.controller !== prepared.selected.controller
          || current.selected.moduleGeneration !== prepared.selected.moduleGeneration
          || current.selected.digest !== prepared.selected.digest
          || JSON.stringify(current.selected.artifact) !== JSON.stringify(prepared.selected.artifact)
          || JSON.stringify(next) !== JSON.stringify(original)
        ) return false
        const cancel = authorize(
          {
            identity: target,
            profileId: metadata.profileId,
            runtimeGeneration: runtime.generation()!,
            moduleGeneration: current.selected.moduleGeneration,
            artifact: current.selected.artifact,
          },
          original.record,
          original.observed,
        )
        if (!cancel) return false
        try {
          await broker.setPolicyV2(target, prepared.name, policy)
          return !runtime.disposed && broker.policyV2(target, prepared.name) === policy
        } finally {
          cancel()
        }
      } catch {
        return false
      }
    },
  }
}
