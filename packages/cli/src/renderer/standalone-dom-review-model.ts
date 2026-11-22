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

  return {
    describe(identity, pointId) {
      const selected = select(identity, pointId)
      return selected === undefined ? undefined : Object.freeze({
        version: selected.artifact.version,
        integrity: selected.artifact.integrity,
        authorized: broker.hasDomLease(identity, pointId, selected.controller.generationView),
        persistentAvailable: gate.supportsPersistentDecision(),
      })
    },
    async request(identity, pointId) {
      const target = Object.freeze({ id: identity.id, source: identity.source })
      const selected = select(target, pointId)
      if (selected === undefined) return false
      const { controller, moduleGeneration } = selected
      const artifact = Object.freeze({ ...selected.artifact })
      const isCurrent = () => {
        const current = select(target, pointId, false)
        return current?.controller === controller && current.moduleGeneration === moduleGeneration
          && current.artifact.version === artifact.version && current.artifact.integrity === artifact.integrity
      }
      const verifyCurrent = async () => {
        try {
          return isCurrent() && await verifySession() && isCurrent()
        } catch {
          return false
        }
      }
      if (broker.hasDomLease(target, pointId, controller.generationView)) {
        const current = await verifyCurrent()
        if (!current) broker.clearOnce(target)
        return current
      }
      const allowed = await gate.review({
        identity: target,
        pointId,
        profileId: metadata.profileId,
        runtimeGeneration: runtime.generation()!,
        moduleGeneration,
        artifact,
        isCurrent,
        verifyCurrent,
        invalidate: () => broker.clearOnce(target),
      }, async () => (await broker.requestDomAccess(target, pointId, controller.generationView)).authorized)
      broker.refreshDomAccess()
      return allowed
    },
  }
}
