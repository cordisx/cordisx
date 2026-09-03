import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import { createAgentConversationModel } from '../packages/cli/src/renderer/host-ui/conversation/model.js'

describe('Conversation Shell v3 production projection', () => {
  it('renders semantic self-introduction, approval actions, and Room description through Host chrome', () => {
    const model = createAgentConversationModel({
      ownerId: 'chatroom', shell: 'agent-desktop', binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' }, generation: 'snapshot-1', snapshotSequence: 4,
      selection: {
        kind: 'room', roomId: 'room-1', title: 'Architecture', description: { state: 'present', text: 'Durable Agent room' }, secondary: 'Two members',
        multiParticipant: true, participantPresentation: 'host-initials', participants: [
          { id: 'human-1', role: 'human', name: 'You' },
          { id: 'agent-1', role: 'agent', name: 'Architect', agentIdentity: { agentId: 'architect', revision: 'r1' } },
        ],
        activeRuns: [{ participantId: 'agent-1', memberId: 'room-member-1', runId: 'run-1', lifecycle: { phase: 'attention' }, detailsUrl: { url: 'app://-/tasks/one', target: 'host' } }],
      },
      entries: [
        {
          kind: 'message', itemId: 'message-item-1', messageId: 'message-1', sequence: 1, authorId: 'agent-1', body: ['Hello, I am the Architect.'], timestamp: '2026-08-31T00:00:00.000Z',
          deliveryState: 'delivered', runState: 'idle', ariaLive: 'polite', actions: [], source: 'agent-loop', reactions: [],
          semantic: { purpose: 'member-self-introduction', causation: { operationId: 'introduction-1' }, participantId: 'agent-1', memberId: 'room-member-1', runId: 'run-1', binding: { bindingId: 'loop-binding-1', generation: 1 }, turn: 'turn-1' },
        },
        {
          kind: 'approval', itemId: 'approval-item-1', sequence: 2, participantId: 'agent-1', memberId: 'room-member-1', runId: 'run-1', binding: { bindingId: 'loop-binding-1', generation: 1 },
          turn: 'turn-2', approvalId: 'approval-1', approvalKind: 'command', state: 'pending', rationale: 'Run checks',
          actions: [
            { decision: 'approve', command: { id: 'chatroom:approve' } },
            { decision: 'deny', command: { id: 'chatroom:deny' } },
          ],
        },
      ],
      composer: { availability: 'available', placeholder: 'Message', disabled: false, shortcutPolicy: 'enter', submit: { id: 'chatroom:submit' } }, headerActions: [],
    })
    const commands = new AgentConversationCommandController({ execute: async () => undefined }, model)
    const markup = renderToString(<AgentConversationRenderer model={model} commands={commands} copy={{ locale: 'en', newRoomTitle: 'New room', timelineLabel: 'Room conversation', composerLabel: 'Message', sendLabel: 'Send', running: 'Working', stopped: 'Stopped', failed: 'Failed', pending: 'Pending', unavailable: 'Unavailable' }} />)
    expect(markup).toContain('data-agent-conversation-renderer="production"')
    expect(markup).toContain('Durable Agent room')
    expect(markup).toContain('requests approval')
    expect(markup).toContain('Approve')
    expect(markup).toContain('Deny')
    expect(markup).toContain('Hello, I am the Architect.')
  })
})
