import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import type { PluginController } from './runtime-shared.js'

export const createRuntimeDisposeControllerFiber = async (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  reason: 'owner-disposed' | 'generation-replaced',
): Promise<void> => {
  runtimeScope.rememberRegistrations()!(controller.item.id)
  runtimeScope.agentRuntime()!.releaseOwner(controller.identity, reason, runtimeScope.moduleGenerationOf()!(controller))
  let failure: unknown
  try {
    await controller.hostDomWorker?.dispose()
    await controller.fiber?.dispose()
  } catch (error) {
    failure = error
  }
  try {
    await runtimeScope.routeService?.settled()
  } catch (error) {
    failure ??= error
  } finally {
    const owner = `${controller.item.source}:${controller.item.id}`
    runtimeScope.agentRouteScopes()!.revoke(owner, 'plugin-generation-replaced')
    runtimeScope.agentSessionRuntime.fenceOwner(owner, 'plugin-generation-replaced')
    for (
      const key of [
        'agentPageFreshRoomNavigationFiber',
        'agentPageAdmissionRouteReservationFiber',
        'agentPageAdmissionRouteDeclarationFiber',
        'agentPageAdmissionReservationFiber',
        'agentPageAdmissionTargetFiber',
        'agentAdmissionBootstrapRouteReservationFiber',
        'agentAdmissionBootstrapRouteDeclarationFiber',
        'agentAdmissionBootstrapReservationFiber',
        'agentAdmissionBootstrapTargetFiber',
        'agentAdmissionBootstrapRoomReservationFiber',
        'agentAdmissionBootstrapRoomTargetFiber',
        'agentAdmissionTargetReservationFiber',
        'agentAdmissionTargetOriginFiber',
        'agentAdmissionReservationFiber',
        'approvalServiceFiber',
        'agentDetailNavigationFiber',
        'agentSessionDetailReferenceFiber',
        'sessionRegistryFiber',
        'agentRegistryFiber',
        'entityRegistryFiber',
      ] as const
    ) {
      await controller[key]?.dispose()
      delete controller[key]
    }
    controller.unregisterAgentSessionMigration?.()
    delete controller.unregisterAgentSessionMigration
    controller.agentLoopClient?.dispose()
    delete controller.agentLoopClient
    controller.httpClient?.dispose()
    delete controller.httpClient
    await controller.unregisterHttp?.()
    delete controller.unregisterHttp
    controller.unregisterDialogs?.()
    delete controller.unregisterDialogs
    controller.unregisterNotifications?.()
    delete controller.unregisterNotifications
    controller.restrictedContent?.dispose()
    await controller.unregisterRestrictedContent?.()
    delete controller.restrictedContent
    delete controller.unregisterRestrictedContent
    controller.agentLoopControl?.dispose()
    await controller.unregisterAgentLoopControl?.()
    delete controller.agentLoopControl
    delete controller.unregisterAgentLoopControl
    await controller.unregisterAgentLoop?.()
    delete controller.unregisterAgentLoop
    controller.documentsClient?.dispose()
    delete controller.documentsClient
    controller.unregisterAgentTools?.()
    delete controller.unregisterAgentTools
    await controller.unregisterDocuments?.()
    delete controller.unregisterDocuments
    await controller.unregisterManagedServices?.()
    delete controller.unregisterManagedServices
    await controller.unregisterModelProviders?.()
    delete controller.unregisterModelProviders
    controller.connectorClient?.dispose()
    delete controller.connectorClient
    await controller.unregisterConnector?.()
    delete controller.unregisterConnector
    runtimeScope.retirePrincipal()!(controller, `Plugin disposed: ${reason}`)
    delete controller.hostDomWorker
    delete controller.fiber
  }
  if (failure !== undefined) throw failure
}
