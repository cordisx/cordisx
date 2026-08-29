import { readFile } from 'node:fs/promises'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
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
      expect(document.querySelectorAll('.cxa-header-actions .cxa-action')).toHaveLength(2)
      expect(document.querySelectorAll('[role="log"]')).toHaveLength(1)
      expect(document.querySelector('[role="log"]')?.getAttribute('data-agent-conversation-scroll-owner')).toBe('timeline')
      expect(document.querySelectorAll('.cxa-status')).toHaveLength(3)
      expect(document.querySelectorAll('.cxa-avatar')).toHaveLength(3)
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

  it('renders no avatar by default and presents no-room as one title, an empty timeline, and a usable composer', async () => {
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
      expect(roomHarness.dom.window.document.querySelectorAll('.cxa-avatar')).toHaveLength(0)
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
      expect(document.querySelector('h1')?.textContent).toBe('新建房间')
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
      expect(focusOrder.map(element => element.className)).toEqual(['cxa-action', 'cxa-timeline', 'cxa-draft', 'cxa-send'])
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
