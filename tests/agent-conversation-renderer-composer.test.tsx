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
  it('applies the v5 Enter, modifier, IME, disabled, and duplicate-submit fences on the resident textarea', async () => {
    const renderPolicy = async (
      shortcutPolicy: 'enter' | 'mod-enter',
      execute: (request: AgentConversationCommandRequest) => Promise<void>,
      disabled = false,
      availability: 'available' | 'unavailable' = 'available',
    ) => {
      const model = createAgentConversationModel({
        ...createPlaygroundConversationFixture('conversation', 'en'),
        composer: {
          availability,
          placeholder: 'Write a message',
          disabled,
          shortcutPolicy,
          submit: { id: 'room.send' },
        },
      })
      return await render(model, new AgentConversationCommandController({ execute }, model))
    }
    const write = async (harness: RenderHarness, value: string): Promise<HTMLTextAreaElement> => {
      const draft = harness.dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(draft, value)
        draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      draft.focus()
      return draft
    }
    const press = async (harness: RenderHarness, init: KeyboardEventInit): Promise<KeyboardEvent> => {
      const draft = harness.dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const event = new harness.dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      })
      await act(async () => {
        draft.dispatchEvent(event)
        await Promise.resolve()
      })
      return event
    }

    const enterRequests: AgentConversationCommandRequest[] = []
    const enter = await renderPolicy('enter', async request => {
      enterRequests.push(request)
    })
    try {
      await write(enter, 'enter submits')
      expect((await press(enter, {})).defaultPrevented).toBe(true)
      expect(enterRequests).toHaveLength(1)
      expect(enterRequests[0]).toMatchObject({
        reference: { id: 'room.send' },
        context: { scope: 'composer-submit', command: { id: 'room.send' }, submitPayload: 'enter submits' },
      })

      const shifted = await write(enter, 'shift newline')
      shifted.setSelectionRange(5, 5)
      expect((await press(enter, { shiftKey: true })).defaultPrevented).toBe(true)
      expect(enterRequests).toHaveLength(1)
      expect(shifted.value).toBe('shift\n newline')

      await write(enter, 'ime stays local')
      expect((await press(enter, { isComposing: true })).defaultPrevented).toBe(false)
      expect(enterRequests).toHaveLength(1)
    } finally {
      await enter.close()
    }

    const modifierRequests: AgentConversationCommandRequest[] = []
    const modifier = await renderPolicy('mod-enter', async request => {
      modifierRequests.push(request)
    })
    try {
      await write(modifier, 'plain newline')
      expect((await press(modifier, {})).defaultPrevented).toBe(false)
      expect(modifierRequests).toHaveLength(0)

      await write(modifier, 'control submit')
      expect((await press(modifier, { ctrlKey: true })).defaultPrevented).toBe(true)
      expect(modifierRequests).toHaveLength(1)

      await write(modifier, 'meta submit')
      expect((await press(modifier, { metaKey: true })).defaultPrevented).toBe(true)
      expect(modifierRequests).toHaveLength(2)

      await write(modifier, 'composing modifier')
      expect((await press(modifier, { metaKey: true, isComposing: true })).defaultPrevented).toBe(false)
      expect(modifierRequests).toHaveLength(2)
    } finally {
      await modifier.close()
    }

    const disabledRequests: AgentConversationCommandRequest[] = []
    const disabled = await renderPolicy('enter', async request => {
      disabledRequests.push(request)
    }, true)
    try {
      await write(disabled, 'disabled')
      expect((await press(disabled, {})).defaultPrevented).toBe(true)
      expect(disabledRequests).toHaveLength(0)
    } finally {
      await disabled.close()
    }

    const unavailableRequests: AgentConversationCommandRequest[] = []
    const unavailable = await renderPolicy(
      'mod-enter',
      async request => {
        unavailableRequests.push(request)
      },
      false,
      'unavailable',
    )
    try {
      await write(unavailable, 'unavailable')
      await press(unavailable, { ctrlKey: true })
      expect(unavailableRequests).toHaveLength(0)
    } finally {
      await unavailable.close()
    }

    const duplicateRequests: AgentConversationCommandRequest[] = []
    let release: (() => void) | undefined
    const inFlight = new Promise<void>(resolve => {
      release = resolve
    })
    const duplicate = await renderPolicy('enter', async request => {
      duplicateRequests.push(request)
      await inFlight
    })
    try {
      await write(duplicate, 'one request')
      await act(async () => {
        const draft = duplicate.dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
        draft.dispatchEvent(
          new duplicate.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
        draft.dispatchEvent(
          new duplicate.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
        await Promise.resolve()
      })
      expect(duplicateRequests).toHaveLength(1)
      await act(async () => {
        release?.()
        await inFlight
      })
    } finally {
      release?.()
      await duplicate.close()
    }
  })

  it('keeps Host-owned draft state, submit, and focus order outside the immutable model', async () => {
    const requests: AgentConversationCommandRequest[] = []
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      composer: {
        availability: 'available',
        placeholder: 'Write a message',
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
    const harness = await render(model, controller)
    try {
      const document = harness.dom.window.document
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      const valueSetter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value')
        ?.set
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
      const focusOrder = [
        ...document.querySelectorAll<HTMLElement>('.cxa-header-actions button,[role="log"],.cxa-draft,.cxa-send'),
      ]
      expect(focusOrder.map(element => element.className)).toEqual([
        'cxa-header-icon-action',
        'cxa-header-icon-action',
        'cxa-header-icon-action cxa-header-plugin-action',
        'cxa-header-icon-action',
        'cxa-timeline',
        'cxa-draft shikitor-input--attached',
        'cxa-send',
      ])
    } finally {
      await harness.close()
    }
  })

  it('merges selected Room navigation actions into header More with shared confirmation and live replacement', async () => {
    const model = createAgentConversationModel(createPlaygroundConversationFixture('conversation', 'en'))
    const controller = new AgentConversationCommandController({
      execute: vi.fn(async () => undefined),
    }, model)
    const pinInvoke = vi.fn(async () => undefined)
    const deleteInvoke = vi.fn(async () => undefined)
    const actions: readonly HostNavigationCollectionAction[] = [
      {
        id: 'pin',
        label: 'Pin',
        ariaLabel: 'Pin room',
        icon: 'host:pin',
        placement: 'direct',
        tone: 'neutral',
        pressed: true,
        disabled: false,
        success: 'Pinned',
        failure: 'Pin failed',
        invoke: pinInvoke,
      },
      {
        id: 'delete',
        label: 'Delete',
        ariaLabel: 'Delete room',
        icon: 'host:delete',
        placement: 'overflow',
        tone: 'danger',
        pressed: false,
        disabled: false,
        success: 'Deleted',
        failure: 'Delete failed',
        confirmation: {
          title: 'Delete room?',
          description: 'This cannot be undone.',
          confirmLabel: 'Delete',
        },
        invoke: deleteInvoke,
      },
    ]
    const harness = await render(model, controller, false, { navigationActions: actions })
    try {
      const document = harness.dom.window.document
      const trigger = document.querySelector<HTMLButtonElement>('.cxa-header-more-anchor > button')!
      await act(async () => trigger.click())
      const navigationItems =
        () => [...document.querySelectorAll<HTMLButtonElement>('[data-host-navigation-action-id]')]
      expect(navigationItems().map(item => item.dataset.hostNavigationActionId)).toEqual(['pin', 'delete'])
      expect(navigationItems()[0]?.dataset.pressed).toBe('true')
      expect(navigationItems()[1]?.dataset.tone).toBe('danger')
      document.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      expect(document.activeElement).toBe(
        [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')].at(-1),
      )
      navigationItems()[1]!.click()
      const dialog = document.querySelector<HTMLElement>('.cordisx-navigation-confirm')!
      expect(dialog.textContent).toContain('Delete room?')
      ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete')!
        .click()
      await vi.waitFor(() => expect(deleteInvoke).toHaveBeenCalledTimes(1))
      expect(document.querySelector('.cordisx-navigation-feedback')?.textContent).toBe('Deleted')
      expect(pinInvoke).not.toHaveBeenCalled()

      const restore: HostNavigationCollectionAction = {
        ...actions[0]!,
        id: 'restore',
        label: 'Restore',
        ariaLabel: 'Restore room',
        icon: 'host:refresh',
        pressed: false,
      }
      await act(async () =>
        harness.root.render(
          <AgentConversationRenderer
            model={model}
            commands={controller}
            copy={playgroundConversationCopy('zh-CN')}
            navigationActions={[restore]}
          />,
        )
      )
      await act(async () => trigger.click())
      expect(navigationItems().map(item => item.dataset.hostNavigationActionId)).toEqual(['restore'])
    } finally {
      await harness.close()
    }
  })

  it('routes command failures to a dismissible expiring alert while preserving the failed composer draft', async () => {
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      composer: {
        availability: 'available',
        placeholder: 'Write a message',
        disabled: false,
        shortcutPolicy: 'enter',
        submit: { id: 'room.send' },
      },
    })
    const controller = new AgentConversationCommandController({
      execute: async () => {
        throw new Error('Agent details are unavailable')
      },
    }, model)
    const harness = await render(model, controller)
    try {
      const document = harness.dom.window.document
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      const valueSetter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value')
        ?.set
      vi.useFakeTimers()
      await act(async () => {
        valueSetter?.call(draft, 'keep this failed draft')
        draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      expect(send.disabled).toBe(false)
      await act(async () => {
        send.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      const notice = document.querySelector<HTMLElement>('.cxa-composer-notice')!
      const alert = document.querySelector<HTMLElement>('.cxa-command-notification[role="alert"]')!
      expect(notice.textContent).not.toContain('Agent details are unavailable')
      expect(alert.textContent).toContain('Agent details are unavailable')
      expect(draft.value).toBe('keep this failed draft')
      const dismiss = alert.querySelector<HTMLButtonElement>('button')!
      expect(dismiss.getAttribute('aria-label')).toBe('关闭通知')
      expect(dismiss.title).toBe('关闭通知')
      await act(async () => dismiss.click())
      expect(document.querySelector('.cxa-command-notification')).toBeNull()

      await act(async () => {
        send.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(document.querySelector('.cxa-command-notification')).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000)
      })
      expect(document.querySelector('.cxa-command-notification')).toBeNull()
      expect(draft.value).toBe('keep this failed draft')
    } finally {
      vi.useRealTimers()
      await harness.close()
    }
  })

  it('shares one content bound and spacing token across header, timeline, entries, and fixed composer', async () => {
    const model = createPlaygroundConversationFixture('conversation', 'en')
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
    )
    try {
      const document = harness.dom.window.document
      expect(document.querySelector('.cxa-chrome > .cxa-chrome-inner')).not.toBeNull()
      expect(document.querySelector('.cxa-timeline > .cxa-timeline-list')).not.toBeNull()
      expect(document.querySelector('.cxa-composer-region > .cxa-composer')).not.toBeNull()
      expect(document.querySelectorAll('.cxa-timeline')).toHaveLength(1)
      expect(document.querySelectorAll('.cxa-timeline-list > .cxa-entry')).toHaveLength(model.entries.length)

      const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles="production"]')!
        .textContent!
      expect(styles).toContain('--cxa-content-max:780px;--cxa-content-space:var(--cx-space-6,24px)')
      expect(styles).toContain('--cxa-header-height:68px;--cxa-inspector-width:360px;--cxa-message-line-height:18px')
      expect(styles).toContain('--cxa-compact-pill-gap:var(--cx-space-1,4px);container:cxa-conversation/inline-size')
      expect(styles).toContain('height:var(--cxa-header-height)')
      expect(styles).toContain('.cxa-chrome-inner{display:grid;width:min(100%,var(--cxa-content-max))')
      expect(styles).toContain('.cxa-timeline{min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;')
      expect(styles).toContain('padding:var(--cxa-content-space)')
      expect(styles).toContain('.cxa-timeline-list{display:flex;width:min(100%,var(--cxa-content-max))')
      expect(styles).toContain('justify-content:flex-start;gap:var(--cxa-message-gap);margin:0 auto;padding:0')
      expect(styles).toContain('.cxa-entry{min-width:0;margin:0}')
      expect(styles).toContain('.cxa-composer{display:grid;width:min(100%,var(--cxa-content-max))')
      expect(styles).not.toContain('data-group-start="false"]>.cxa-avatar')
      expect(styles).toContain(
        '.cxa-message-time{display:inline-flex;flex:none;align-items:center;padding:0;border:0;opacity:0',
      )
      expect(styles).not.toContain('margin-top:-14px')
      expect(styles).not.toMatch(/\.cxa-timeline-list\{[^}]*space-(?:between|around)/u)
      expect(styles).not.toMatch(/\.cxa-timeline-list\{[^}]*flex-grow/u)
      expect(styles).toContain('@container cxa-conversation (min-width:900px)')
      expect(styles).toContain('grid-template-columns:minmax(0,1fr) auto')
      expect(styles).toContain('.cx-conversation-inspector-layer{position:absolute;inset:0')
      expect(styles).toContain('.cx-conversation-inspector-header{display:flex;height:var(--cxa-header-height)')
      expect(styles).toContain('.cx-conversation-inspector-title{min-width:0;flex:1')
      expect(styles).toContain(
        '.cx-conversation-inspector-layer[data-host-conversation-inspector-mode="drawer"] .cx-conversation-inspector-resizer{display:none}',
      )

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
        const tops = heights.map((_, index) =>
          index === 0
            ? 24
            : 24 + heights.slice(0, index).reduce((sum, height) => sum + height, 0) + (24 * index)
        )
        for (let index = 0; index < itemCount - 1; index += 1) {
          expect(Math.abs(tops[index + 1]! - (tops[index]! + heights[index]!) - 24)).toBeLessThanOrEqual(1)
        }
      }
    } finally {
      await harness.close()
    }
  })

  it('keeps production source independent from Playground and mounts only through the debug fixture direction', async () => {
    const [renderer, entries, seats, fixture, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/AgentConversationEntries.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/HostSeats.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/fixtures/agent-conversation.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/styles.ts'), 'utf8'),
    ])
    expect(renderer).not.toMatch(/playground\/client|HostSeats|\.pg-/i)
    expect(renderer).not.toContain('EmptyRoom')
    expect(entries).toContain("event.key !== 'Enter' || event.nativeEvent.isComposing")
    expect(entries).toContain('event.preventDefault()')
    expect(styles).not.toContain('.pg-')
    expect(styles).not.toContain('.cxa-empty')
    expect(seats).toContain('Product pages are supplied only by plugins')
    expect(seats).not.toContain('AgentConversationRenderer')
    expect(fixture).toContain('playground-snapshot-debug-only')
    expect(fixture).not.toMatch(/ConnectorHandle|callback|avatarUrl|data-chatroom/i)
  })
})
