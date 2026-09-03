import type { AgentConversationShellSnapshot } from '@cordisx/protocol/agent-conversation-shell/v5'
import { describe, expect, it } from 'vitest'
import {
  CordisXAgentConversationShellService,
  projectAgentConversationShellSnapshotV4,
  projectAgentConversationShellSnapshotV5,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'

const localized = (key: string, fallback: string) => ({ key, fallback })

function snapshot(shortcutPolicy: 'enter' | 'mod-enter'): AgentConversationShellSnapshot {
  return {
    binding: { bindingId: 'binding-v5', ownerGeneration: 'owner-v5' },
    generation: 'snapshot-v5',
    snapshotSequence: 0,
    selection: { kind: 'no-room' },
    items: [],
    composer: {
      availability: 'available',
      placeholder: localized('composer', 'Message'),
      disabled: { value: false },
      shortcutPolicy,
      submit: { id: 'message.send' },
    },
    headerActions: [],
  }
}

describe('Agent conversation Shell v5 shortcut projection', () => {
  it('exposes an additive v5 source registration without removing v4', () => {
    expect(CordisXAgentConversationShellService.prototype.registerSourceV4).toBeTypeOf('function')
    expect(CordisXAgentConversationShellService.prototype.registerSourceV5).toBeTypeOf('function')
  })

  it.each(['enter', 'mod-enter'] as const)('retains the exact %s policy and sole submit command', shortcutPolicy => {
    const model = projectAgentConversationShellSnapshotV5('chatroom', snapshot(shortcutPolicy), {
      resolve: value => value.fallback,
    })
    expect(model.composer).toMatchObject({ shortcutPolicy, submit: { id: 'message.send' } })
    expect(Object.isFrozen(model.composer)).toBe(true)
  })

  it('fails closed for missing or unknown v5 policy while v4 explicitly migrates to enter', () => {
    const missing = structuredClone(snapshot('enter')) as unknown as { composer: Record<string, unknown> }
    delete missing.composer.shortcutPolicy
    expect(() => projectAgentConversationShellSnapshotV5('chatroom', missing as never, { resolve: value => value.fallback }))
      .toThrow(/shortcutPolicy/)

    const unknown = structuredClone(snapshot('enter')) as unknown as { composer: { shortcutPolicy: unknown } }
    unknown.composer.shortcutPolicy = 'spacebar'
    expect(() => projectAgentConversationShellSnapshotV5('chatroom', unknown as never, { resolve: value => value.fallback }))
      .toThrow(/shortcutPolicy is invalid/)

    const { shortcutPolicy: _shortcutPolicy, ...composer } = snapshot('enter').composer
    const v4 = projectAgentConversationShellSnapshotV4('chatroom', {
      ...snapshot('enter'),
      composer,
    }, { resolve: value => value.fallback })
    expect(v4.composer.shortcutPolicy).toBe('enter')
  })
})
