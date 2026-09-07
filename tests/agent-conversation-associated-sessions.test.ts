import { expect, test } from 'vitest'
import type { AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v12'
import { assertSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-validation-v4.js'
import { projectAgentConversationShellSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-projection.js'

function snapshot(): AgentConversationShellSnapshot {
  return {
    binding: { bindingId: 'binding', ownerGeneration: 'generation' },
    generation: 'room',
    snapshotSequence: 0,
    selection: {
      kind: 'room',
      roomId: 'room-1',
      title: { key: 'room', fallback: 'Original Room' },
      multiParticipant: true,
      participantPresentation: 'host-initials',
      participants: [{
        participantId: 'leader',
        role: 'agent',
        displayName: { key: 'leader', fallback: 'Leader' },
        agentIdentity: { agentId: 'leader', revision: 'original' },
      }],
      associatedSessions: [{
        participantId: 'leader',
        memberId: 'member-1',
        runId: 'run-1',
        sessionId: 'cx-session.original',
        state: 'unloaded',
        details: { kind: 'host', ref: 'opaque-detail' },
      }],
    },
    items: [],
    headerActions: [],
    composer: {
      availability: 'available',
      placeholder: { key: 'send', fallback: 'Send' },
      disabled: { value: false },
      shortcutPolicy: 'enter',
      submit: { id: 'send' },
    },
  }
}

test('v12 retains exact unloaded association independently from live projection and v11 rejects it', () => {
  const value = snapshot()
  expect(() => assertSnapshotV7(value, true, true)).toThrow('associatedSessions')
  const model = projectAgentConversationShellSnapshotV7(
    'chatroom',
    value,
    { resolve: text => text.fallback },
    true,
    true,
    true,
  )
  expect(model.selection).toMatchObject({
    activeRuns: [],
    associatedSessions: [{ sessionId: 'cx-session.original', state: 'unloaded' }],
  })
  expect(model.entries).toEqual([])
})

test('associations reject guessed live states, duplicate Sessions, foreign participants and raw navigation', () => {
  const value = snapshot()
  if (value.selection.kind !== 'room') throw new Error('missing Room')
  const association = value.selection.associatedSessions![0]!
  for (
    const patch of [{ state: 'running' }, { participantId: 'foreign' }, { threadId: 'guessed' }, {
      details: { kind: 'url', ref: 'app://-/local/guessed' },
    }]
  ) {
    expect(() =>
      assertSnapshotV7(
        { ...value, selection: { ...value.selection, associatedSessions: [{ ...association, ...patch }] } },
        true,
        true,
        true,
      )
    ).toThrow()
  }
  expect(() =>
    assertSnapshotV7(
      { ...value, selection: { ...value.selection, associatedSessions: [association, association] } },
      true,
      true,
      true,
    )
  ).toThrow('duplicates')
  expect(() =>
    assertSnapshotV7(
      {
        ...value,
        selection: {
          ...value.selection,
          activeRuns: [{ ...association, state: undefined, lifecycle: { phase: 'active' } }],
        },
      },
      true,
      true,
      true,
    )
  ).toThrow('duplicates')
})
