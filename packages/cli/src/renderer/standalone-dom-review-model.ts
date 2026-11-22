import type { CordisXPluginIdentity } from '../contracts.js'
import type { ManagerModel } from './manager.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import { isStandaloneDomReviewTarget, standaloneDomReview } from './standalone-dom-review.js'

/** Bind the Manager control to the exact configured graph and the live owner session. */
export function createStandaloneDomReviewModel(
  runtime: RuntimeClosureScope,
): ManagerModel['standaloneDomReview'] {
  const metadata = runtime.metadata()!
  const verifySession = metadata.standaloneReviewSession
  const broker = runtime.broker()!
  const gate = standaloneDomReview(broker)
  if (metadata.hostKind !== 'standalone' || verifySession === undefined || gate === undefined) return undefined

  const select = (identity: CordisXPluginIdentity, pointId: string, requireReview = true) => {
    if (runtime.disposed || !isStandaloneDomReviewTarget(identity, pointId)) return undefined
    const controller = runtime.activeController()!(identity.id, identity.source)
    const artifact = controller?.item.distributionArtifact
    if (
      controller === undefined || controller.status !== 'active' || !controller.principalLive
      || !runtime.activeControllers()!().includes(controller)
      || controller.item.standaloneConfiguredGraph !== true || controller.item.package !== undefined
      || artifact === undefined || requireReview && broker.domPolicy(identity, pointId) !== 'inherit'
    ) return undefined
    return { controller, artifact, moduleGeneration: runtime.moduleGenerationOf()!(controller) }
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
    }
    return {
      identity: target,
      pointId,
      profileId: metadata.profileId,
      runtimeGeneration: runtime.generation()!,
      moduleGeneration,
      artifact,
      isCurrent,
      verifyCurrent: async () => {
        try {
          return isCurrent() && await verifySession() && isCurrent()
        } catch {
          return false
        }
      },
      invalidate: () => broker.clearOnce(target),
    }
  }

  return {
    describe(identity, pointId) {
      const selected = select(identity, pointId, false)
      if (selected === undefined) return undefined
      const policy = broker.domPolicy(identity, pointId)
      if (policy !== 'inherit' && !gate.supportsPersistentReset()) return undefined
      return Object.freeze({
        version: selected.artifact.version,
        integrity: selected.artifact.integrity,
        authorized: broker.hasDomLease(identity, pointId, selected.controller.generationView),
        policy,
        persistentAvailable: gate.supportsPersistentDecision(),
        resetAvailable: gate.supportsPersistentReset(),
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
      if (selected === undefined || policy === 'inherit' || !gate.supportsPersistentReset()) return false
      const context = reviewContext(target, pointId, selected)
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
