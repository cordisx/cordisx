import type { AgentConversationApprovalItem, AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v7'
import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CordisXAgentConversationShellService,
  projectAgentConversationShellSnapshotV6,
  projectAgentConversationShellSnapshotV7,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import { AGENT_CONVERSATION_STYLES } from '../packages/cli/src/renderer/host-ui/conversation/styles.js'
import { playgroundConversationCopy } from '../packages/cli/src/playground/client/fixtures/agent-conversation.js'

const localized = (key: string, fallback: string) => ({ key, fallback })
const reviewer = { agentId: 'reviewer', revision: 'revision-reviewer-v7' }
const lead = { agentId: 'lead', revision: 'revision-lead-v7' }
const authorityBinding = {
  agentId: 'cx-session.lead-v7', sessionId: 'cx-session.lead-v7', agentGeneration: 11, definition: lead,
}

function approval(state: AgentConversationApprovalItem['state']): AgentConversationApprovalItem {
  const base = {
    kind: 'approval' as const, itemId: 'approval-v7', sequence: 2,
    participantId: 'agent-reviewer', memberId: 'member-reviewer', runId: 'run-reviewer',
    sessionId: 'cx-session.reviewer-v7', approvalId: 'cx-approval.v7', approvalKind: 'external-action' as const,
    requester: reviewer,
    authority: { participantId: 'agent-lead', memberId: 'member-lead', identity: lead },
    reason: { kind: 'plain-text' as const, text: 'Publish the reviewed release candidate.' },
  }
  if (state === 'pending') return {
    ...base, state, agentGeneration: 7, authorityBinding,
    actions: [
      { decision: 'approve', command: { id: 'approval.answer', arguments: { outcome: 'allowed-once' } } },
      { decision: 'reject', command: { id: 'approval.answer', arguments: { outcome: 'rejected' } } },
    ],
  }
  if (state === 'failed') return { ...base, state, actions: [], diagnostic: localized('approval.failed', 'Lead authority is unavailable.') }
  return { ...base, state, actions: [] }
}

function snapshot(item: AgentConversationApprovalItem): AgentConversationShellSnapshot {
  return {
    binding: { bindingId: 'binding-v7', ownerGeneration: 'owner-v7' },
    generation: 'snapshot-v7', snapshotSequence: 2,
    selection: {
      kind: 'room', roomId: 'room-v7', title: localized('room.v7', 'Release review'),
      multiParticipant: true, participantPresentation: 'host-initials',
      participants: [
        { participantId: 'agent-reviewer', role: 'agent', displayName: localized('reviewer', 'Reviewer'), agentIdentity: reviewer },
        { participantId: 'agent-lead', role: 'agent', displayName: localized('lead', 'Lead'), agentIdentity: lead },
      ],
      activeRuns: [
        { participantId: 'agent-reviewer', memberId: 'member-reviewer', runId: 'run-reviewer', sessionId: 'cx-session.reviewer-v7', lifecycle: { phase: 'attention' } },
        { participantId: 'agent-lead', memberId: 'member-lead', runId: 'run-lead', sessionId: 'cx-session.lead-v7', lifecycle: { phase: 'active' } },
      ],
    },
    items: [item],
    composer: { availability: 'available', placeholder: localized('composer', 'Message'), disabled: { value: false }, shortcutPolicy: 'enter', submit: { id: 'message.send' } },
    headerActions: [],
  }
}

describe('Agent conversation Shell v7 approval message bubble', () => {
  it('offers v7 additively and projects exact requester, Lead authority, reason, and command context', async () => {
    expect(CordisXAgentConversationShellService.prototype.registerSourceV6).toBeTypeOf('function')
    expect(CordisXAgentConversationShellService.prototype.registerSourceV7).toBeTypeOf('function')
    const model = projectAgentConversationShellSnapshotV7('chatroom', snapshot(approval('pending')), { resolve: value => value.fallback })
    const entry = model.entries[0]
    expect(entry).toMatchObject({ kind: 'approval', requester: reviewer, authority: { identity: lead }, reason: { text: 'Publish the reviewed release candidate.' }, actions: [{ decision: 'approve' }, { decision: 'reject' }] })
    if (entry?.kind !== 'approval') throw new Error('approval missing')
    const execute = vi.fn(async () => undefined)
    const controller = new AgentConversationCommandController({ execute }, model)
    await controller.runApproval(model, entry, entry.actions[1]!)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      invocationKey: 'approval:approval-v7:reject',
      context: {
        binding: model.binding, generation: model.generation, scope: 'approval', itemId: entry.itemId,
        command: entry.actions[1]!.command,
        approval: { sessionId: 'cx-session.reviewer-v7', approvalId: 'cx-approval.v7', requester: reviewer, authority: authorityBinding, decision: 'reject' },
      },
    }))
  })

  it('renders Reviewer once outside the special bubble and only icon-backed Approve/Reject actions', () => {
    const model = projectAgentConversationShellSnapshotV7('chatroom', snapshot(approval('pending')), { resolve: value => value.fallback })
    const controller = new AgentConversationCommandController({ execute: async () => undefined }, model)
    const document = new JSDOM(renderToString(<AgentConversationRenderer model={model} commands={controller} copy={playgroundConversationCopy('en')} />)).window.document
    const bubble = document.querySelector('[data-entry-id="approval-v7"]')
    expect(bubble?.classList.contains('cxa-approval-message')).toBe(true)
    expect(bubble?.querySelector('.cxa-author')?.textContent).toBe('Reviewer')
    expect(bubble?.querySelector('.cxa-approval-bubble')?.textContent?.match(/Reviewer/gu)).toBeNull()
    expect(bubble?.querySelector('.cxa-approval-target')?.textContent).toBe('Approval by Lead')
    expect(bubble?.querySelector('.cxa-approval-reason')?.textContent).toBe('Publish the reviewed release candidate.')
    const actions = [...(bubble?.querySelectorAll<HTMLButtonElement>('.cxa-approval-action') ?? [])]
    expect(actions.map(action => action.dataset.decision)).toEqual(['approve', 'reject'])
    expect(actions.map(action => action.getAttribute('aria-label'))).toEqual(['Approve · Lead', 'Reject · Lead'])
    expect(actions.every(action => action.querySelector('.cordisx-host-icon') !== null)).toBe(true)
    expect(bubble?.textContent).not.toContain('Cancel')
    expect(AGENT_CONVERSATION_STYLES).toContain('@container cxa-conversation (max-width:560px)')
    expect(AGENT_CONVERSATION_STYLES).toContain('var(--cx-surface-raised,var(--cx-surface))')
    expect(AGENT_CONVERSATION_STYLES).toContain('.cxa-approval-action:focus-visible')
  })

  it.each(['approved', 'denied', 'cancelled', 'failed'] as const)('keeps terminal %s on the same item, selected and actionless', state => {
    const model = projectAgentConversationShellSnapshotV7('chatroom', snapshot(approval(state)), { resolve: value => value.fallback })
    const controller = new AgentConversationCommandController({ execute: async () => undefined }, model)
    const document = new JSDOM(renderToString(<AgentConversationRenderer model={model} commands={controller} copy={playgroundConversationCopy('en')} />)).window.document
    const item = document.querySelector('[data-entry-id="approval-v7"]')
    expect(item?.getAttribute('data-selected-outcome')).toBe(state)
    expect(item?.querySelector('.cxa-approval-action')).toBeNull()
    expect(item?.querySelectorAll('button')).toHaveLength(2) // requester author + avatar identity only
    expect(item?.querySelector('.cxa-approval-outcome')?.getAttribute('data-state')).toBe(state)
  })

  it('fails closed for authority substitution, missing binding, cancel, reordered actions, and invokable terminal', () => {
    const pending = approval('pending')
    const candidates = [
      { ...pending, authority: { ...pending.authority, identity: { ...lead, revision: 'stale-lead' } } },
      { ...pending, authorityBinding: undefined },
      { ...pending, actions: [{ decision: 'approve', command: { id: 'approval.answer' } }, { decision: 'cancel', command: { id: 'approval.answer' } }] },
      { ...pending, actions: [...pending.actions].reverse() },
      { ...approval('denied'), actions: [{ decision: 'reject', command: { id: 'approval.answer' } }] },
    ]
    for (const item of candidates) expect(() => projectAgentConversationShellSnapshotV7('chatroom', snapshot(item as never), { resolve: value => value.fallback })).toThrow()
  })

  it('keeps Shell v6 predecessor projection unchanged', () => {
    expect(() => projectAgentConversationShellSnapshotV6('chatroom', snapshot(approval('denied')) as never, { resolve: value => value.fallback })).toThrow()
  })
})
