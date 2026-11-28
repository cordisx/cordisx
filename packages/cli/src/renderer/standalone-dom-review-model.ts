import type { CordisXPluginIdentity } from '../contracts.js'
import type { ManagerModel } from './manager.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'
import { standaloneDomReview } from './standalone-dom-review.js'

/** Bind the Manager control to an exact owner-issued graph and the live owner session. */
export function createStandaloneDomReviewModel(
  runtime: RuntimeClosureScope,
): ManagerModel['standaloneDomReview'] {
  const metadata = runtime.metadata()!
  const verifySession = metadata.standaloneReviewSession
  const broker = runtime.broker()!
  const gate = standaloneDomReview(broker)
  const native = metadata.nativeOwnerPermissionReview === true && metadata.ownerPermissionSnapshot === true
  if (metadata.hostKind !== 'standalone' && !native || verifySession === undefined || gate === undefined) {
    return undefined
  }

  const select = (identity: CordisXPluginIdentity, pointId: string, requireReview = true) => {
    if (runtime.disposed || !(native ? isNativeManagerDomTarget : isStandaloneManagerDomTarget)(identity, pointId)) {
      return undefined
    }
    const controller = runtime.activeController()!(identity.id, identity.source)
    if (
      controller === undefined || controller.status !== 'active' || !controller.principalLive
      || !runtime.activeControllers()!().includes(controller)
      || controller.identity.id !== identity.id || controller.identity.source !== identity.source
      || requireReview && broker.domPolicy(identity, pointId) !== 'inherit'
    ) return undefined
    const moduleGeneration = runtime.moduleGenerationOf()!(controller)
    const configured = controller.item.package === undefined && (
      controller.item.standaloneConfiguredGraph === true
      || native && controller.item.distributionArtifact !== undefined
        && controller.item.artifactGeneration === moduleGeneration
    )
    const packageItem = controller.item.package
    let artifact = configured ? controller.item.distributionArtifact : undefined
    if (!configured && (native || controller.item.standaloneInstalledGraph === true) && packageItem !== undefined) {
      const activation = runtime.currentActivation
      const matches = activation.plugins.filter(item => item.id === identity.id)
      const active = matches[0]
      if (
        activation.recordKind !== 'active' || activation.profileId !== metadata.profileId
        || activation.runtimeGeneration !== runtime.generation() || matches.length !== 1 || !active?.enabled
        || active.digest !== packageItem.digest || active.version !== packageItem.version
        || active.moduleGeneration !== packageItem.moduleGeneration || moduleGeneration !== packageItem.moduleGeneration
        || active.canonicalSource !== packageItem.canonicalSource
        || packageItem.canonicalSource !== undefined && packageItem.canonicalSource !== identity.source
      ) return undefined
      artifact = { version: packageItem.version, integrity: packageItem.artifactIntegrity ?? packageItem.digest }
    }
    if (artifact === undefined) return undefined
    return {
      controller,
      artifact,
      moduleGeneration,
      persistentEligible: configured && (
            native || identity.id === 'channel' && metadata.standaloneConfiguredPolicyReview === true
            || metadata.standaloneConfiguredPluginPolicyReview?.includes(identity.id) === true
          )
        || (native || controller.item.standaloneInstalledGraph === true)
          && (native || metadata.standaloneInstalledPolicyReview === true),
      packageDigest: packageItem?.digest,
    }
  }
  const reviewContext = (
    target: CordisXPluginIdentity,
    pointId: string,
    selected: NonNullable<ReturnType<typeof select>>,
  ) => {
    const { controller, moduleGeneration } = selected
    const artifact = Object.freeze({ ...selected.artifact })
    const isCurrent = () => {
      const current = select(target, pointId, false)
      return current?.controller === controller && current.moduleGeneration === moduleGeneration
        && current.artifact.version === artifact.version && current.artifact.integrity === artifact.integrity
        && current.packageDigest === selected.packageDigest
        && current.persistentEligible === selected.persistentEligible
    }
    return {
      identity: target,
      pointId,
      profileId: metadata.profileId,
      runtimeGeneration: runtime.generation()!,
      moduleGeneration,
      artifact,
      persistentEligible: selected.persistentEligible,
      isCurrent,
      verifyCurrent: async () => {
        try {
          if (!isCurrent() || !await verifySession()) return false
          if (native) {
            const management = runtime.pluginManagementBinding()!
            if (!management) return false
            await management.query()
          }
          return isCurrent()
        } catch {
          return false
        }
      },
      invalidate: () => broker.clearOnce(target),
    }
  }

  return {
    native,
    describe(identity, pointId) {
      const selected = select(identity, pointId, false)
      if (selected === undefined) return undefined
      const policy = broker.domPolicy(identity, pointId)
      const context = reviewContext(identity, pointId, selected)
      if (policy !== 'inherit' && !gate.supportsPersistentReset(context)) return undefined
      return Object.freeze({
        version: selected.artifact.version,
        integrity: selected.artifact.integrity,
        authorized: broker.hasDomLease(identity, pointId, selected.controller.generationView),
        policy,
        persistentAvailable: gate.supportsPersistentDecision(context),
        resetAvailable: gate.supportsPersistentReset(context),
      })
    },
    async request(identity, pointId) {
      const target = Object.freeze({ id: identity.id, source: identity.source })
      const selected = select(target, pointId)
      if (selected === undefined) return false
      const { controller } = selected
      const context = reviewContext(target, pointId, selected)
      if (broker.hasDomLease(target, pointId, controller.generationView)) {
        const current = await context.verifyCurrent()
        if (!current) broker.clearOnce(target)
        return current
      }
      const allowed = await gate.review(
        context,
        async () => (await broker.requestDomAccess(target, pointId, controller.generationView)).authorized,
      )
      broker.refreshDomAccess()
      return allowed
    },
    async reset(identity, pointId, event) {
      const target = Object.freeze({ id: identity.id, source: identity.source })
      const selected = select(target, pointId, false)
      const policy = broker.domPolicy(target, pointId)
      if (selected === undefined || policy === 'inherit') return false
      const context = reviewContext(target, pointId, selected)
      if (!gate.supportsPersistentReset(context)) return false
      return await gate.reset(
        context,
        policy === 'allow' ? 'allow-persistent' : 'deny-persistent',
        event,
        () => broker.domPolicy(target, pointId) === policy,
        async () => {
          await broker.setDomPolicy(target, pointId, 'ask')
          broker.refreshDomAccess()
          return broker.domPolicy(target, pointId) === 'inherit'
        },
      )
    },
  }
}
