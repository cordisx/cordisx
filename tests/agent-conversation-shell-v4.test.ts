import type { AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v4'
import { describe, expect, it } from 'vitest'
import { projectAgentConversationShellSnapshotV4 } from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'

const localized = (key: string, fallback: string) => ({ key, fallback })

function snapshot(): AgentConversationShellSnapshot {
  const participant = {
    participantId: 'agent-lead', role: 'agent' as const,
    displayName: localized('agent.lead', 'Lead'),
    agentIdentity: { agentId: 'lead', revision: 'rev-1' },
  }
  return {
    binding: { bindingId: 'binding-v4', ownerGeneration: 'generation-v4' },
    generation: 'session-generation-1', snapshotSequence: 3,
    selection: {
      kind: 'room', roomId: 'room-one', title: localized('room.one', 'Room One'),
      multiParticipant: false, participantPresentation: 'none', participants: [participant],
      activeRuns: [{
        participantId: 'agent-lead', memberId: 'member-lead', runId: 'run-one',
        sessionId: 'session-one', lifecycle: { phase: 'running' },
        details: { kind: 'host', ref: 'codex-thread:native-thread-one' },
      }],
    },
    items: [{
      kind: 'message', itemId: 'item-one', messageId: 'message-one', sequence: 1,
      source: { kind: 'session-event', sessionId: 'session-one', eventSeq: 7 },
      author: participant, semantic: { purpose: 'conversation', correlation: { requestMessageId: 'request-one' } },
      body: [{ kind: 'text', text: localized('message.one', 'Session fact') }], reactions: [],
      timestamp: '2026-09-03T00:00:00.000Z', deliveryState: 'delivered', runState: 'running', ariaLive: 'polite', actions: [],
    }, {
      kind: 'member-presence', itemId: 'presence-one', sequence: 2,
      participantId: 'agent-lead', memberId: 'member-lead', runId: 'run-one', sessionId: 'session-one',
      state: 'ready', retryable: false,
    }, {
      kind: 'approval', itemId: 'approval-one', sequence: 3,
      participantId: 'agent-lead', memberId: 'member-lead', runId: 'run-one',
      sessionId: 'session-one', agentGeneration: 2, approvalId: 'approval-native-one',
      approvalKind: 'command', state: 'pending',
      actions: [{ decision: 'approve', command: { id: 'approval.answer' } }],
    }],
    composer: { availability: 'available', placeholder: localized('composer', 'Message'), disabled: { value: false }, submit: { id: 'message.send' } },
    headerActions: [],
  }
}

describe('Session-compatible Agent conversation Shell v4', () => {
  it('materializes exact Session facts without inventing AgentLoop details, binding, turn, or source', () => {
    const model = projectAgentConversationShellSnapshotV4('chatroom', snapshot(), { resolve: value => value.fallback })
    expect(model.selection).toMatchObject({
      kind: 'room', activeRuns: [{ sessionId: 'session-one', details: { kind: 'host', ref: 'codex-thread:native-thread-one' } }],
    })
    expect(model.entries[0]).toMatchObject({ source: { kind: 'session-event', sessionId: 'session-one', eventSeq: 7 } })
    expect(model.entries[1]).toMatchObject({ sessionId: 'session-one' })
    expect(model.entries[2]).toMatchObject({ sessionId: 'session-one', agentGeneration: 2, approvalId: 'approval-native-one' })
    expect(model.entries[2]).not.toHaveProperty('binding')
    expect(model.entries[2]).not.toHaveProperty('turn')
  })

  it('fails closed when a Shell v4 active run supplies a legacy detailsUrl', () => {
    const input = structuredClone(snapshot()) as unknown as { selection: { activeRuns: Array<Record<string, unknown>> } }
    input.selection.activeRuns[0]!.detailsUrl = { target: 'host', url: 'app://-/legacy' }
    expect(() => projectAgentConversationShellSnapshotV4('chatroom', input as never, { resolve: value => value.fallback })).toThrow(/unknown field detailsUrl/)
  })

  it('accepts the formal sha256 entity revision without broadening other opaque identifiers', () => {
    const input = structuredClone(snapshot())
    input.selection.participants[0]!.agentIdentity!.revision = `sha256:${'a'.repeat(64)}`
    expect(projectAgentConversationShellSnapshotV4('chatroom', input, { resolve: value => value.fallback }).selection)
      .toMatchObject({ kind: 'room', participants: [{ agentIdentity: { revision: `sha256:${'a'.repeat(64)}` } }] })

    input.selection.participants[0]!.agentIdentity!.revision = 'sha256:not-a-digest'
    expect(() => projectAgentConversationShellSnapshotV4('chatroom', input, { resolve: value => value.fallback }))
      .toThrow(/opaque definition revision/)
  })

  it('navigates only exact Host-issued Desktop and deterministic detail refs', async () => {
    const host: string[] = []
    const external: string[] = []
    const navigator = new HostAgentTaskDetailsNavigator({ navigateHost: value => { host.push(value) }, navigateExternal: value => { external.push(value) } })
    await navigator.navigateAgentDetail({ kind: 'host', ref: 'codex-thread:native-thread-one' }, 'session-one')
    await navigator.navigateAgentDetail({ kind: 'host', ref: 'deterministic-agent-session:session-two' }, 'session-two')
    expect(host).toEqual(['app://-/local/native-thread-one', 'app://-/playground/simulator/tasks/session-two'])
    expect(external).toEqual([])
    await expect(Promise.resolve().then(() => navigator.navigateAgentDetail({ kind: 'host', ref: 'https://example.invalid' }, 'session-one'))).rejects.toThrow(/unavailable/)
  })
})
