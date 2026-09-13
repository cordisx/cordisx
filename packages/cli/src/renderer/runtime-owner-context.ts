import type { Context } from '@deepseek-ai/cordis'

/** Each mounted owner receives distinct capability registrations and disposal. */
export function isolateRuntimeOwnerServices(ctx: Context): Context {
  for (
    const name of [
      'connectors',
      'agentLoop',
      'agents',
      'sessions',
      'agentSessionDetailReferences',
      'agentDetailNavigation',
      'approvals',
      'agentAdmission',
      'agentAdmissionOrigins',
      'agentAdmissionReservations',
      'agentAdmissionBootstrapTargets',
      'agentAdmissionBootstrapReservations',
      'agentAdmissionBootstrapRoomTargets',
      'agentAdmissionBootstrapRoomReservations',
      'agentAdmissionBootstrapRouteDeclarations',
      'agentAdmissionBootstrapRouteReservations',
      'agentPageAdmissionTargets',
      'agentPageAdmissionReservations',
      'agentPageAdmissionRouteDeclarations',
      'agentPageAdmissionRouteReservations',
      'agentPageFreshRoomNavigation',
      'entityExecutionContexts',
      'agentTaskApprovals',
      'agentTaskOwnership',
      'agentTasks',
      'agentTools',
      'entities',
      'documents',
      'http',
      'workSettlement',
      'agentLoopControl',
      'restrictedContent',
      'isolatedGameUi',
      'notifications',
      'dialogs',
      'currentUser',
    ]
  ) ctx = ctx.isolate(name)
  return ctx
}
