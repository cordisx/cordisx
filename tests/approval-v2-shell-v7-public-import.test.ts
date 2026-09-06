import type { ApprovalService } from '@cordisx/protocol/approval/v2'
import type {
  AgentConversationShellCommandContext,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v7'
import { describe, expect, it } from 'vitest'
import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellSourceFactoryV7,
} from '../packages/cli/src/contracts.js'

type FormalApprovalBubbleConsumer = readonly [
  ApprovalService,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellCommandContext,
  CordisXAgentConversationShellSourceFactoryV7,
  CordisXAgentConversationShell,
]

const surface = null as unknown as FormalApprovalBubbleConsumer

describe('formal approval v2 and Shell v7 public imports', () => {
  it('compiles the Host service, source, snapshot, and exact command-context seam', () => {
    expect(surface).toBeNull()
  })
})
