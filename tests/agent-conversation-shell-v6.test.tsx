import type { AgentConversationApprovalItem, AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v6'
import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CordisXAgentConversationShellService,
  projectAgentConversationShellSnapshotV4,
  projectAgentConversationShellSnapshotV6,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import { playgroundConversationCopy } from '../packages/cli/src/playground/client/fixtures/agent-conversation.js'

const localized = (key: string, fallback: string) => ({ key, fallback })

function approval(state: AgentConversationApprovalItem['state']): AgentConversationApprovalItem {
  const base = {
    kind: 'approval' as const,
    itemId: `approval-${state}`,
    sequence: 1,
    participantId: 'agent-reviewer',
    memberId: 'member-reviewer',
    runId: 'run-reviewer',
    sessionId: 'cx-session.reviewer',
    approvalId: 'cx-approval.review-command',
    approvalKind: 'command' as const,
    rationale: localized('approval.rationale', 'Run the review command?'),
  }
  if (state === 'pending') return {
    ...base, state, agentGeneration: 7,
    actions: [{ decision: 'approve', command: { id: 'approval.answer', arguments: { decision: 'allowed-once' } } }],
  }
  if (state === 'failed') return {
    ...base, state, actions: [], diagnostic: localized('approval.failed', 'Approval service is unavailable.'),
  }
  return { ...base, state, actions: [] }
}

function snapshot(item: AgentConversationApprovalItem): AgentConversationShellSnapshot {
  const participant = {
    participantId: 'agent-reviewer', role: 'agent' as const,
    displayName: localized('agent.reviewer', 'Reviewer'),
    agentIdentity: { agentId: 'reviewer', revision: 'revision-reviewer' },
  }
  return {
    binding: { bindingId: 'binding-v6', ownerGeneration: 'owner-generation-v6' },
    generation: 'snapshot-generation-v6', snapshotSequence: 1,
    selection: {
      kind: 'room', roomId: 'room-review', title: localized('room.review', 'Review room'),
      multiParticipant: false, participantPresentation: 'none', participants: [participant],
      activeRuns: [{
        participantId: participant.participantId, memberId: item.memberId, runId: item.runId,
        sessionId: item.sessionId, lifecycle: { phase: item.state === 'pending' ? 'attention' : 'active' },
      }],
    },
    items: [item],
    composer: {
      availability: 'available', placeholder: localized('composer', 'Message'), disabled: { value: false },
      shortcutPolicy: 'enter', submit: { id: 'message.send' },
    },
    headerActions: [],
  }
}

describe('Agent conversation Shell v6 terminal approval projection', () => {
  it('exposes an additive v6 source registration without removing v4 or v5', () => {
    expect(CordisXAgentConversationShellService.prototype.registerSourceV4).toBeTypeOf('function')
    expect(CordisXAgentConversationShellService.prototype.registerSourceV5).toBeTypeOf('function')
    expect(CordisXAgentConversationShellService.prototype.registerSourceV6).toBeTypeOf('function')
  })

  it.each(['approved', 'denied', 'cancelled', 'failed'] as const)('renders cold %s history without generation or actions', state => {
    const model = projectAgentConversationShellSnapshotV6('chatroom', snapshot(approval(state)), { resolve: value => value.fallback })
    const entry = model.entries[0]!
    expect(entry).toMatchObject({ kind: 'approval', state, sessionId: 'cx-session.reviewer', approvalId: 'cx-approval.review-command', actions: [] })
    expect(entry).not.toHaveProperty('agentGeneration')
    const execute = vi.fn(async () => undefined)
    const controller = new AgentConversationCommandController({ execute }, model)
    const markup = renderToString(<AgentConversationRenderer model={model} commands={controller} copy={playgroundConversationCopy('en')} />)
    const document = new JSDOM(markup).window.document
    expect(document.querySelector('.cxa-approval')?.getAttribute('aria-label')).toContain(state)
    expect(document.querySelector('.cxa-approval-actions')).toBeNull()
    expect(document.querySelector('.cxa-approval button')).toBeNull()
    expect(() => controller.runApproval(model, entry as never, { decision: 'approve', command: { id: 'approval.answer' } })).toThrow(/unavailable/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps a live pending approval generation-bound and invokable through its sole command', async () => {
    const model = projectAgentConversationShellSnapshotV6('chatroom', snapshot(approval('pending')), { resolve: value => value.fallback })
    const entry = model.entries[0]!
    expect(entry).toMatchObject({ kind: 'approval', state: 'pending', agentGeneration: 7 })
    const execute = vi.fn(async () => undefined)
    const controller = new AgentConversationCommandController({ execute }, model)
    if (entry.kind !== 'approval') throw new Error('expected approval')
    await controller.runApproval(model, entry, entry.actions[0]!)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      invocationKey: 'approval:approval-pending:approve',
      context: { scope: 'approval', itemId: 'approval-pending', command: { id: 'approval.answer' } },
    })
  })

  it('fails closed for invokable terminal, unauthoritative pending, malformed failure, and duplicate Session approval pairs', () => {
    const pendingWithoutGeneration = structuredClone(approval('pending')) as Record<string, unknown>
    delete pendingWithoutGeneration.agentGeneration
    const pendingWithoutActions = { ...approval('pending'), actions: [] }
    const terminalWithAction = { ...approval('approved'), actions: [{ decision: 'approve', command: { id: 'approval.answer' } }] }
    const failedWithoutDiagnostic = structuredClone(approval('failed')) as Record<string, unknown>
    delete failedWithoutDiagnostic.diagnostic
    const approvedWithDiagnostic = { ...approval('approved'), diagnostic: localized('wrong', 'Not allowed') }
    for (const item of [pendingWithoutGeneration, pendingWithoutActions, terminalWithAction, failedWithoutDiagnostic, approvedWithDiagnostic]) {
      expect(() => projectAgentConversationShellSnapshotV6('chatroom', snapshot(item as never), { resolve: value => value.fallback })).toThrow()
    }
    const duplicate = snapshot(approval('approved')) as unknown as { items: unknown[]; snapshotSequence: number }
    duplicate.items.push({ ...approval('denied'), itemId: 'approval-duplicate', sequence: 2 })
    duplicate.snapshotSequence = 2
    expect(() => projectAgentConversationShellSnapshotV6('chatroom', duplicate as never, { resolve: value => value.fallback })).toThrow(/duplicate Session approval/)
  })

  it('does not relax the predecessor v4 generation requirement', () => {
    const input = snapshot(approval('approved')) as unknown as Parameters<typeof projectAgentConversationShellSnapshotV4>[1]
    const { shortcutPolicy: _shortcutPolicy, ...composer } = input.composer as AgentConversationShellSnapshot['composer']
    expect(() => projectAgentConversationShellSnapshotV4('chatroom', { ...input, composer } as never, { resolve: value => value.fallback }))
      .toThrow(/agentGeneration/)
  })
})
