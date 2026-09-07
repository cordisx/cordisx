import { expect, test } from 'vitest'
import type { AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v10'
import { assertItemV7, assertSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-validation-v4.js'
import { projectAgentConversationShellSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-projection.js'

function snapshot(): AgentConversationShellSnapshot {
  const author = {
    participantId: 'participant',
    role: 'agent' as const,
    displayName: { key: 'agent.name', fallback: 'Agent' },
  }
  return {
    binding: { bindingId: 'binding', ownerGeneration: 'generation' },
    generation: 'room-generation',
    snapshotSequence: 2,
    selection: {
      kind: 'room',
      roomId: 'room',
      title: { key: 'room.name', fallback: 'Room' },
      multiParticipant: false,
      participantPresentation: 'none',
      participants: [author],
    },
    items: [{
      kind: 'message',
      itemId: 'cli-message',
      messageId: 'cli-message',
      sequence: 2,
      author,
      source: {
        kind: 'plugin-command',
        roomId: 'room',
        messageId: 'cli-message',
        sessionId: 'session',
        participantId: 'participant',
        memberId: 'member',
        runId: 'run',
        operationId: 'op',
        sequence: 1,
      },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'report', fallback: 'Actual CLI report' } }],
      reactions: [],
      timestamp: '2026-09-07T00:00:00Z',
      deliveryState: 'sent',
      runState: 'idle',
      ariaLive: 'off',
      actions: [{
        id: 'copy',
        label: { key: 'copy', fallback: 'Copy' },
        command: { id: 'copy-message' },
        disabled: { value: false },
      }],
    }],
    composer: {
      availability: 'available',
      placeholder: { key: 'type', fallback: 'Message' },
      disabled: { value: false },
      shortcutPolicy: 'enter',
      submit: { id: 'send' },
    },
    headerActions: [],
  }
}

test('v10 projects a persistent plugin command with existing message body, sender, timestamp and action semantics', () => {
  const value = snapshot()
  expect(() => assertSnapshotV7(value, true)).not.toThrow()
  const model = projectAgentConversationShellSnapshotV7('plugin', value, { resolve: text => text.fallback }, true)
  expect(model.entries[0]).toMatchObject({
    kind: 'message',
    messageId: 'cli-message',
    authorId: 'participant',
    body: ['Actual CLI report'],
    timestamp: '2026-09-07T00:00:00Z',
    actions: [{ id: 'copy' }],
    source: { kind: 'plugin-command', sequence: 1 },
  })
  expect(() => assertItemV7(value.items[0], 'item')).toThrow('source.kind')
})

test('cross-Room, sender mismatch and fabricated SessionEvent fields are rejected', () => {
  for (
    const patch of [{ roomId: 'foreign' }, { participantId: 'foreign' }, { eventSeq: 123 }, { messageId: 'foreign' }]
  ) {
    const value = snapshot()
    const item = value.items[0]!
    if (item.kind !== 'message') throw new Error('fixture message missing')
    const mutated = { ...value, items: [{ ...item, source: { ...item.source, ...patch } }] }
    expect(() => assertSnapshotV7(mutated, true)).toThrow()
  }
})
