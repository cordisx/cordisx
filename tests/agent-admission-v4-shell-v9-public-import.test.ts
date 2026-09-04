import type {
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetService,
  AgentBootstrapCommandOrigin,
} from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentConversationShellCommandContext,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v9'
import { describe, expect, it } from 'vitest'
import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellSourceFactoryV9,
} from '../packages/cli/src/contracts.js'

type FormalBootstrapAdmissionConsumer = readonly [
  AgentBootstrapCommandOrigin,
  AgentAdmissionBootstrapTargetService,
  AgentAdmissionBootstrapReservationService,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellCommandContext,
  CordisXAgentConversationShellSourceFactoryV9,
  CordisXAgentConversationShell,
]

const surface = null as unknown as FormalBootstrapAdmissionConsumer

describe('formal admission v4 and Shell v9 public imports', () => {
  it('compiles the bootstrap command, target reservation, and public v9 registration seams', () => {
    expect(surface).toBeNull()
  })
})
