import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5'
import { describe, expect, it } from 'vitest'
import '../packages/cli/src/agent-session-migration-contracts.js'

type FormalBootstrapRoomConsumer = readonly [
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetService,
  AgentAdmissionBootstrapRoomReservationService,
  Context['agentAdmissionBootstrapRoomTargets'],
  Context['agentAdmissionBootstrapRoomReservations'],
]

const surface = null as unknown as FormalBootstrapRoomConsumer

describe('formal admission v5 current-binding Room public imports', () => {
  it('compiles the plugin-facing Room target and reservation seams', () => {
    expect(surface).toBeNull()
  })
})
