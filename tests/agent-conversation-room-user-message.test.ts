import { expect, test } from 'vitest'
import type { AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v11'
import { assertSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-validation-v4.js'
import { projectAgentConversationShellSnapshotV7 } from '../packages/cli/src/renderer/agent-conversation-shell-projection.js'

function snapshot(): AgentConversationShellSnapshot {
  const author = { participantId: 'user', role: 'human' as const, displayName: { key: 'user', fallback: 'You' } }
  return {
    binding: { bindingId: 'binding', ownerGeneration: 'generation' },
    generation: 'room-generation',
    snapshotSequence: 2,
    selection: {
      kind: 'room',
      roomId: 'room-1',
      title: { key: 'room', fallback: 'Room' },
      multiParticipant: false,
      participantPresentation: 'none',
      participants: [author],
    },
    items: [{
      kind: 'message',
      itemId: 'message-1',
      messageId: 'message-2',
      sequence: 2,
      author,
      source: { kind: 'room-user-message', roomId: 'room-1', messageId: 'message-2', sequence: 2 },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'user-message', fallback: 'hi' } }],
      reactions: [],
      timestamp: '2026-09-07T00:00:00Z',
      deliveryState: 'sent',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    }],
    composer: {
      availability: 'available',
      placeholder: { key: 'message', fallback: 'Message' },
      disabled: { value: false },
      shortcutPolicy: 'enter',
      submit: { id: 'send' },
    },
    headerActions: [],
  }
}

test('v11 projects durable human input without inventing a Session event; v10 rejects it', () => {
  const value = snapshot()
  expect(() => assertSnapshotV7(value, true)).toThrow('source.kind')
  const model = projectAgentConversationShellSnapshotV7(
    'chatroom',
    value,
    { resolve: value => value.fallback },
    true,
    true,
  )
  expect(model.entries).toMatchObject([{
    kind: 'message',
    itemId: 'message-1',
    messageId: 'message-2',
    authorId: 'user',
    body: ['hi'],
    deliveryState: 'sent',
    source: { kind: 'room-user-message', sequence: 2 },
  }])
  expect(model.selection).toMatchObject({ kind: 'room', participants: [{ id: 'user', role: 'human' }] })
})

test('Room human source rejects foreign Room/identity, fabricated event sequence and Agent authors', () => {
  for (const patch of [{ roomId: 'foreign' }, { messageId: 'foreign' }, { eventSeq: 1 }]) {
    const value = snapshot()
    const item = value.items[0]!
    if (item.kind !== 'message') throw new Error('Missing message fixture')
    expect(() => assertSnapshotV7({ ...value, items: [{ ...item, source: { ...item.source, ...patch } }] }, true, true))
      .toThrow()
  }
  const value = snapshot()
  const item = value.items[0]!
  if (item.kind !== 'message') throw new Error('Missing message fixture')
  expect(() =>
    assertSnapshotV7({ ...value, items: [{ ...item, author: { ...item.author, role: 'agent' } }] }, true, true)
  ).toThrow()
})
