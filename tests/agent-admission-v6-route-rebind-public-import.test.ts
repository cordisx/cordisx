import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentAdmissionBootstrapRouteClaimService,
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationService,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6'
import { describe, expect, it } from 'vitest'
import '../packages/cli/src/agent-session-migration-contracts.js'

type FormalBootstrapRouteConsumer = readonly [
  AgentAdmissionBootstrapRouteTarget,
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationService,
  AgentAdmissionBootstrapRouteClaimService,
  Context['agentAdmissionBootstrapRouteDeclarations'],
  Context['agentAdmissionBootstrapRouteReservations'],
]

const surface = null as unknown as FormalBootstrapRouteConsumer

describe('formal admission v6 route rebind public imports', () => {
  it('compiles plugin declaration/reservation seams while retaining Host-only claim typing', () => {
    expect(surface).toBeNull()
  })
})
