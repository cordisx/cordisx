import { describe, expect, it } from 'vitest'
import type { AgentLoopCommand } from '@cordisx/protocol/agent-loop/v3'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V3,
} from '../packages/cli/src/agent-loop-contracts.js'
import { adaptAgentLoopV3 } from '../packages/cli/src/renderer/agent-loop-v3-compat.js'
import { CordisXAgentLoopBrokerV4 } from '../packages/cli/src/renderer/agent-loop-v4.js'
import { PlaygroundMockAgentLoopHost, PlaygroundMockAgentLoopV4Transport } from '../packages/cli/src/renderer/playground-mock-agent-loop.js'

const definition = {
  $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  contract: 'cordisx.agent-definition/v1' as const,
  schemaVersion: 1 as const,
  identity: { agentId: 'v3-agent', revision: 'r1' },
  inherit: { promptSections: 'none' as const, rules: 'none' as const, skills: 'none' as const, tools: 'none' as const, mcpServers: 'none' as const, runtimeDefaults: 'none' as const },
}

const base = (commandId: string) => ({
  $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V3,
  contract: 'cordisx.agent-loop-command/v3' as const,
  schemaVersion: 3 as const,
  commandId,
})

describe('AgentLoop v3 compatibility facade', () => {
  it('routes v3 create/send/approval through v4 authority and preserves v3 decision vocabulary', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const v4 = new CordisXAgentLoopBrokerV4(new PlaygroundMockAgentLoopV4Transport(host), host, 'profile', 'generation').bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const client = adaptAgentLoopV3(v4)
    const created = await client.createOrBind({ ...base('create-v3'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    expect(created).toMatchObject({ schemaVersion: 3, binding: { schemaVersion: 3 } })
    const sent = await client.send({ ...base('send-v3'), type: 'send', binding: created.binding, content: [{ kind: 'text', text: '[approval]' }] })
    if (sent.status !== 'accepted') throw new Error('send failed')
    const command: Extract<AgentLoopCommand, { type: 'approval-decision' }> = {
      ...base('approval-v3'), type: 'approval-decision', binding: created.binding,
      turn: sent.turn, approvalId: `simulated-approval-${sent.turn}`, decision: 'deny',
    }
    expect(await client.decideApproval(command)).toMatchObject({ status: 'accepted', schemaVersion: 3, decision: 'deny' })
    const subscription = await client.subscribe(created.binding, 0)
    expect(subscription.status).toBe('accepted')
    if (subscription.status === 'accepted') subscription.handle.unsubscribe()
    client.dispose()
  })
})
