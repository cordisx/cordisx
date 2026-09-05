import type { AgentAcquireResult, AgentOptions, AgentSetup } from '@cordisx/protocol/agents/v1'
import type { EntityBackedAgentRegistry, EntityRegistry } from '@cordisx/protocol/entities/v1'
import type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4'
import type { ApprovalService as ApprovalServiceV1 } from '@cordisx/protocol/approval/v1'
import type { ApprovalService as ApprovalServiceV2 } from '@cordisx/protocol/approval/v2'
import type { ApprovalService as ApprovalServiceV3 } from '@cordisx/protocol/approval/v3'
import type { AgentAdmissionReservationService } from '@cordisx/protocol/agent-admission/v2'
import type {
  AgentAdmissionTargetOriginService,
  AgentAdmissionTargetReservationService,
} from '@cordisx/protocol/agent-admission/v3'
import type {
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetService,
} from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5'
import type {
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationService,
} from '@cordisx/protocol/agent-admission/v6'
import type { SessionId, SessionRegistry } from '@cordisx/protocol/sessions/v1'

export const CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx/main/packages/cli/schemas/agent-session-legacy-acquire.v1.schema.json' as const
export const CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1 = 'cordisx.host-agent-session-legacy-acquire/v1' as const

/**
 * One bounded migration request for a durable AgentLoop v4 binding. The Host
 * resolves the binding through its original authority; no field is reinterpreted
 * as a SessionId by the caller.
 */
export interface CordisXAgentSessionLegacyAcquireRequestV1 {
  readonly $schema: typeof CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1
  readonly contract: typeof CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1
  readonly schemaVersion: 1
  readonly mutationId: string
  readonly binding: AgentLoopTaskBinding
  readonly options?: AgentOptions
  readonly setup?: AgentSetup
}

interface ResultEnvelope {
  readonly $schema: typeof CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1
  readonly contract: typeof CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1
  readonly schemaVersion: 1
  readonly mutationId: string
}

export type CordisXAgentSessionLegacyAcquireResultV1 =
  & ResultEnvelope
  & (
    | {
      readonly status: 'accepted'
      readonly sessionId: SessionId
      readonly identitySource: 'agent-loop-authority'
      readonly acquire: Extract<AgentAcquireResult, { readonly status: 'accepted' }>
    }
    | { readonly status: 'denied'; readonly code: 'permission-denied' }
    | { readonly status: 'conflict'; readonly code: 'mutation-conflict' | 'agent-already-live' | 'setup-conflict' }
    | {
      readonly status: 'unavailable'
      readonly code:
        | 'binding-unresolved'
        | 'binding-closed'
        | 'plugin-generation-replaced'
        | 'connection-replaced'
        | 'host-unavailable'
        | 'unsupported'
    }
  )

/** Host extension of the formal Protocol registry; still injected only as ctx.agents. */
export interface CordisXAgentRegistryV1 extends EntityBackedAgentRegistry {
  acquireLegacyTaskBinding(
    request: CordisXAgentSessionLegacyAcquireRequestV1,
  ): Promise<CordisXAgentSessionLegacyAcquireResultV1>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Protocol AgentRegistry plus the Host-owned legacy TaskBinding acquire seam. */
    agents: CordisXAgentRegistryV1
    sessions: SessionRegistry
    approvals: ApprovalServiceV1 & ApprovalServiceV2 & ApprovalServiceV3
    /** Host-owned v2 one-shot pre-submit admission; it never exposes a driver. */
    agentAdmission: AgentAdmissionReservationService
    /** Host-owned v3 issuer for one exact Shell delivery; opaque tokens are command-scoped. */
    agentAdmissionOrigins: AgentAdmissionTargetOriginService
    /** Host-owned v3 one-shot reservation for an issued target origin; it never exposes a driver. */
    agentAdmissionReservations: AgentAdmissionTargetReservationService
    /** Host-owned v4 declaration service for one new Room target under a Shell v9 bootstrap command. */
    agentAdmissionBootstrapTargets: AgentAdmissionBootstrapTargetService
    /** Host-owned v4 one-shot reservation for a bootstrap target; it never exposes a driver. */
    agentAdmissionBootstrapReservations: AgentAdmissionBootstrapReservationService
    /** Host-owned v5 issuer for one exact Room target on the current Shell binding. */
    agentAdmissionBootstrapRoomTargets: AgentAdmissionBootstrapRoomTargetService
    /** Host-owned v5 one-shot reservation; its receipt never transfers across a binding replacement. */
    agentAdmissionBootstrapRoomReservations: AgentAdmissionBootstrapRoomReservationService
    /** Host-owned v6 declaration for one exact Room target plus its matching future Room route. */
    agentAdmissionBootstrapRouteDeclarations: AgentAdmissionBootstrapRouteDeclarationService
    /** Host-owned v6 pre-submit reservation; Host alone may later claim its continuation. */
    agentAdmissionBootstrapRouteReservations: AgentAdmissionBootstrapRouteReservationService
    entities: EntityRegistry
  }
}
