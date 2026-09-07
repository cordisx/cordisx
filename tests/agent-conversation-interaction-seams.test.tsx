import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('tdesign-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('tdesign-react')
  const react = await import('react')
  return {
    ...actual,
    Button: ({ children, ...props }: Record<string, unknown> & { readonly children?: unknown }) =>
      react.createElement('button', { ...props, type: 'button' }, children),
    Input: (props: Record<string, unknown>) => react.createElement('input', props),
    Textarea: (props: Record<string, unknown>) => react.createElement('textarea', props),
  }
})

import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import {
  AgentConversationRenderer,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import {
  type AgentConversationModel,
  createAgentConversationModel,
} from '../packages/cli/src/renderer/host-ui/conversation/model.js'

const previousGlobals = new Map<string, unknown>()

function fixture(): AgentConversationModel {
  const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' })
  return createAgentConversationModel({
    ownerId: 'chatroom',
    shell: 'agent-desktop',
    binding: { bindingId: 'room-binding', ownerGeneration: 'owner-generation' },
    generation: 'snapshot-generation',
    snapshotSequence: 1,
    selection: {
      kind: 'room',
      roomId: 'room-one',
      title: 'New room',
      multiParticipant: false,
      participantPresentation: 'none',
      participants: [{
        id: 'reviewer',
        role: 'agent',
        name: 'Reviewer',
        avatar,
        agentIdentity: { agentId: 'reviewer', revision: 'reviewer-v1' },
      }],
    },
    entries: [{
      kind: 'message',
      itemId: 'message-one',
      messageId: 'message-one',
      sequence: 1,
      authorId: 'reviewer',
      body: ['Review is ready.'],
      timestamp: '2026-09-07T11:23:45.000Z',
      deliveryState: 'delivered',
      runState: 'stopped',
      ariaLive: 'off',
      actions: [{
        id: 'retry',
        label: 'Retry',
        icon: 'host:refresh',
        command: { id: 'room.retry' },
        disabled: false,
      }],
    }],
    composer: {
      availability: 'available',
      placeholder: 'Message',
      disabled: false,
      shortcutPolicy: 'enter',
      submit: { id: 'room.send' },
    },
    headerActions: [],
  })
}

async function renderConversation(model: AgentConversationModel): Promise<{
  readonly dom: JSDOM
  readonly root: Root
}> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://host.invalid/',
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
  })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number) => dom.window.clearTimeout(handle),
  })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
  for (
    const [key, value] of Object.entries({
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
    })
  ) {
    if (!previousGlobals.has(key)) previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  })
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => {
    root.render(
      <AgentConversationRenderer
        model={model}
        commands={new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model)}
        copy={{
          locale: 'zh-CN',
          newRoomTitle: '新房间',
          timelineLabel: '会话时间线',
          composerLabel: '消息草稿',
          sendLabel: '发送',
          running: '运行中',
          stopped: '已停止',
          failed: '失败',
          pending: '待发送',
          unavailable: '不可用',
        }}
        identity={{
          resolve: identity => ({ identity, name: 'Reviewer', introduction: 'Focused review.' }),
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        }}
      />,
    )
  })
  return { dom, root }
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
  vi.restoreAllMocks()
})

describe('Host conversation interaction seams', () => {
  it('keeps message hover actions and message/avatar context menus mounted in the Host renderer', async () => {
    const harness = await renderConversation(fixture())
    try {
      const document = harness.dom.window.document
      const message = document.querySelector<HTMLElement>('.cxa-message[data-role="agent"]')!
      const toolbar = message.querySelector<HTMLElement>('.cxa-message-hover-actions[role="toolbar"]')!
      expect(toolbar).not.toBeNull()
      expect(toolbar.querySelector('[data-host-conversation-message-action-slot="v1"]')).not.toBeNull()
      expect(toolbar.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')).not.toBeNull()
      expect(toolbar.querySelector<HTMLElement>('[aria-label="更多消息操作"]')).not.toBeNull()

      const openContextMenu = async (target: HTMLElement) => {
        await act(async () => {
          target.dispatchEvent(
            new harness.dom.window.MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 24,
              clientY: 24,
            }),
          )
        })
        return document.querySelector<HTMLElement>('.cxa-context-menu[role="menu"]')!
      }

      const messageMenu = await openContextMenu(message.querySelector<HTMLElement>('.cxa-message-surface')!)
      expect(messageMenu).not.toBeNull()
      expect([...messageMenu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
        '复制消息',
        '@提及 Reviewer',
        '查看 Reviewer',
      ])
      await act(async () => {
        document.dispatchEvent(new harness.dom.window.MouseEvent('pointerdown', { bubbles: true }))
      })

      const avatarButton = message.querySelector<HTMLElement>('.cx-agent-identity-avatar-button')!
      expect(avatarButton.querySelector('.cxa-avatar[data-avatar-state="resolved"]')).not.toBeNull()
      const avatarMenu = await openContextMenu(avatarButton)
      expect([...avatarMenu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
        '@提及 Reviewer',
        '查看 Reviewer',
      ])
    } finally {
      await act(async () => harness.root.unmount())
      harness.dom.window.close()
    }
  })
})
