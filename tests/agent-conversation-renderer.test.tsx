import { readFile } from 'node:fs/promises'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import {
  AgentConversationRenderer,
  type AgentConversationRendererProps,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { createHostRoomCompositeAvatarProjection } from '../packages/cli/src/renderer/host-ui/RoomCompositeAvatar.js'
import type { HostNavigationCollectionAction } from '../packages/cli/src/renderer/host-ui/NavigationCollectionActions.js'
import { HostRoomCompositeAvatar } from '../packages/cli/src/renderer/host-ui/conversation/RoomCompositeAvatar.js'
import {
  AgentConversationCommandController,
  type AgentConversationCommandRequest,
} from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import {
  type AgentConversationMessage,
  type AgentConversationModel,
  createAgentConversationModel,
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

async function render(
  model: AgentConversationModel,
  commands: AgentConversationCommandController,
  debugFixture = false,
  options: Pick<AgentConversationRendererProps, 'identity' | 'navigationActions' | 'roomSettings'> = {},
): Promise<RenderHarness> {
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN" data-theme="dark"><body><div id="root"></div></body></html>',
    { url: 'https://host.invalid/' },
  )
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
  })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number) => dom.window.clearTimeout(handle),
  })
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
  await act(async () =>
    root.render(
      <AgentConversationRenderer
        model={model}
        commands={commands}
        copy={playgroundConversationCopy('zh-CN')}
        debugFixture={debugFixture}
        {...options}
      />,
    )
  )
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
    expect(() =>
      createAgentConversationModel({
        ...input,
        selection: {
          ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
          participants: [{ id: 'agent', role: 'agent', name: 'Agent', avatarUrl: 'https://unsafe.invalid/avatar.png' }],
        } as AgentConversationModel['selection'],
        entries: [],
      })
    ).toThrow('unknown field avatarUrl')
    const generated = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'renderer-agent' })
    const withAvatar = createAgentConversationModel({
      ...input,
      selection: {
        ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
        participants: [{ id: 'agent', role: 'agent', name: 'Agent', avatar: generated }],
      },
      entries: [],
    })
    expect(withAvatar.selection.kind === 'room' ? withAvatar.selection.participants[0]?.avatar : undefined).toEqual(
      generated,
    )
    expect(() =>
      createAgentConversationModel({
        ...input,
        selection: {
          ...(input.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>),
          participants: [{
            id: 'agent',
            role: 'agent',
            name: 'Agent',
            avatar: { kind: 'asset', ref: 'https://unsafe.invalid/avatar.png' } as never,
          }],
        },
        entries: [],
      })
    ).toThrow('qualified opaque ref')
    expect(() =>
      createAgentConversationModel({
        ...input,
        selection: {
          kind: 'room',
          roomId: 'room',
          title: 'Room',
          multiParticipant: false,
          participantPresentation: 'host-initials',
          participants: [],
        },
        entries: [],
      })
    ).toThrow('single-participant rooms cannot request participant initials')
  })

  it('preserves no-room as an empty timeline with a composer and forbids CTA/header action state', () => {
    const valid = createPlaygroundConversationFixture('empty', 'en')
    expect(valid.selection).toEqual({ kind: 'no-room' })
    expect(valid.entries).toHaveLength(0)
    expect(valid.headerActions).toHaveLength(0)
    expect(valid.composer).toMatchObject({
      availability: 'available',
      disabled: false,
      submit: { id: 'room.create-with-message' },
    })
    expect(() =>
      createAgentConversationModel({
        ...valid,
        selection: {
          kind: 'no-room',
          newRoomAction: { id: 'new-room' },
        } as unknown as AgentConversationModel['selection'],
      })
    ).toThrow('unknown field newRoomAction')
    expect(() =>
      createAgentConversationModel({
        ...valid,
        headerActions: [{ id: 'settings', label: 'Settings', command: { id: 'room.settings' }, disabled: false }],
      })
    ).toThrow('forbids header actions')
    expect(() =>
      createAgentConversationModel({
        ...valid,
        entries: [{
          kind: 'status',
          itemId: 'wrong-scope-new-room',
          sequence: 1,
          label: 'New room',
          state: 'info',
          ariaLive: 'off',
        }],
      })
    ).toThrow('no-room selection cannot contain timeline entries')
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
      composer: {
        availability: 'available',
        placeholder: 'Message',
        disabled: false,
        shortcutPolicy: 'enter',
        submit: { id: 'room.send' },
      },
      headerActions: [{
        id: 'refresh',
        label: 'Refresh',
        icon: 'host:refresh',
        command: { id: 'room.refresh' },
        disabled: false,
      }],
    })
    const controller = new AgentConversationCommandController({
      execute: async request => {
        requests.push(request)
      },
    }, model)
    await controller.runHeader(model, model.headerActions[0]!)
    await controller.runComposer(model, '  hello room  ')
    expect(requests).toEqual([
      {
        ownerId: model.ownerId,
        shell: 'agent-desktop',
        invocationKey: 'header:refresh',
        reference: { id: 'room.refresh' },
        context: {
          binding: model.binding,
          generation: model.generation,
          scope: 'header',
          command: { id: 'room.refresh' },
        },
      },
      {
        ownerId: model.ownerId,
        shell: 'agent-desktop',
        invocationKey: 'composer-submit',
        reference: { id: 'room.send' },
        context: {
          binding: model.binding,
          generation: model.generation,
          scope: 'composer-submit',
          command: { id: 'room.send' },
          submitPayload: '  hello room  ',
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
      composer: {
        availability: 'available',
        placeholder: 'Message',
        disabled: false,
        shortcutPolicy: 'enter',
        submit: { id: 'room.send' },
      },
      headerActions: [{ id: 'refresh', label: 'Refresh', command: { id: 'room.refresh' }, disabled: false }],
      entries: base.entries.map(entry => entry === firstMessage ? { ...entry, actions: [messageAction] } : entry),
    })
    const requests: AgentConversationCommandRequest[] = []
    const controller = new AgentConversationCommandController({
      execute: async request => {
        requests.push(request)
      },
    }, model)
    const canonicalMessage = model.entries.find(entry =>
      entry.kind === 'message' && entry.itemId === firstMessage.itemId
    )!
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
    expect(() => controller.runMessage(model, canonicalMessage.itemId, model.headerActions[0]!)).toThrow(
      'not in the current model',
    )
    expect(() => controller.runMessage(model, 'not-the-canonical-item', canonicalMessageAction)).toThrow(
      'not in the current model',
    )
    expect(() => controller.runHeader({ ...model, ownerId: 'other-owner' }, model.headerActions[0]!))
      .toThrow('owner fence')
    expect(() =>
      controller.runHeader(
        { ...model, shell: 'wrong-shell' } as unknown as AgentConversationModel,
        model.headerActions[0]!,
      )
    )
      .toThrow('shell fence')
    expect(() =>
      controller.runHeader(
        { ...model, binding: { ...model.binding, bindingId: 'other-binding' } },
        model.headerActions[0]!,
      )
    )
      .toThrow('binding fence')
    expect(() =>
      controller.runHeader(
        { ...model, binding: { ...model.binding, ownerGeneration: 'other-owner-generation' } },
        model.headerActions[0]!,
      )
    )
      .toThrow('owner generation fence')
    expect(() => controller.runHeader({ ...model, generation: 'other-snapshot-generation' }, model.headerActions[0]!))
      .toThrow('snapshot generation fence')
    expect(() =>
      controller.runHeader({ ...model, snapshotSequence: model.snapshotSequence + 1 }, model.headerActions[0]!)
    )
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
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
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
      expect(
        [...document.querySelectorAll('.cxa-header-actions .cxa-header-icon-action')].map(button =>
          button.getAttribute('aria-label')
        ),
      ).toEqual(['群成员', '设置', '停止', '房间菜单', '更多'])
      expect(document.querySelectorAll('[role="log"]')).toHaveLength(1)
      expect(document.querySelector('[role="log"]')?.getAttribute('data-agent-conversation-scroll-owner')).toBe(
        'timeline',
      )
      expect(document.querySelectorAll('.cxa-status')).toHaveLength(3)
      expect(document.querySelectorAll('.cxrv-participant')).toHaveLength(0)
      expect(document.querySelector('.cxrv-empty')).not.toBeNull()
      expect(document.querySelector<HTMLElement>('.cxrv-composite')?.dataset.roomCompositeCount).toBe('0')
      expect(document.querySelectorAll('.cxrv-participant .cxa-avatar')).toHaveLength(0)
      for (const label of ['群成员', '设置']) {
        await act(async () =>
          document.querySelector<HTMLButtonElement>(`.cxa-header-icon-action[aria-label="${label}"]`)!.click()
        )
        expect(document.querySelectorAll('[data-host-conversation-inspector="true"]')).toHaveLength(1)
        expect(document.querySelector('.cx-conversation-inspector-title')?.textContent).toContain(
          label === '设置' ? '群聊设置' : label,
        )
        expect(document.querySelector('.cx-conversation-inspector-resizer')?.getAttribute('role')).toBe('separator')
        expect(document.querySelector('.cx-conversation-inspector-resizer')?.getAttribute('aria-label')).toBe(
          '调整详情栏宽度',
        )
        expect(
          document.querySelector('.cx-conversation-inspector-header')?.lastElementChild?.getAttribute('aria-label'),
        ).toContain('关闭')
      }
      await act(async () =>
        document.querySelector<HTMLButtonElement>('.cxa-header-icon-action[aria-label="更多"]')!.click()
      )
      expect(document.querySelector('[data-host-conversation-header-action-overflow="v1"]')).not.toBeNull()
      expect(
        document.querySelector('[data-agent-conversation-composer]')?.getAttribute('data-agent-conversation-composer'),
      ).toBe('fixed')
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
    const singleParticipant = {
      ...room.participants[1]!,
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'single-room-agent' }),
    }
    const message = base.entries.find(entry => entry.kind === 'message' && entry.authorId === singleParticipant.id)!
    const single = createAgentConversationModel({
      ...base,
      selection: {
        kind: 'room',
        roomId: 'single-room',
        title: 'Single task',
        multiParticipant: false,
        participantPresentation: 'none',
        participants: [singleParticipant],
      },
      entries: [message],
      headerActions: [],
      composer: {
        availability: 'available',
        placeholder: 'Write a message',
        disabled: false,
        shortcutPolicy: 'enter',
        submit: { id: 'room.send' },
      },
    })
    const controller = new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, single)
    const roomHarness = await render(single, controller)
    try {
      expect(roomHarness.dom.window.document.querySelectorAll('.cxrv-participant .cxa-avatar')).toHaveLength(1)
      expect(roomHarness.dom.window.document.querySelector('.cxrv-empty')).toBeNull()
      expect(roomHarness.dom.window.document.querySelectorAll('.cxa-message-avatar-seat > .cxa-avatar')).toHaveLength(1)
    } finally {
      await roomHarness.close()
    }
    const empty = createPlaygroundConversationFixture('empty', 'zh-CN')
    const requests: AgentConversationCommandRequest[] = []
    const emptyHarness = await render(
      empty,
      new AgentConversationCommandController({
        execute: async request => {
          requests.push(request)
        },
      }, empty),
      true,
    )
    try {
      const document = emptyHarness.dom.window.document
      expect(document.querySelector('h1')?.textContent).toBe('空会话测试场景')
      expect(document.querySelectorAll('h2')).toHaveLength(0)
      expect(document.querySelectorAll('.cxa-action')).toHaveLength(0)
      expect(document.querySelectorAll('[data-agent-conversation-empty],.cxa-empty-mark,.cxa-empty-copy')).toHaveLength(
        0,
      )
      expect(document.querySelectorAll('[role="log"]')).toHaveLength(1)
      expect(document.querySelectorAll('.cxa-timeline-list > *')).toHaveLength(0)
      expect(document.querySelectorAll('.cxa-composer')).toHaveLength(1)
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      expect(draft.disabled).toBe(false)
      expect(send.disabled).toBe(true)
      const valueSetter = Object.getOwnPropertyDescriptor(
        emptyHarness.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
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
        participants: base.selection.participants.map(participant =>
          participant.id === 'agent-alpha'
            ? { ...participant, avatar: generated }
            : participant.id === 'agent-beta'
            ? {
              ...participant,
              avatar: {
                kind: 'definition' as const,
                ref: 'avatar-definitions:agent-beta',
                schema: 'oneworks.avatar',
                definitionVersion: 1,
              },
            }
            : participant
        ),
      },
      entries: base.entries.map(entry =>
        entry === human
          ? {
            ...entry,
            reactions: [
              {
                reactionId: 'reaction-alpha',
                actorParticipantId: 'agent-alpha',
                value: { kind: 'emoji', emoji: '✅' },
                state: 'completed',
              },
              {
                reactionId: 'reaction-beta',
                actorParticipantId: 'agent-beta',
                value: { kind: 'emoji', emoji: '✅' },
                state: 'pending',
              },
            ],
          }
          : entry
      ),
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
    )
    try {
      const reactions = [...harness.dom.window.document.querySelectorAll<HTMLElement>('.cxa-message-reaction')]
      expect(reactions).toHaveLength(2)
      expect(reactions.every(reaction => reaction.closest('.cxa-message-bubble-shell') !== null)).toBe(true)
      expect(reactions.every(reaction => reaction.closest('.cxa-message-surface') === null)).toBe(true)
      expect(reactions.map(reaction => reaction.querySelector('.cxa-message-reaction-actor')?.textContent)).toEqual([
        'Agent Alpha',
        'Agent Beta',
      ])
      expect(reactions.map(reaction => reaction.querySelector('.cxa-message-reaction-value')?.textContent)).toEqual([
        '✅',
        '✅',
      ])
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
      expect(avatars.map(avatar => avatar.dataset.avatarState)).toEqual(['resolved', 'fallback'])
      expect(avatars[1]).toMatchObject({ textContent: 'AB' })
      expect(avatars[1]?.dataset.avatarCode).toBe('reference-unavailable')
      expect(reactions.flatMap(reaction => [...reaction.querySelectorAll('button')])).toHaveLength(0)
      const styles = harness.dom.window.document.querySelector<HTMLStyleElement>(
        'style[data-agent-conversation-styles]',
      )!.textContent!
      expect(styles).toContain('--cxa-compact-pill-padding-block:var(--cx-space-1,4px)')
      expect(styles).toContain('--cxa-compact-pill-padding-inline:var(--cx-space-2,8px)')
      expect(styles).toContain('--cxa-compact-pill-gap:var(--cx-space-1,4px)')
      expect(styles).toContain(
        '.cxa-message-reaction{display:inline-flex;width:max-content;max-width:100%;min-height:26px;flex:0 0 auto;align-items:center;justify-content:center;gap:var(--cxa-compact-pill-gap);padding:var(--cxa-compact-pill-padding-block) var(--cxa-compact-pill-padding-inline)',
      )

      const markup = renderToString(
        <AgentConversationRenderer
          model={model}
          commands={new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model)}
          copy={playgroundConversationCopy('zh-CN')}
        />,
      )
      const server = new JSDOM(markup).window.document
      const serverReactions = [...server.querySelectorAll('.cxa-message-reaction')]
      expect(serverReactions).toHaveLength(2)
      expect(
        serverReactions.map(reaction =>
          reaction.querySelector('.cxa-message-reaction-avatar')?.nextElementSibling?.textContent
        ),
      ).toEqual(['Agent Alpha', 'Agent Beta'])
      expect(serverReactions.flatMap(reaction => [...reaction.querySelectorAll('button')])).toHaveLength(0)
      expect(() =>
        createAgentConversationModel({
          ...base,
          entries: base.entries.map(entry =>
            entry === human
              ? {
                ...entry,
                reactions: [{
                  reactionId: 'reaction-unknown',
                  actorParticipantId: 'unknown-agent',
                  value: { kind: 'emoji', emoji: '✅' },
                  state: 'completed',
                }],
              }
              : entry
          ),
        })
      ).toThrow('actor is unknown')
    } finally {
      await harness.close()
    }
  })

  it('renders v7 approvals as full-width standard cards outside ordinary message bubble geometry', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const reviewerIdentity = { agentId: 'reviewer', revision: 'reviewer-v1' }
    const leadIdentity = { agentId: 'lead', revision: 'lead-v1' }
    const selection = {
      kind: 'room' as const,
      roomId: 'approval-room',
      title: 'Approval review',
      multiParticipant: true,
      participantPresentation: 'host-initials' as const,
      participants: [
        {
          id: 'reviewer',
          role: 'agent' as const,
          name: 'Reviewer',
          agentIdentity: reviewerIdentity,
        },
        {
          id: 'lead',
          role: 'agent' as const,
          name: 'Lead',
          agentIdentity: leadIdentity,
        },
      ],
    }
    const pending = {
      kind: 'approval' as const,
      itemId: 'approval-card',
      sequence: 1,
      participantId: 'reviewer',
      memberId: 'reviewer',
      runId: 'reviewer-run',
      sessionId: 'cx-session.reviewer',
      agentGeneration: 2,
      approvalId: 'approval-card',
      approvalKind: 'external-action' as const,
      requester: reviewerIdentity,
      authority: { participantId: 'lead', memberId: 'lead', identity: leadIdentity },
      reason: {
        kind: 'plain-text' as const,
        text:
          'Review this deliberately long approval reason so the dedicated card stretches and wraps without inheriting a chat bubble corner.',
      },
      authorityBinding: {
        agentId: 'cx-session.lead',
        sessionId: 'cx-session.lead',
        agentGeneration: 3,
        definition: leadIdentity,
      },
      state: 'pending' as const,
      actions: [
        { decision: 'approve' as const, command: { id: 'approval.answer' } },
        { decision: 'reject' as const, command: { id: 'approval.answer' } },
      ],
    }
    const states = ['pending', 'approved', 'denied', 'cancelled', 'failed'] as const
    const {
      actions: _pendingActions,
      agentGeneration: _agentGeneration,
      authorityBinding: _authorityBinding,
      ...terminal
    } = pending
    for (const state of states) {
      const entry = state === 'pending'
        ? pending
        : {
          ...terminal,
          state,
          actions: [],
        }
      const model = createAgentConversationModel({
        ...base,
        selection,
        entries: [entry],
        snapshotSequence: 1,
      })
      const harness = await render(
        model,
        new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      )
      try {
        const document = harness.dom.window.document
        const article = document.querySelector<HTMLElement>('.cxa-approval-message')!
        const card = document.querySelector<HTMLElement>('.cxa-approval-card')!
        expect(article.classList.contains('cxa-message')).toBe(false)
        expect(article.dataset.state).toBe(state)
        expect(card).not.toBeNull()
        expect(card.classList.contains('cxa-message-surface')).toBe(false)
        expect(document.querySelector('.cxa-message-bubble-shell')).toBeNull()
        expect(document.querySelector('.cxa-message-bubble-anchor')).toBeNull()
        expect(document.querySelector('.cxa-approval-avatar-seat .cxa-avatar')).not.toBeNull()
        expect(document.querySelector('.cxa-message-meta')?.textContent).toContain('Reviewer')
        expect(document.querySelector('.cxa-approval-target')?.textContent).toBe('由 Lead 审批')
        expect(document.querySelector('.cxa-approval-reason')?.textContent).toContain('deliberately long')
        if (state === 'pending') {
          expect(document.querySelectorAll('.cxa-approval-card-actions .cxa-approval-action')).toHaveLength(2)
          expect(document.querySelector('.cxa-approval-outcome')).toBeNull()
        } else {
          expect(document.querySelector('.cxa-approval-card-actions')).toBeNull()
          expect(document.querySelector('.cxa-approval-outcome')?.getAttribute('data-state')).toBe(state)
        }
        const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles]')!.textContent!
        expect(styles).toContain(
          '.cxa-approval-message-content{display:grid;width:min(100%,calc(720px + var(--cxa-message-avatar-size) + var(--cxa-message-avatar-gap)))',
        )
        expect(styles).toContain('.cxa-approval-card{display:grid;width:100%;min-width:0;')
        expect(styles).toContain('border-radius:12px')
        expect(styles).toContain('@container cxa-conversation (max-width:560px){.cxa-approval-card{')
        expect(styles).not.toContain('.cxa-approval-card{width:fit-content')
        expect(styles).not.toContain('.cxa-approval-card{border-radius:15px 15px 15px 4px')
      } finally {
        await harness.close()
      }
    }
  })

  it('keeps outgoing user bubbles free of author/state copy while reserving the hidden accessible timestamp beside the bubble', async () => {
    const model = createPlaygroundConversationFixture('conversation', 'en')
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
    )
    try {
      const human = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="human"]')!
      expect(human.querySelector('.cxa-message-meta')).toBeNull()
      expect(human.querySelector('.cxa-author')).toBeNull()
      expect(human.querySelector('.cxa-message-body')?.textContent).toContain(
        'Review the Host-owned conversation shell',
      )
      expect(human.textContent).not.toContain('You')
      const agents = [...harness.dom.window.document.querySelectorAll<HTMLElement>('.cxa-message[data-role="agent"]')]
      expect(agents.every(message => message.querySelector('.cxa-message-time')?.closest('.cxa-message-meta') !== null))
        .toBe(true)
      expect(human.querySelector('.cxa-message-time')?.nextElementSibling?.classList.contains('cxa-message-surface'))
        .toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('groups adjacent Agent messages by exact participant identity: first name, last avatar, and accessible bubble time', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const lead = {
      id: 'lead',
      role: 'agent' as const,
      name: 'Lead',
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
      agentIdentity: { agentId: 'lead', revision: 'r1' },
    }
    const reviewer = {
      id: 'reviewer',
      role: 'agent' as const,
      name: 'Reviewer',
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' }),
      agentIdentity: { agentId: 'reviewer', revision: 'r1' },
    }
    const human = { id: 'human', role: 'human' as const, name: 'You' }
    const system = { id: 'system', role: 'system' as const, name: 'System' }
    const entry = (
      itemId: string,
      authorId: string,
      sequence: number,
      text: string,
      semantic?: AgentConversationMessage['semantic'],
    ) => ({
      kind: 'message' as const,
      itemId,
      messageId: `message-${itemId}`,
      sequence,
      authorId,
      body: [text],
      timestamp: `2026-08-31T00:00:0${sequence}.000Z`,
      deliveryState: 'delivered' as const,
      runState: 'idle' as const,
      ariaLive: 'off' as const,
      actions: [],
      source: 'agent-loop' as const,
      reactions: [],
      ...(semantic === undefined ? {} : { semantic }),
    })
    const model = createAgentConversationModel({
      ...base,
      selection: { ...room, roomId: 'grouped', participants: [lead, reviewer, human, system] },
      entries: [
        entry('lead-introduction', 'lead', 1, 'I am Lead.', {
          purpose: 'member-self-introduction',
          causation: { operationId: 'intro' },
          participantId: 'lead',
          memberId: 'lead',
          runId: 'lead-run',
          binding: { bindingId: 'lead-binding', generation: 1 },
          turn: 'lead-turn',
        }),
        entry('lead-reply', 'lead', 2, 'I will continue.', { purpose: 'conversation' }),
        entry('human-break', 'human', 3, 'Please continue.', { purpose: 'conversation' }),
        entry('lead-after-human', 'lead', 4, 'Continuing.', { purpose: 'conversation' }),
        entry('system-break', 'system', 5, 'System event.', { purpose: 'conversation' }),
        entry('reviewer-reply', 'reviewer', 6, 'Reviewing.', { purpose: 'conversation' }),
      ],
      headerActions: [],
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      false,
      {
        identity: {
          resolve: identity => ({
            identity,
            name: identity.agentId === 'lead' ? 'Lead' : 'Reviewer',
            introduction: 'Exact identity presentation.',
          }),
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        },
      },
    )
    try {
      const document = harness.dom.window.document
      const intro = document.querySelector<HTMLElement>('[data-entry-id="lead-introduction"]')!
      const followup = document.querySelector<HTMLElement>('[data-entry-id="lead-reply"]')!
      const afterHuman = document.querySelector<HTMLElement>('[data-entry-id="lead-after-human"]')!
      const reviewerReply = document.querySelector<HTMLElement>('[data-entry-id="reviewer-reply"]')!
      expect([intro, followup, afterHuman, reviewerReply].map(node => [node.dataset.groupStart, node.dataset.groupEnd]))
        .toEqual([
          ['true', 'false'],
          ['false', 'true'],
          ['true', 'true'],
          ['true', 'true'],
        ])
      expect(intro.querySelector('.cx-agent-identity-avatar-button')).toBeNull()
      expect(followup.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(afterHuman.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(reviewerReply.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(intro.querySelector('.cxa-message-meta')?.textContent).toContain('Lead')
      expect(followup.querySelector('.cxa-message-meta')).not.toBeNull()
      expect(followup.querySelector('.cxa-author')).toBeNull()
      expect(afterHuman.querySelector('.cxa-message-meta')?.textContent).toContain('Lead')
      expect(reviewerReply.querySelector('.cxa-message-meta')?.textContent).toContain('Reviewer')
      const introSeat = intro.querySelector<HTMLElement>('.cxa-message-avatar-seat')!
      const followupSeat = followup.querySelector<HTMLElement>('.cxa-message-avatar-seat')!
      expect(introSeat.dataset.avatarSeat).toBe('placeholder')
      expect(introSeat.getAttribute('aria-hidden')).toBe('true')
      expect(introSeat.hasAttribute('inert')).toBe(true)
      expect(followupSeat.dataset.avatarSeat).toBe('visible')
      expect(followupSeat.hasAttribute('aria-hidden')).toBe(false)
      expect(
        intro.querySelector(
          '.cxa-message-bubble-row > .cxa-message-avatar-seat + .cxa-message-bubble-shell .cxa-message-surface',
        ),
      ).not.toBeNull()
      expect(
        followup.querySelector(
          '.cxa-message-bubble-row > .cxa-message-avatar-seat + .cxa-message-bubble-shell .cxa-message-surface',
        ),
      ).not.toBeNull()
      for (const message of [intro, followup, afterHuman, reviewerReply]) {
        const time = message.querySelector<HTMLTimeElement>('.cxa-message-time')!
        expect(time.closest('.cxa-message-meta')).not.toBeNull()
        expect(time.closest('.cxa-message-surface')).toBeNull()
        expect(time.tabIndex).toBe(-1)
        expect(message.getAttribute('aria-label')).toContain(message === reviewerReply ? 'Reviewer' : 'Lead')
      }
      const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles]')!.textContent!
      expect(styles).toContain(
        '.cxa-message-bubble-row{display:flex;min-width:0;max-width:100%;align-items:stretch;gap:var(--cxa-message-avatar-gap)}',
      )
      expect(styles).toContain(
        '.cxa-message-avatar-seat{display:grid;width:var(--cxa-message-avatar-size);min-height:var(--cxa-message-avatar-size);height:auto;flex:0 0 var(--cxa-message-avatar-size)',
      )
      expect(styles).toContain(
        '.cxa-message[data-role="agent"] .cxa-message-meta{max-width:calc(100% - var(--cxa-message-avatar-size) - var(--cxa-message-avatar-gap));margin-inline-start:calc(var(--cxa-message-avatar-size) + var(--cxa-message-avatar-gap));padding-inline:0}',
      )
      expect(styles).toContain(
        '--cxa-message-avatar-size:calc(var(--cxa-message-line-height) + var(--cxa-message-bubble-padding-block) + var(--cxa-message-bubble-padding-block) + var(--cxa-message-bubble-border-width) + var(--cxa-message-bubble-border-width))',
      )
      expect(styles).toContain(
        '.cxa-message[data-role="agent"] .cxa-message-content:has(>.cxa-message-bubble-row>.cxa-message-bubble-shell>.cxa-message-bubble-anchor:hover)>.cxa-message-meta>.cxa-message-time',
      )
      expect(styles).toContain(
        '.cxa-message-time{display:inline-flex;flex:none;align-items:center;padding:0;border:0;opacity:0',
      )
      expect(styles).not.toContain('.cxa-message:hover .cxa-message-time')
    } finally {
      await harness.close()
    }
  })
})
