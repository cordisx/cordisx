import { readFile } from 'node:fs/promises'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { HostRoomCompositeAvatar } from '../packages/cli/src/renderer/host-ui/conversation/RoomCompositeAvatar.js'
import {
  AgentConversationCommandController,
  type AgentConversationCommandRequest,
} from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import {
  createAgentConversationModel,
  type AgentConversationModel,
} from '../packages/cli/src/renderer/host-ui/conversation/model.js'
import {
  createPlaygroundConversationFixture,
  playgroundConversationCopy,
} from '../packages/cli/src/playground/client/fixtures/agent-conversation.js'

interface RenderHarness {
  readonly dom: JSDOM
  readonly root: Root
  close(): Promise<void>
}

const previousGlobals = new Map<string, unknown>()

async function render(model: AgentConversationModel, commands: AgentConversationCommandController, debugFixture = false): Promise<RenderHarness> {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN" data-theme="dark"><body><div id="root"></div></body></html>', { url: 'https://host.invalid/' })
  const globals = {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    if (!previousGlobals.has(key)) previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  })
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => root.render(<AgentConversationRenderer
    model={model}
    commands={commands}
    copy={playgroundConversationCopy('zh-CN')}
    debugFixture={debugFixture}
  />))
  return {
    dom,
    root,
    async close() {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
})

describe('AgentConversation renderer model', () => {
  it('validates, clones, and deeply freezes the private projection without avatar/media/component fields', () => {
    const input = createPlaygroundConversationFixture('conversation', 'en')
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.entries)).toBe(true)
    expect(Object.isFrozen(input.selection)).toBe(true)
    expect(() => createAgentConversationModel({
      ...input,
      selection: {
        ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
        participants: [{ id: 'agent', role: 'agent', name: 'Agent', avatarUrl: 'https://unsafe.invalid/avatar.png' }],
      } as AgentConversationModel['selection'],
      entries: [],
    })).toThrow('unknown field avatarUrl')
    const generated = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'renderer-agent' })
    const withAvatar = createAgentConversationModel({
      ...input,
      selection: {
        ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
        participants: [{ id: 'agent', role: 'agent', name: 'Agent', avatar: generated }],
      },
      entries: [],
    })
    expect(withAvatar.selection.kind === 'room' ? withAvatar.selection.participants[0]?.avatar : undefined).toEqual(generated)
    expect(() => createAgentConversationModel({
      ...input,
      selection: {
        ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
        participants: [{ id: 'agent', role: 'agent', name: 'Agent', avatar: { kind: 'asset', ref: 'https://unsafe.invalid/avatar.png' } as never }],
      },
      entries: [],
    })).toThrow('qualified opaque ref')
    expect(() => createAgentConversationModel({
      ...input,
      selection: {
        kind: 'room', roomId: 'room', title: 'Room', multiParticipant: false,
        participantPresentation: 'host-initials', participants: [],
      },
      entries: [],
    })).toThrow('single-participant rooms cannot request participant initials')
  })

  it('preserves no-room as an empty timeline with a composer and forbids CTA/header action state', () => {
    const valid = createPlaygroundConversationFixture('empty', 'en')
    expect(valid.selection).toEqual({ kind: 'no-room' })
    expect(valid.entries).toHaveLength(0)
    expect(valid.headerActions).toHaveLength(0)
    expect(valid.composer).toMatchObject({
      availability: 'available', disabled: false, submit: { id: 'room.create-with-message' },
    })
    expect(() => createAgentConversationModel({
      ...valid,
      selection: { kind: 'no-room', newRoomAction: { id: 'new-room' } } as unknown as AgentConversationModel['selection'],
    })).toThrow('unknown field newRoomAction')
    expect(() => createAgentConversationModel({
      ...valid,
      headerActions: [{ id: 'settings', label: 'Settings', command: { id: 'room.settings' }, disabled: false }],
    })).toThrow('forbids header actions')
    expect(() => createAgentConversationModel({
      ...valid,
      entries: [{ kind: 'status', itemId: 'wrong-scope-new-room', sequence: 1, label: 'New room', state: 'info', ariaLive: 'off' }],
    })).toThrow('no-room selection cannot contain timeline entries')
  })

  it('does not write into caller data while validating the no-room discriminator', () => {
    const input = structuredClone(createPlaygroundConversationFixture('empty', 'en'))
    const before = JSON.stringify(input)
    const model = createAgentConversationModel(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(model).not.toBe(input)
    expect(model.binding).not.toBe(input.binding)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(model)).toBe(true)
  })

  it('generates exact Host command contexts and bounded composer text without putting callbacks in the model', async () => {
    const requests: AgentConversationCommandRequest[] = []
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      composer: { availability: 'available', placeholder: 'Message', disabled: false, submit: { id: 'room.send' } },
      headerActions: [{ id: 'refresh', label: 'Refresh', icon: 'host:refresh', command: { id: 'room.refresh' }, disabled: false }],
    })
    const controller = new AgentConversationCommandController({ execute: async request => { requests.push(request) } }, model)
    await controller.runHeader(model, model.headerActions[0]!)
    await controller.runComposer(model, '  hello room  ')
    expect(requests).toEqual([
      {
        ownerId: model.ownerId, shell: 'agent-desktop', invocationKey: 'header:refresh', reference: { id: 'room.refresh' },
        context: { binding: model.binding, generation: model.generation, scope: 'header', command: { id: 'room.refresh' } },
      },
      {
        ownerId: model.ownerId, shell: 'agent-desktop', invocationKey: 'composer-submit', reference: { id: 'room.send' },
        context: {
          binding: model.binding, generation: model.generation, scope: 'composer-submit',
          command: { id: 'room.send' }, submitPayload: '  hello room  ',
        },
      },
    ])
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen(requests[0]?.context)).toBe(true)
    expect(Object.isFrozen(requests[0]?.context.binding)).toBe(true)
    expect(Object.isFrozen(requests[0]?.reference)).toBe(true)
    expect(Object.isFrozen(requests[0]?.context.command)).toBe(true)
    expect(() => controller.runComposer(model, '')).toThrow('1 to 65536')
    expect(() => controller.runComposer(model, 'a'.repeat(65_537))).toThrow('1 to 65536')
  })

  it('rejects stale, cross-shell, cross-binding, cross-generation, wrong-scope, and non-canonical item commands', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const firstMessage = base.entries.find(entry => entry.kind === 'message')!
    const messageAction = { id: 'retry', label: 'Retry', command: { id: 'room.retry' }, disabled: false } as const
    const model = createAgentConversationModel({
      ...base,
      composer: { availability: 'available', placeholder: 'Message', disabled: false, submit: { id: 'room.send' } },
      headerActions: [{ id: 'refresh', label: 'Refresh', command: { id: 'room.refresh' }, disabled: false }],
      entries: base.entries.map(entry => entry === firstMessage ? { ...entry, actions: [messageAction] } : entry),
    })
    const requests: AgentConversationCommandRequest[] = []
    const controller = new AgentConversationCommandController({ execute: async request => { requests.push(request) } }, model)
    const canonicalMessage = model.entries.find(entry => entry.kind === 'message' && entry.itemId === firstMessage.itemId)!
    const canonicalMessageAction = canonicalMessage.kind === 'message' ? canonicalMessage.actions[0]! : messageAction
    await controller.runMessage(model, canonicalMessage.itemId, canonicalMessageAction)
    expect(requests[0]?.context).toEqual({
      binding: model.binding,
      generation: model.generation,
      scope: 'message',
      itemId: canonicalMessage.itemId,
      command: canonicalMessageAction.command,
    })
    expect('submitPayload' in requests[0]!.context).toBe(false)
    expect(() => controller.runHeader(model, canonicalMessageAction)).toThrow('not in the current model')
    expect(() => controller.runMessage(model, canonicalMessage.itemId, model.headerActions[0]!)).toThrow('not in the current model')
    expect(() => controller.runMessage(model, 'not-the-canonical-item', canonicalMessageAction)).toThrow('not in the current model')
    expect(() => controller.runHeader({ ...model, ownerId: 'other-owner' }, model.headerActions[0]!))
      .toThrow('owner fence')
    expect(() => controller.runHeader({ ...model, shell: 'wrong-shell' } as unknown as AgentConversationModel, model.headerActions[0]!))
      .toThrow('shell fence')
    expect(() => controller.runHeader({ ...model, binding: { ...model.binding, bindingId: 'other-binding' } }, model.headerActions[0]!))
      .toThrow('binding fence')
    expect(() => controller.runHeader({ ...model, binding: { ...model.binding, ownerGeneration: 'other-owner-generation' } }, model.headerActions[0]!))
      .toThrow('owner generation fence')
    expect(() => controller.runHeader({ ...model, generation: 'other-snapshot-generation' }, model.headerActions[0]!))
      .toThrow('snapshot generation fence')
    expect(() => controller.runHeader({ ...model, snapshotSequence: model.snapshotSequence + 1 }, model.headerActions[0]!))
      .toThrow('stale snapshot')
  })

  it('deep-clones hostile nested command data before asynchronous executor observation', async () => {
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      headerActions: [{
        id: 'inspect',
        label: 'Inspect',
        command: { id: 'room.inspect', arguments: { nested: { value: 'original' } } },
        disabled: false,
      }],
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let observed: AgentConversationCommandRequest | undefined
    const controller = new AgentConversationCommandController({
      async execute(request) {
        await gate
        observed = request
      },
    }, model)
    const hostile = structuredClone(model)
    const pending = controller.runHeader(hostile, hostile.headerActions[0]!)
    ;(hostile.binding as { bindingId: string }).bindingId = 'mutated-after-dispatch'
    const hostileArguments = hostile.headerActions[0]!.command.arguments as { nested: { value: string } }
    hostileArguments.nested.value = 'mutated-after-dispatch'
    release()
    await pending
    expect(observed?.context.binding.bindingId).toBe(model.binding.bindingId)
    expect((observed?.reference.arguments as { nested: { value: string } }).nested.value).toBe('original')
    expect((observed?.context.command.arguments as { nested: { value: string } }).nested.value).toBe('original')
    expect(observed?.reference).not.toBe(hostile.headerActions[0]!.command)
    expect(observed?.context.binding).not.toBe(hostile.binding)
    expect(Object.isFrozen(observed)).toBe(true)
    expect(Object.isFrozen(observed?.context)).toBe(true)
    expect(Object.isFrozen(observed?.context.binding)).toBe(true)
    expect(Object.isFrozen(observed?.reference)).toBe(true)
    expect(Object.isFrozen(observed?.reference.arguments)).toBe(true)
    expect(Object.isFrozen((observed?.reference.arguments as { nested: object }).nested)).toBe(true)
    expect(Object.isFrozen(observed?.context.command)).toBe(true)
    expect(Object.isFrozen(observed?.context.command.arguments)).toBe(true)
  })
})

describe('AgentConversationRenderer production DOM', () => {
  it('owns the only title/actions, timeline scroll, statuses, initials opt-in, and unavailable fixed composer', async () => {
    const model = createPlaygroundConversationFixture('conversation', 'zh-CN')
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      true,
    )
    try {
      const document = harness.dom.window.document
      expect(document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull()
      expect(document.querySelector('[data-agent-conversation-fixture="debug-only"]')).not.toBeNull()
      expect(document.querySelectorAll('.cxa-chrome')).toHaveLength(1)
      expect(document.querySelectorAll('h1')).toHaveLength(1)
      expect(document.querySelector('h1')?.textContent).toBe('多 Agent 发布评审')
      expect(document.querySelectorAll('h2')).toHaveLength(0)
      expect(document.querySelector('.cxa-participants')).toBeNull()
      expect(document.querySelector('.cxa-description-action')?.textContent).toBe('添加群聊介绍')
      expect([...document.querySelectorAll('.cxa-header-actions .cxa-header-icon-action')].map(button => button.getAttribute('aria-label'))).toEqual(['群成员', '设置', '更多'])
      expect(document.querySelectorAll('[role="log"]')).toHaveLength(1)
      expect(document.querySelector('[role="log"]')?.getAttribute('data-agent-conversation-scroll-owner')).toBe('timeline')
      expect(document.querySelectorAll('.cxa-status')).toHaveLength(3)
      expect(document.querySelectorAll('.cxa-room-avatar-cell')).toHaveLength(0)
      expect(document.querySelector('.cxa-room-avatar-fallback')).not.toBeNull()
      expect(document.querySelector<HTMLElement>('.cxa-room-avatar')?.dataset.avatarCount).toBe('0')
      expect(document.querySelectorAll('.cxa-avatar')).toHaveLength(3)
      for (const label of ['群成员', '设置', '更多']) {
        await act(async () => document.querySelector<HTMLButtonElement>(`.cxa-header-icon-action[aria-label="${label}"]`)!.click())
        expect(document.querySelectorAll('[data-host-conversation-inspector="true"]')).toHaveLength(1)
        expect(document.querySelector('.cx-conversation-inspector-title')?.textContent).toContain(label === '设置' ? '群聊设置' : label)
      }
      expect(document.querySelector('[data-agent-conversation-composer]')?.getAttribute('data-agent-conversation-composer')).toBe('fixed')
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      expect(draft.disabled).toBe(true)
      expect(send.disabled).toBe(true)
      expect(draft.getAttribute('aria-describedby')).toBe(send.getAttribute('aria-describedby'))
      expect(document.getElementById(draft.getAttribute('aria-describedby')!)?.textContent).toContain('Connector')
      expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
    } finally {
      await harness.close()
    }
  })

  it('renders the room composite independently from message-avatar opt-in and presents no-room as an empty usable composer', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const singleParticipant = room.participants[1]!
    const message = base.entries.find(entry => entry.kind === 'message' && entry.authorId === singleParticipant.id)!
    const single = createAgentConversationModel({
      ...base,
      selection: {
        kind: 'room', roomId: 'single-room', title: 'Single task', multiParticipant: false,
        participantPresentation: 'none', participants: [singleParticipant],
      },
      entries: [message],
      headerActions: [],
    })
    const controller = new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, single)
    const roomHarness = await render(single, controller)
    try {
      expect(roomHarness.dom.window.document.querySelectorAll('.cxa-room-avatar-cell .cxa-avatar')).toHaveLength(0)
      expect(roomHarness.dom.window.document.querySelector('.cxa-room-avatar-fallback')).not.toBeNull()
      expect(roomHarness.dom.window.document.querySelectorAll('.cxa-message > .cxa-avatar')).toHaveLength(0)
    } finally {
      await roomHarness.close()
    }
    const empty = createPlaygroundConversationFixture('empty', 'zh-CN')
    const requests: AgentConversationCommandRequest[] = []
    const emptyHarness = await render(empty, new AgentConversationCommandController({
      execute: async request => { requests.push(request) },
    }, empty), true)
    try {
      const document = emptyHarness.dom.window.document
      expect(document.querySelector('h1')?.textContent).toBe('空会话测试场景')
      expect(document.querySelectorAll('h2')).toHaveLength(0)
      expect(document.querySelectorAll('.cxa-action')).toHaveLength(0)
      expect(document.querySelectorAll('[data-agent-conversation-empty],.cxa-empty-mark,.cxa-empty-copy')).toHaveLength(0)
      expect(document.querySelectorAll('[role="log"]')).toHaveLength(1)
      expect(document.querySelectorAll('.cxa-timeline-list > *')).toHaveLength(0)
      expect(document.querySelectorAll('.cxa-composer')).toHaveLength(1)
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      expect(draft.disabled).toBe(false)
      expect(send.disabled).toBe(true)
      const valueSetter = Object.getOwnPropertyDescriptor(emptyHarness.dom.window.HTMLTextAreaElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(draft, '第一条消息')
        draft.dispatchEvent(new emptyHarness.dom.window.Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      expect(send.disabled).toBe(false)
      await act(async () => {
        send.click()
        await Promise.resolve()
      })
      expect(requests[0]).toMatchObject({
        invocationKey: 'composer-submit',
        reference: { id: 'room.create-with-message' },
        context: { scope: 'composer-submit', submitPayload: '第一条消息' },
      })
    } finally {
      await emptyHarness.close()
    }
  })

  it('renders every reaction with its exact actor name, value, state, and localized accessible name', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'zh-CN')
    const human = base.entries.find(entry => entry.kind === 'message' && entry.authorId === 'human-reviewer')!
    const generated = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'agent-alpha' })
    const model = createAgentConversationModel({
      ...base,
      selection: base.selection.kind !== 'room' ? base.selection : {
        ...base.selection,
        participants: base.selection.participants.map(participant => participant.id === 'agent-alpha'
          ? { ...participant, avatar: generated }
          : participant.id === 'agent-beta'
            ? { ...participant, avatar: { kind: 'definition' as const, ref: 'avatar-definitions:agent-beta', schema: 'oneworks.avatar', definitionVersion: 1 } }
            : participant),
      },
      entries: base.entries.map(entry => entry === human ? {
        ...entry,
        reactions: [
          { reactionId: 'reaction-alpha', actorParticipantId: 'agent-alpha', value: { kind: 'emoji', emoji: '✅' }, state: 'completed' },
          { reactionId: 'reaction-beta', actorParticipantId: 'agent-beta', value: { kind: 'emoji', emoji: '✅' }, state: 'pending' },
        ],
      } : entry),
    })
    const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
    try {
      const reactions = [...harness.dom.window.document.querySelectorAll<HTMLElement>('.cxa-message-reaction')]
      expect(reactions).toHaveLength(2)
      expect(reactions.every(reaction => reaction.closest('.cxa-message-surface') !== null)).toBe(true)
      expect(reactions.map(reaction => reaction.querySelector('.cxa-message-reaction-actor')?.textContent)).toEqual(['Agent Alpha', 'Agent Beta'])
      expect(reactions.map(reaction => reaction.querySelector('.cxa-message-reaction-value')?.textContent)).toEqual(['✅', '✅'])
      expect(reactions.map(reaction => reaction.getAttribute('aria-label'))).toEqual([
        'Agent Alpha 的反应：✅，已完成',
        'Agent Beta 的反应：✅，处理中',
      ])
      expect(reactions.map(reaction => reaction.dataset.reactionState)).toEqual(['completed', 'pending'])
      expect(reactions.map(reaction => [...reaction.children].map(child => child.className))).toEqual([
        ['cxa-message-reaction-avatar', 'cxa-message-reaction-actor', 'cxa-message-reaction-value'],
        ['cxa-message-reaction-avatar', 'cxa-message-reaction-actor', 'cxa-message-reaction-value'],
      ])
      const avatars = reactions.map(reaction => reaction.querySelector<HTMLElement>('.cxa-avatar')!)
      expect(avatars.map(avatar => avatar.getAttribute('aria-hidden'))).toEqual(['true', 'true'])
      expect(avatars.map(avatar => avatar.dataset.avatarKind)).toEqual(['generated', 'definition'])
      expect(avatars.map(avatar => avatar.dataset.avatarState)).toEqual(['fallback', 'fallback'])
      expect(avatars[1]).toMatchObject({ textContent: 'AB' })
      expect(avatars[1]?.dataset.avatarCode).toBe('reference-unavailable')
      expect(reactions.flatMap(reaction => [...reaction.querySelectorAll('button')])).toHaveLength(0)

      const markup = renderToString(<AgentConversationRenderer
        model={model}
        commands={new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model)}
        copy={playgroundConversationCopy('zh-CN')}
      />)
      const server = new JSDOM(markup).window.document
      const serverReactions = [...server.querySelectorAll('.cxa-message-reaction')]
      expect(serverReactions).toHaveLength(2)
      expect(serverReactions.map(reaction => reaction.querySelector('.cxa-message-reaction-avatar')?.nextElementSibling?.textContent)).toEqual(['Agent Alpha', 'Agent Beta'])
      expect(serverReactions.flatMap(reaction => [...reaction.querySelectorAll('button')])).toHaveLength(0)
      expect(() => createAgentConversationModel({
        ...base,
        entries: base.entries.map(entry => entry === human ? {
          ...entry,
          reactions: [{ reactionId: 'reaction-unknown', actorParticipantId: 'unknown-agent', value: { kind: 'emoji', emoji: '✅' }, state: 'completed' }],
        } : entry),
      })).toThrow('actor is unknown')
    } finally {
      await harness.close()
    }
  })

  it('keeps outgoing user bubbles free of a fixed author/time/state meta row', async () => {
    const model = createPlaygroundConversationFixture('conversation', 'en')
    const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
    try {
      const human = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="human"]')!
      expect(human.querySelector('.cxa-message-meta')).toBeNull()
      expect(human.querySelector('.cxa-message-body')?.textContent).toContain('Review the Host-owned conversation shell')
      expect(human.textContent).not.toContain('You')
      const agents = [...harness.dom.window.document.querySelectorAll('.cxa-message[data-role="agent"]')]
      expect(agents.every(message => message.querySelector('.cxa-message-meta') !== null)).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('uses opposite transparent rows with an outer circular Agent avatar and one content-sized incoming surface', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const firstAgent = base.entries.find(entry => entry.kind === 'message' && entry.authorId === 'agent-alpha')!
    const model = createAgentConversationModel({
      ...base,
      entries: base.entries.map(entry => entry === firstAgent ? {
        ...entry,
        source: 'chatroom-acknowledgement' as const,
        body: ['I will take a look.\nA long second line remains inside the same bubble.'],
      } : entry),
    })
    const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
    try {
      const agent = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="agent"]')!
      const outgoing = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="human"]')!
      expect(agent.children[0]?.classList.contains('cxa-avatar')).toBe(true)
      expect(agent.querySelector('.cxa-message-content > .cxa-message-meta + .cxa-message-surface')).not.toBeNull()
      expect(agent.querySelector('.cxa-message-surface')?.textContent).toContain('A long second line')
      expect(outgoing.querySelector('.cxa-message-content > .cxa-message-surface')).not.toBeNull()
      expect(harness.dom.window.getComputedStyle(agent).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
      const incomingSurface = harness.dom.window.getComputedStyle(agent.querySelector<HTMLElement>('.cxa-message-surface')!)
      expect(incomingSurface.paddingTop).toBe('10px')
      const styles = harness.dom.window.document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles]')!.textContent!
      expect(styles).toContain('.cxa-message-content{width:fit-content;gap:3px}')
      expect(styles).toContain('.cxa-message[data-role="agent"] .cxa-message-content{justify-items:start}')
      expect(styles).toContain('.cxa-message[data-role="human"] .cxa-message-surface')
      expect(styles).toContain('width:fit-content;max-width:100%;gap:7px;padding:10px 13px')
      expect(styles).toContain('border-radius:15px 15px 15px 4px')
    } finally {
      await harness.close()
    }
  })

  it('projects exact participant order into 0/1/2/3/4/7 composite avatars and opens the shared members inspector', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    for (const count of [0, 1, 2, 3, 4, 7]) {
      const participants = Array.from({ length: count }, (_, index) => ({
        id: `agent-${index}`,
        role: 'agent' as const,
        name: `Agent ${index}`,
        avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: `agent-${index}` }),
      }))
      const model = createAgentConversationModel({
        ...base,
        selection: { ...room, roomId: `room-${count}`, participants },
        entries: [],
        headerActions: [],
      })
      const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
      try {
        const composite = harness.dom.window.document.querySelector<HTMLElement>('.cxa-room-avatar')!
        expect(composite.dataset.participantCount).toBe(String(count))
        expect(composite.dataset.avatarCount).toBe(String(count))
        expect([...composite.querySelectorAll<HTMLElement>('.cxa-room-avatar-cell')].map(cell => cell.dataset.participantId))
          .toEqual(participants.slice(0, count >= 4 ? 3 : count).map(participant => participant.id))
        expect(composite.querySelectorAll('.cxa-room-avatar-cell')).toHaveLength(count >= 4 ? 3 : count)
        expect([...composite.querySelectorAll('.cxa-room-avatar-cell')].every(cell => cell.firstElementChild?.classList.contains('cxa-avatar'))).toBe(true)
        expect(harness.dom.window.document.querySelector('.cxa-room-avatar-more')?.textContent ?? '').toBe(count >= 4 ? `+${count - 3}` : '')
        const button = harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-button')!
        const beforeFocus = harness.dom.window.getComputedStyle(button)
        expect(beforeFocus.backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
        expect(beforeFocus.borderTopWidth).toBe('0px')
        expect(beforeFocus.paddingTop).toBe('0px')
        expect(beforeFocus.boxShadow).toBe('none')
        const sizeBeforeFocus = [beforeFocus.width, beforeFocus.height]
        button.focus()
        const afterFocus = harness.dom.window.getComputedStyle(button)
        expect([afterFocus.width, afterFocus.height]).toEqual(sizeBeforeFocus)
        if (count === 7) {
          const styles = harness.dom.window.document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles]')!.textContent!
          expect(styles).toContain('.cxa-room-avatar[data-count="many"] .cxa-room-avatar-cell[data-index="1"]{right:1px;top:0;z-index:4}')
          expect(styles).toContain('.cxa-room-avatar-more{appearance:none;position:absolute;right:1px;bottom:0;z-index:2')
        }
        const opener = count >= 4
          ? harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-more')!
          : harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-button')!
        await act(async () => opener.click())
        expect(harness.dom.window.document.querySelector('[data-host-conversation-inspector="true"]')).not.toBeNull()
        expect(harness.dom.window.document.querySelectorAll('.cxa-member-button')).toHaveLength(count)
      } finally {
        await harness.close()
      }
    }
    const mixedParticipants = [
      { id: 'without-a', role: 'agent' as const, name: 'Without A' },
      { id: 'with-b', role: 'agent' as const, name: 'With B', avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'with-b' }) },
      { id: 'without-c', role: 'human' as const, name: 'Without C' },
      { id: 'with-d', role: 'agent' as const, name: 'With D', avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'with-d' }) },
    ]
    const mixed = createAgentConversationModel({
      ...base,
      selection: { ...room, roomId: 'room-mixed', participants: mixedParticipants },
      entries: [],
      headerActions: [],
    })
    const mixedHarness = await render(mixed, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, mixed))
    try {
      const composite = mixedHarness.dom.window.document.querySelector<HTMLElement>('.cxa-room-avatar')!
      expect(composite.dataset.participantCount).toBe('4')
      expect(composite.dataset.avatarCount).toBe('2')
      expect([...composite.querySelectorAll<HTMLElement>('.cxa-room-avatar-cell')].map(cell => cell.dataset.participantId)).toEqual(['with-b', 'with-d'])
      const more = mixedHarness.dom.window.document.querySelector<HTMLElement>('.cxa-room-avatar-more')!
      expect(more.textContent).toBe('+2')
      expect(mixedHarness.dom.window.getComputedStyle(more).borderTopWidth).toBe('0px')
      expect(mixedHarness.dom.window.getComputedStyle(more).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
      expect([...composite.querySelectorAll<HTMLElement>('.cxa-room-avatar-cell')].every(cell => mixedHarness.dom.window.getComputedStyle(cell).borderTopWidth === '0px')).toBe(true)
    } finally {
      await mixedHarness.close()
    }
    const compact = new JSDOM(renderToString(<HostRoomCompositeAvatar
      participants={mixedParticipants}
      size="compact"
      label="Open compact members"
      moreLabel={count => `${count} more`}
      onOpen={() => undefined}
    />)).window.document
    expect(compact.querySelector('[data-room-avatar-size="compact"]')).not.toBeNull()
    expect([...compact.querySelectorAll<HTMLElement>('.cxa-room-avatar-cell')].map(cell => cell.dataset.participantId)).toEqual(['with-b', 'with-d'])
    expect(compact.querySelector('.cxa-room-avatar-more')?.textContent).toBe('+2')
  })

  it('always renders an explicit Agent avatar outside the incoming bubble while identity actions require an exact presentation', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const agent = room.participants.find(participant => participant.role === 'agent')!
    const message = base.entries.find(entry => entry.kind === 'message' && entry.authorId === agent.id)!
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'explicit-agent-avatar' })
    const model = createAgentConversationModel({
      ...base,
      selection: {
        ...room,
        multiParticipant: false,
        participantPresentation: 'none',
        participants: [{ ...agent, avatar }],
      },
      entries: [message],
      headerActions: [],
    })
    const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
    try {
      const incoming = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="agent"]')!
      expect(incoming.children[0]?.classList.contains('cxa-avatar')).toBe(true)
      expect(incoming.children[0]?.getAttribute('data-avatar-kind')).toBe('generated')
      expect(incoming.querySelector('.cx-agent-identity-avatar-button')).toBeNull()
      expect(incoming.querySelector('.cxa-message-surface')).not.toBeNull()
      expect(incoming.querySelector('.cxa-message-surface')?.contains(incoming.children[0]!)).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('keeps Host-owned draft state, submit, and focus order outside the immutable model', async () => {
    const requests: AgentConversationCommandRequest[] = []
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      composer: { availability: 'available', placeholder: 'Write a message', disabled: false, submit: { id: 'room.send' } },
      headerActions: [{ id: 'refresh', label: 'Refresh', icon: 'host:refresh', command: { id: 'room.refresh' }, disabled: false }],
    })
    const controller = new AgentConversationCommandController({ execute: async request => { requests.push(request) } }, model)
    const harness = await render(model, controller)
    try {
      const document = harness.dom.window.document
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      const valueSetter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(draft, 'hello from draft')
        draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
        draft.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      expect(send.disabled).toBe(false)
      expect(JSON.stringify(model)).not.toContain('hello from draft')
      await act(async () => {
        send.click()
        await Promise.resolve()
      })
      expect(requests[0]?.context).toMatchObject({ scope: 'composer-submit', submitPayload: 'hello from draft' })
      expect(draft.value).toBe('')
      const focusOrder = [...document.querySelectorAll<HTMLElement>('.cxa-header-actions button,[role="log"],.cxa-draft,.cxa-send')]
      expect(focusOrder.map(element => element.className)).toEqual(['cxa-header-icon-action', 'cxa-header-icon-action', 'cxa-header-icon-action', 'cxa-timeline', 'cxa-draft', 'cxa-send'])
    } finally {
      await harness.close()
    }
  })

  it('shares one content bound and spacing token across header, timeline, entries, and fixed composer', async () => {
    const model = createPlaygroundConversationFixture('conversation', 'en')
    const harness = await render(model, new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model))
    try {
      const document = harness.dom.window.document
      expect(document.querySelector('.cxa-chrome > .cxa-chrome-inner')).not.toBeNull()
      expect(document.querySelector('.cxa-timeline > .cxa-timeline-list')).not.toBeNull()
      expect(document.querySelector('.cxa-composer-region > .cxa-composer')).not.toBeNull()
      expect(document.querySelectorAll('.cxa-timeline')).toHaveLength(1)
      expect(document.querySelectorAll('.cxa-timeline-list > .cxa-entry')).toHaveLength(model.entries.length)

      const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles="production"]')!.textContent!
      expect(styles).toContain('--cxa-content-max:780px;--cxa-content-space:var(--cx-space-6,24px)')
      expect(styles).toContain('--cxa-header-height:68px;--cxa-inspector-width:360px;container:cxa-conversation/inline-size')
      expect(styles).toContain('height:var(--cxa-header-height)')
      expect(styles).toContain('.cxa-chrome-inner{display:grid;width:min(100%,var(--cxa-content-max))')
      expect(styles).toContain('.cxa-timeline{min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;')
      expect(styles).toContain('padding:var(--cxa-content-space)')
      expect(styles).toContain('.cxa-timeline-list{display:flex;width:min(100%,var(--cxa-content-max))')
      expect(styles).toContain('justify-content:flex-start;gap:var(--cxa-content-space);margin:0 auto;padding:0')
      expect(styles).toContain('.cxa-entry{min-width:0;margin:0}')
      expect(styles).toContain('.cxa-composer{display:grid;width:min(100%,var(--cxa-content-max))')
      expect(styles).toContain('.cxa-message[data-group-start="false"]>.cxa-avatar,.cxa-message[data-group-start="false"]>.cx-agent-identity-avatar-button{visibility:hidden}')
      expect(styles).not.toContain('.cxa-message[data-group-start="false"] .cxa-avatar')
      expect(styles).not.toContain('margin-top:-14px')
      expect(styles).not.toMatch(/\.cxa-timeline-list\{[^}]*space-(?:between|around)/u)
      expect(styles).not.toMatch(/\.cxa-timeline-list\{[^}]*flex-grow/u)
      expect(styles).toContain('@container cxa-conversation (min-width:900px)')
      expect(styles).toContain('grid-template-columns:minmax(0,1fr) var(--cxa-inspector-width)')
      expect(styles).toContain('.cx-conversation-inspector-layer{position:absolute;inset:0')

      const contentBounds = (viewportWidth: number): { left: number; right: number; width: number } => {
        const gutter = 24
        const width = Math.min(780, viewportWidth - (2 * gutter))
        const left = (viewportWidth - width) / 2
        return { left, right: viewportWidth - left, width }
      }
      for (const viewportWidth of [998, 1_079, 1_371]) {
        for (const panelOpen of [false, true]) {
          const available = panelOpen ? viewportWidth - 360 : viewportWidth
          const header = contentBounds(available)
          const timeline = contentBounds(available)
          const composer = contentBounds(available)
          expect(Math.abs(header.left - timeline.left)).toBeLessThanOrEqual(1)
          expect(Math.abs(header.right - composer.right)).toBeLessThanOrEqual(1)
        }
      }

      for (const itemCount of [1, 2, model.entries.length]) {
        const heights = Array.from({ length: itemCount }, (_, index) => 28 + index)
        const tops = heights.map((_, index) => index === 0
          ? 24
          : 24 + heights.slice(0, index).reduce((sum, height) => sum + height, 0) + (24 * index))
        for (let index = 0; index < itemCount - 1; index += 1) {
          expect(Math.abs(tops[index + 1]! - (tops[index]! + heights[index]!) - 24)).toBeLessThanOrEqual(1)
        }
      }
    } finally {
      await harness.close()
    }
  })

  it('keeps production source independent from Playground and mounts only through the debug fixture direction', async () => {
    const [renderer, seats, fixture, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/HostSeats.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/fixtures/agent-conversation.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/styles.ts'), 'utf8'),
    ])
    expect(renderer).not.toMatch(/playground|HostSeats|\.pg-/i)
    expect(renderer).not.toContain('EmptyRoom')
    expect(renderer).toContain("event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing")
    expect(renderer).toContain('event.preventDefault()')
    expect(styles).not.toContain('.pg-')
    expect(styles).not.toContain('.cxa-empty')
    expect(seats).toContain("renderer/host-ui/conversation/AgentConversationRenderer")
    expect(seats).toContain('debugFixture')
    expect(fixture).toContain('playground-snapshot-debug-only')
    expect(fixture).not.toMatch(/ConnectorHandle|callback|avatarUrl|data-chatroom/i)
  })
})
