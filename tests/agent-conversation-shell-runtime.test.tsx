import type {
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'

// See the renderer suite: this test installs JSDOM after module evaluation,
// while TDesign's textarea records useInsertionEffect at evaluation time.
vi.mock('tdesign-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('tdesign-react')
  const react = await import('react')
  return {
    ...actual,
    Button: ({ children, disabled, onClick, loading: _loading, theme: _theme, variant: _variant, ...props }: Record<string, unknown> & { readonly children?: unknown; readonly disabled?: boolean; readonly onClick?: () => void }) => react.createElement('button', {
      ...props,
      type: 'button',
      disabled,
      onClick,
    }, children),
    Input: ({ onChange, ...props }: Record<string, unknown> & { readonly onChange?: (value: string) => void }) => react.createElement('input', {
      ...props,
      onChange: (event: { readonly currentTarget: { readonly value: string } }) => onChange?.(event.currentTarget.value),
      onInput: (event: { readonly currentTarget: { readonly value: string } }) => onChange?.(event.currentTarget.value),
    }),
    Textarea: ({ onChange, autosize: _autosize, ...props }: Record<string, unknown> & { readonly onChange?: (value: string) => void }) => react.createElement('textarea', {
      ...props,
      onChange: (event: { readonly currentTarget: { readonly value: string } }) => onChange?.(event.currentTarget.value),
      onInput: (event: { readonly currentTarget: { readonly value: string } }) => onChange?.(event.currentTarget.value),
    }),
  }
})
import { CORDISX_PAGE_SCHEMA_V3, type CordisXCommandContext, type CordisXPageMountContext } from '../packages/cli/src/contracts.js'
import {
  AgentConversationShellRegistry,
  CordisXAgentConversationShellService,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { CordisXPageService } from '../packages/cli/src/renderer/navigation.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'

class PageStream implements AsyncIterableIterator<AgentConversationShellPage> {
  private readonly pages: AgentConversationShellPage[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentConversationShellPage>) => void> = []
  private closed = false

  ;[Symbol.asyncIterator](): AsyncIterableIterator<AgentConversationShellPage> { return this }

  next(): Promise<IteratorResult<AgentConversationShellPage>> {
    const page = this.pages.shift()
    if (page !== undefined) return Promise.resolve({ done: false, value: page })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiting.push(resolve))
  }

  push(page: AgentConversationShellPage): void {
    const waiter = this.waiting.shift()
    if (waiter === undefined) this.pages.push(page)
    else waiter({ done: false, value: page })
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined })
  }
}

function message(key: string, fallback: string) {
  return { namespace: 'chatroom', key, fallback }
}

function noRoom(binding: AgentConversationShellBinding): AgentConversationShellSnapshot {
  return {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: 'snapshot-1',
    snapshotSequence: 0,
    selection: { kind: 'no-room' },
    items: [],
    composer: {
      availability: 'available',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: false },
      submit: { id: 'create-with-message' },
    },
    headerActions: [],
  }
}

function room(binding: AgentConversationShellBinding): AgentConversationShellSnapshot {
  const participant = {
    participantId: 'agent-one',
    role: 'agent' as const,
    displayName: message('participant.agent-one', 'Agent One'),
    avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'agent-one' }),
  }
  return {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: 'snapshot-1',
    snapshotSequence: 1,
    selection: {
      kind: 'room',
      roomId: 'room-one',
      title: message('room.title', 'Release review'),
      secondary: message('room.secondary', '1 participant'),
      multiParticipant: false,
      participantPresentation: 'none',
      participants: [participant],
    },
    items: [{
      kind: 'message',
      itemId: 'item-one',
      messageId: 'message-one',
      sequence: 1,
      author: participant,
      source: 'chatroom-acknowledgement',
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: message('message.one', 'Review is ready.') }],
      timestamp: '2026-08-29T12:00:00.000Z',
      deliveryState: 'delivered',
      runState: 'stopped',
      ariaLive: 'off',
      actions: [],
    }],
    composer: {
      availability: 'unavailable',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: true, reason: message('composer.unavailable', 'Messaging is unavailable.') },
      submit: { id: 'send' },
    },
    headerActions: [],
  }
}

function fakeI18n(): CordisXI18nService {
  return {
    resolveFor: (_owner: string, value: { key: string; fallback?: string }) => ({
      text: value.fallback ?? value.key,
      namespace: 'chatroom',
      key: value.key,
    }),
    clearDiagnosticSite() {},
    getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 1 }),
    subscribeInternal: () => () => {},
  } as unknown as CordisXI18nService
}

function commandService(registry: CommandRegistry): CordisXCommandService {
  return {
    executeConversationFor: (owner, reference, invocationKey, context) => registry.execute(
      owner,
      reference,
      invocationKey,
      undefined,
      undefined,
      context,
    ),
  } as unknown as CordisXCommandService
}

const globals = new Map<string, unknown>()

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', { url: 'https://host.invalid/' })
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0) })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: (handle: number) => dom.window.clearTimeout(handle) })
  for (const [key, value] of Object.entries({
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
  })) {
    globals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  return dom
}

function mountContext(dom: JSDOM, params: Record<string, string> = {}): CordisXPageMountContext {
  return {
    container: dom.window.document.getElementById('page')!,
    document: dom.window.document,
    signal: new AbortController().signal,
    routeId: 'chatroom:room',
    outlet: 'main',
    params,
    navigation: { navigate: async () => {}, back: async () => {}, close: async () => {} },
    controls: { select: () => { throw new Error('not used') }, dispose() {} },
    localeNamespace: 'chatroom',
    t: key => String(key),
    localization: {} as CordisXPageMountContext['localization'],
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

async function waitForRuntimeState(dom: JSDOM, state: 'loading' | 'unavailable' | 'error'): Promise<void> {
  await vi.waitFor(() => {
    expect(dom.window.document.querySelector(`[data-agent-conversation-runtime-state="${state}"]`)).not.toBeNull()
  }, { timeout: 1_000, interval: 10 })
}

afterEach(() => {
  for (const [key, value] of globals) Reflect.set(globalThis, key, value)
  globals.clear()
  vi.restoreAllMocks()
})

describe('Agent conversation shell public runtime', () => {
  it('settles a Shell v4 close once and releases its source with an idempotent async unsubscribe', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-v4' })
    let resolveClosed: ((value: AgentConversationShellSubscriptionClosedV4) => void) | undefined
    const closed = new Promise<AgentConversationShellSubscriptionClosedV4>(resolve => { resolveClosed = resolve })
    let connectionClose: AgentConversationShellSubscriptionClosedV4 | undefined
    let subscribed = false
    let unsubscribed = 0
    let disposed = 0
    const registration = runtime.register(plugin, binding => {
      const snapshot: AgentConversationShellSnapshotV4 = {
        binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
        generation: 'session-generation-v4', snapshotSequence: 0, selection: { kind: 'no-room' }, items: [],
        composer: { availability: 'available', placeholder: { key: 'composer', fallback: 'Message' }, disabled: { value: false }, submit: { id: 'send' } },
        headerActions: [],
      }
      const subscription = {
        subscriptionId: 'subscription-v4', binding: snapshot.binding, generation: snapshot.generation,
        afterSequence: 0, snapshotSequence: 0,
      }
      const close = (code: AgentConversationShellSubscriptionClosedV4['code']): AgentConversationShellSubscriptionClosedV4 => ({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v4.schema.json',
        contract: 'cordisx.agent-conversation-shell-subscription-close/v4', schemaVersion: 4,
        subscriptionId: subscription.subscriptionId, binding: subscription.binding, generation: subscription.generation,
        status: 'closed', code,
      })
      connectionClose = close('connection-replaced')
      return {
        snapshot: async () => snapshot,
        subscribe: async () => {
          subscribed = true
          return {
            result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
            handle: {
              subscription,
              pages: { async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}) } },
              closed,
              unsubscribe: async () => { unsubscribed += 1; return close('unsubscribed') },
            },
          }
        },
        updateRoomSettings: async request => ({
          type: 'update-room-settings', requestId: request.requestId, binding: request.binding,
          generation: request.generation, roomId: request.roomId, expectedSnapshotSequence: request.expectedSnapshotSequence,
          status: 'unavailable', code: 'settings-unavailable',
        }),
        dispose: () => { disposed += 1 },
      }
    }, undefined, 4)
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(subscribed).toBe(true))
    resolveClosed!(connectionClose!)
    await waitForRuntimeState(dom, 'unavailable')
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    registration.dispose()
    runtime.dispose()
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('exposes the agentConversationShell injection and owns registration on the plugin fiber', async () => {
    const dom = installDom()
    const root = new Context()
    const commands = root.plugin(CordisXCommandService)
    const i18n = root.plugin(CordisXI18nService)
    const pages = root.plugin(CordisXPageService)
    await commands
    await i18n
    await pages
    const shell = root.plugin(CordisXAgentConversationShellService)
    await shell
    let registration: ReturnType<Context['agentConversationShell']['registerSource']> | undefined
    const pluginContext = root.extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const plugin = pluginContext.plugin({
      inject: ['agentConversationShell', 'pages'],
      apply(ctx: Context) {
        registration = ctx.agentConversationShell.registerSource(binding => ({
          snapshot: async () => noRoom(binding),
          subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
          dispose() {},
        }))
        ctx.pages.register({
          $schema: CORDISX_PAGE_SCHEMA_V3,
          schemaVersion: 3,
          id: 'room',
          title: { key: 'page.room.title', fallback: 'New room' },
          description: { key: 'page.room.description', fallback: 'Host-rendered conversation.' },
        }, registration.mount)
      },
    })
    await plugin
    expect(registration?.mount).toBeTypeOf('function')
    expect((root.pages as CordisXPageService).registry.get('chatroom', 'room')?.presentation).toBe('agent-conversation')
    await plugin.dispose()
    expect(() => registration!.mount(mountContext(dom))).toThrow(/generation is unavailable/)
    await shell.dispose()
    await pages.dispose()
    await i18n.dispose()
    await commands.dispose()
    await settle()
    dom.window.close()
  })

  it('Host-binds a formal source, projects ordered updates, and delivers immutable command context', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let commandContext: CordisXCommandContext | undefined
    commands.register('chatroom', { id: 'create-with-message', title: { key: 'create-with-message', fallback: 'Create with message' } }, context => {
      commandContext = context
    })
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'chatroom-generation-1',
    })
    const stream = new PageStream()
    let issuedBinding: AgentConversationShellBinding | undefined
    let disposed = 0
    let unsubscribed = 0
    const registration = runtime.register(plugin, binding => {
      issuedBinding = binding
      const source: AgentConversationShellSource = {
        snapshot: async () => noRoom(binding),
        subscribe: async afterSequence => ({
          result: {
            type: 'subscribe', status: 'accepted', code: 'allowed',
            subscription: {
              subscriptionId: 'subscription-one',
              binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
              generation: 'snapshot-1',
              afterSequence,
              snapshotSequence: afterSequence,
            },
          },
          handle: {
            subscription: {
              subscriptionId: 'subscription-one',
              binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
              generation: 'snapshot-1',
              afterSequence,
              snapshotSequence: afterSequence,
            },
            pages: stream,
            unsubscribe: () => { unsubscribed += 1; stream.close() },
          },
        }),
        dispose: () => { disposed += 1 },
      }
      return source
    })

    const unmount = registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(issuedBinding).toBeDefined(), { timeout: 1_000, interval: 10 })
    expect(Object.isFrozen(issuedBinding)).toBe(true)
    expect(issuedBinding?.routeSelection).toEqual({ scope: 'room-or-new' })
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull(), { timeout: 1_000, interval: 10 })
    expect(dom.window.document.querySelectorAll('.cxa-chrome')).toHaveLength(1)
    expect(dom.window.document.querySelector('[data-agent-conversation-view="no-room"]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxa-title')?.textContent).toBe('New room')
    expect(dom.window.document.querySelectorAll('[role="log"]')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('.cxa-timeline-list > *')).toHaveLength(0)
    expect(dom.window.document.querySelectorAll('[data-agent-conversation-empty],.cxa-empty-mark,.cxa-empty-copy')).toHaveLength(0)
    const hostRoot = dom.window.document.getElementById('page')!
    expect(hostRoot.dataset.cordisxAppTheme).toBe('light')
    expect(hostRoot.style.getPropertyValue('--cx-text')).not.toBe('')
    dom.window.document.documentElement.dataset.theme = 'dark'
    await vi.waitFor(() => expect(hostRoot.dataset.cordisxAppTheme).toBe('dark'), { timeout: 1_000, interval: 10 })
    expect(hostRoot.style.getPropertyValue('--cx-surface')).toBe('#17191d')

    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    expect(draft.disabled).toBe(false)
    expect(send.disabled).toBe(true)
    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(draft, 'first room message')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(send.disabled).toBe(false), { timeout: 1_000, interval: 10 })
    send.click()
    await vi.waitFor(() => expect(commandContext?.hostContext).toMatchObject({
      binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
      generation: 'snapshot-1',
      scope: 'composer-submit',
      command: { id: 'create-with-message' },
      submitPayload: 'first room message',
    }), { timeout: 1_000, interval: 10 })
    expect(Object.isFrozen(commandContext?.hostContext)).toBe(true)
    expect(Object.isFrozen((commandContext?.hostContext as { binding: object }).binding)).toBe(true)

    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 0,
      phase: 'live',
      updates: [{ kind: 'snapshot-replaced', sequence: 1, snapshot: room(issuedBinding!) }],
      nextAfterSequence: 1,
      hasMore: false,
    })
    await vi.waitFor(() => expect(dom.window.document.querySelector('.cxa-title')?.textContent).toBe('Release review'), {
      timeout: 1_000, interval: 10,
    })
    expect(dom.window.document.querySelector('[data-agent-conversation-view="room"]')?.getAttribute('data-agent-conversation-room-id')).toBe('room-one')
    expect(dom.window.document.querySelector('.cxa-participants')).toBeNull()
    expect(dom.window.document.querySelector('.cxa-description-action')?.textContent).toBe('Add a room description')
    expect(dom.window.document.querySelectorAll('[data-agent-conversation-scroll-owner="timeline"]')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('.cxa-room-avatar-cell .cxa-avatar')).toHaveLength(1)
    expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')?.disabled).toBe(true)

    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 1,
      phase: 'live',
      updates: [{ kind: 'disposed', sequence: 2, reason: 'owner-disposed' }],
      nextAfterSequence: 2,
      hasMore: false,
    })
    await waitForRuntimeState(dom, 'unavailable')
    expect(dom.window.document.querySelector('.cxa-composer')).toBeNull()

    if (typeof unmount === 'function') unmount()
    expect(hostRoot.hasAttribute('data-cordisx-app-theme')).toBe(false)
    expect(hostRoot.style.getPropertyValue('--cx-text')).toBe('')
    registration.dispose()
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('fences Shell v3 Room settings updates to the exact binding, generation, room, and snapshot', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-v3' })
    const stream = new PageStream()
    const requests: unknown[] = []
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(plugin, current => {
      binding = current
      const subscription = {
        subscriptionId: 'subscription-v3-settings',
        binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration },
        generation: 'snapshot-v3', afterSequence: 1, snapshotSequence: 1,
      }
      return {
        snapshot: async () => ({
          ...room(current),
          generation: 'snapshot-v3',
          selection: { ...room(current).selection, description: { state: 'present', text: message('room.description', 'Current description') } },
        }) as never,
        subscribe: async () => ({
          result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
          handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
        }),
        updateRoomSettings: async (request: Record<string, unknown>) => {
          requests.push(request)
          return {
            type: 'update-room-settings' as const,
            requestId: request.requestId as string,
            binding: request.binding as { bindingId: string; ownerGeneration: string },
            generation: request.generation as string,
            roomId: request.roomId as string,
            expectedSnapshotSequence: request.expectedSnapshotSequence as number,
            status: 'applied' as const,
            code: 'applied' as const,
            snapshotSequence: (request.expectedSnapshotSequence as number) + 1,
          }
        },
        dispose() {},
      }
    })
    registration.mount(mountContext(dom, { roomId: 'room-one' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector('.cxa-description-action')?.textContent).toBe('Current description'), { timeout: 1_000, interval: 10 })
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-description-action')!.click()
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-host-schema-form="agent-conversation-room-settings"]')).not.toBeNull(), { timeout: 1_000, interval: 10 })
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-host-schema-form="agent-conversation-room-settings"] .cxf-item')).toHaveLength(2), { timeout: 1_000, interval: 10 })
    const nameField = dom.window.document.querySelector<HTMLInputElement>('input#cx-schema-agent-conversation-room-settings-0')!
    const descriptionField = dom.window.document.querySelector<HTMLTextAreaElement>('[data-host-schema-form="agent-conversation-room-settings"] textarea')!
    const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    const textAreaSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      inputSetter?.call(nameField, 'Renamed room')
      nameField.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      nameField.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      textAreaSetter?.call(descriptionField, 'Updated description')
      descriptionField.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      descriptionField.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect((dom.window.document.querySelector('[data-host-schema-form="agent-conversation-room-settings"] button') as HTMLButtonElement | null)?.disabled).toBe(false), { timeout: 1_000, interval: 10 })
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[data-host-schema-form="agent-conversation-room-settings"] button')!.click())
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 1_000, interval: 10 })
    expect(requests[0]).toMatchObject({
      binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
      generation: 'snapshot-v3', roomId: 'room-one', expectedSnapshotSequence: 1,
      patch: { name: 'Renamed room', description: { state: 'present', text: 'Updated description' } },
    })
    expect(Object.isFrozen(requests[0])).toBe(true)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('keeps self-introduction and normal Agent avatars bound to the same identity action across history rebind', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const settings = vi.fn()
    const navigateHost = vi.fn()
    let effectiveIdentityAvailable = true
    const identity = {
      resolve: vi.fn((candidate: { readonly agentId: string; readonly revision: string }) => effectiveIdentityAvailable
        && candidate.agentId === 'lead'
        && candidate.revision === 'revision-one'
        ? { identity: candidate, name: 'Lead exact', introduction: 'Coordinates the room and delegates focused work.' }
        : undefined),
      navigator: new HostAgentTaskDetailsNavigator({ navigateHost, navigateExternal: vi.fn() }),
      onSettings: settings,
    }
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n(), undefined, undefined, identity)
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-v3-identity' })
    const lead = {
      participantId: 'participant-lead', role: 'agent' as const, displayName: message('participant.lead', 'Lead source'),
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
      agentIdentity: { agentId: 'lead', revision: 'revision-one' },
    }
    const human = { participantId: 'participant-human', role: 'human' as const, displayName: message('participant.human', 'You') }
    const bindings: AgentConversationShellBinding[] = []
    const registration = runtime.register(plugin, binding => {
      bindings.push(binding)
      const stream = new PageStream()
      const mountOrdinal = bindings.length
      const generation = `snapshot-v3-identity-${mountOrdinal}`
      const lifecycle = mountOrdinal === 1 ? 'running' as const : 'waiting' as const
      const detailsUrl = mountOrdinal === 1 ? 'app://-/tasks/lead-history' : 'app://-/tasks/lead-current'
      const activeRuns = mountOrdinal === 3 ? [] : [{
        participantId: 'participant-lead', memberId: 'member-lead', runId: 'run-lead',
        lifecycle: { phase: lifecycle }, detailsUrl: { url: detailsUrl, target: 'host' as const },
      }]
      const subscription = {
        subscriptionId: `subscription-identity-${mountOrdinal}`,
        binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
        generation, afterSequence: 3, snapshotSequence: 3,
      }
      return {
        snapshot: async () => ({
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation, snapshotSequence: 3,
          selection: {
            kind: 'room' as const, roomId: 'room-identity', title: message('room.identity', 'Identity room'),
            multiParticipant: true, participantPresentation: 'host-initials' as const, participants: [lead, human],
            activeRuns,
          },
          items: [{
            kind: 'message' as const, itemId: 'self-introduction', messageId: 'message-introduction', sequence: 1,
            author: lead, source: 'agent-loop' as const,
            semantic: {
              purpose: 'member-self-introduction' as const, causation: { operationId: 'operation-introduction' },
              participantId: 'participant-lead', memberId: 'member-lead', runId: 'run-lead',
              binding: { bindingId: 'loop-binding-lead', generation: 1 }, turn: 'turn-introduction',
            },
            body: [{ kind: 'text' as const, text: message('message.introduction', 'I coordinate this room.') }],
            reactions: [], timestamp: '2026-08-31T00:00:00.000Z', deliveryState: 'delivered' as const,
            runState: 'idle' as const, ariaLive: 'polite' as const, actions: [],
          }, {
            kind: 'message' as const, itemId: 'human-message', messageId: 'message-human', sequence: 2,
            author: human, source: 'agent-loop' as const, semantic: { purpose: 'conversation' as const },
            body: [{ kind: 'text' as const, text: message('message.human', 'Please continue.') }],
            reactions: [], timestamp: '2026-08-31T00:00:01.000Z', deliveryState: 'delivered' as const,
            runState: 'idle' as const, ariaLive: 'off' as const, actions: [],
          }, {
            kind: 'message' as const, itemId: 'normal-reply', messageId: 'message-normal', sequence: 3,
            author: lead, source: 'agent-loop' as const,
            semantic: { purpose: 'conversation' as const, causation: { operationId: 'operation-normal' } },
            body: [{ kind: 'text' as const, text: message('message.normal', 'Continuing with the review.') }],
            reactions: [], timestamp: '2026-08-31T00:00:02.000Z', deliveryState: 'delivered' as const,
            runState: 'idle' as const, ariaLive: 'polite' as const, actions: [],
          }],
          composer: {
            availability: 'unavailable' as const, placeholder: message('composer.placeholder', 'Message'),
            disabled: { value: true }, submit: { id: 'send' },
          },
          headerActions: [],
        }),
        subscribe: async () => ({
          result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
          handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
        }),
        dispose: () => stream.close(),
      }
    })

    const assertIdentityActions = async (expectedLifecycle: 'running' | 'waiting', expectedDetailsUrl: string): Promise<void> => {
      await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.cx-agent-identity-avatar-button')).toHaveLength(2), { timeout: 1_000, interval: 10 })
      const introduction = dom.window.document.querySelector<HTMLElement>('[data-entry-id="self-introduction"]')!
      const normal = dom.window.document.querySelector<HTMLElement>('[data-entry-id="normal-reply"]')!
      for (const entry of [introduction, normal]) {
        const trigger = entry.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!
        expect(trigger.tagName).toBe('BUTTON')
        expect(trigger.getAttribute('aria-label')).toBe('Open Lead source')
        expect(trigger.querySelector('.cxa-avatar[data-avatar-kind="generated"]')).not.toBeNull()
      }
      introduction.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!.click()
      await vi.waitFor(() => expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact'), { timeout: 1_000, interval: 10 })
      const panel = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(panel.textContent).toContain('Coordinates the room and delegates focused work.')
      expect(panel.textContent).toContain('Identity room')
      expect(panel.textContent).toContain(`Agent task · ${expectedLifecycle}`)
      expect(panel.textContent).not.toContain(`Agent task · ${expectedLifecycle === 'running' ? 'waiting' : 'running'}`)
      expect(panel.closest('[data-host-conversation-inspector="true"]')).not.toBeNull()
      navigateHost.mockClear()
      dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!.click()
      await vi.waitFor(() => expect(navigateHost).toHaveBeenCalledWith(expectedDetailsUrl), { timeout: 1_000, interval: 10 })
      await vi.waitFor(() => expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 1_000, interval: 10 })
      normal.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!.click()
      await vi.waitFor(() => expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact'), { timeout: 1_000, interval: 10 })
      dom.window.document.querySelector<HTMLButtonElement>('.cx-conversation-inspector-icon-action')!.click()
    }

    const unmount = registration.mount(mountContext(dom, { roomId: 'room-identity' }))
    await assertIdentityActions('running', 'app://-/tasks/lead-history')
    if (typeof unmount === 'function') unmount()
    await settle()

    const unmountReloaded = registration.mount(mountContext(dom, { roomId: 'room-identity' }))
    await assertIdentityActions('waiting', 'app://-/tasks/lead-current')
    expect(bindings).toHaveLength(2)
    expect(bindings[1]?.bindingId).not.toBe(bindings[0]?.bindingId)
    expect(navigateHost).not.toHaveBeenCalledWith('app://-/tasks/lead-history')
    expect(identity.resolve).toHaveBeenCalledWith({ agentId: 'lead', revision: 'revision-one' })

    if (typeof unmountReloaded === 'function') unmountReloaded()
    await settle()

    effectiveIdentityAvailable = false
    const unmountMissingIdentity = registration.mount(mountContext(dom, { roomId: 'room-identity' }))
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.cxa-message')).toHaveLength(3), { timeout: 1_000, interval: 10 })
    expect(bindings).toHaveLength(3)
    expect(dom.window.document.querySelectorAll('.cx-agent-identity-avatar-button')).toHaveLength(0)
    for (const itemId of ['self-introduction', 'normal-reply']) {
      const entry = dom.window.document.querySelector<HTMLElement>(`[data-entry-id="${itemId}"]`)!
      expect(entry.querySelector('.cxa-message-avatar-seat > .cxa-avatar[data-avatar-kind="generated"]')).not.toBeNull()
    }

    if (typeof unmountMissingIdentity === 'function') unmountMissingIdentity()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('fails closed on cross-binding pages and disposes the source on unregistration', async () => {
    const dom = installDom()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const stream = new PageStream()
    let disposed = false
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async afterSequence => {
        const subscription = {
          subscriptionId: 'subscription-one',
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-1', afterSequence, snapshotSequence: afterSequence,
        }
        return { result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription }, handle: { subscription, pages: stream, unsubscribe: () => stream.close() } }
      },
      dispose: () => { disposed = true },
    }))
    registration.mount(mountContext(dom))
    await settle()
    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: 'cross-binding', ownerGeneration: 'g-cross' },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 0, phase: 'live', updates: [], nextAfterSequence: 0, hasMore: false,
    })
    await waitForRuntimeState(dom, 'error')
    expect(error).toHaveBeenCalledWith('[cordisx] Agent conversation source failed', expect.any(Error))
    registration.dispose()
    expect(disposed).toBe(true)
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects no-room snapshots that attempt to add a second header action', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => ({
        ...noRoom(binding),
        headerActions: [{
          id: 'new-room', label: message('action.new-room', 'New room'),
          command: { id: 'create' }, disabled: { value: false },
        }],
      }),
      subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
      dispose() {},
    }))
    registration.mount(mountContext(dom))
    await waitForRuntimeState(dom, 'error')
    expect(dom.window.document.querySelector('.cxa-composer')).toBeNull()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects premature live replay, non-monotonic updates, and replay watermark overshoot', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    for (const candidate of ['premature-live', 'sequence-gap', 'watermark-overshoot'] as const) {
      const stream = new PageStream()
      let binding: AgentConversationShellBinding | undefined
      const watermark = candidate === 'sequence-gap' ? 0 : 2
      const registration = runtime.register(plugin, currentBinding => {
        binding = currentBinding
        const subscription = {
          subscriptionId: `subscription-${candidate}`,
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-1', afterSequence: 0, snapshotSequence: watermark,
        }
        return {
          snapshot: async () => noRoom(currentBinding),
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
          }),
          dispose() {},
        }
      })
      registration.mount(mountContext(dom))
      await settle()
      const subscription = {
        subscriptionId: `subscription-${candidate}`,
        binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: watermark,
      }
      stream.push(candidate === 'premature-live' ? {
        subscription, afterSequence: 0, phase: 'live', updates: [], nextAfterSequence: 0, hasMore: false,
      } : candidate === 'sequence-gap' ? {
        subscription, afterSequence: 0, phase: 'live',
        updates: [{ kind: 'disposed', sequence: 2, reason: 'explicit' }],
        nextAfterSequence: 2, hasMore: false,
      } : {
        subscription, afterSequence: 0, phase: 'replay',
        updates: [1, 2, 3].map(sequence => ({
          kind: 'snapshot-replaced' as const,
          sequence,
          snapshot: { ...noRoom(binding!), snapshotSequence: sequence },
        })),
        nextAfterSequence: 3, hasMore: true,
      })
      await waitForRuntimeState(dom, 'error')
      registration.dispose()
      await settle()
      dom.window.document.getElementById('page')!.replaceChildren()
    }

    const compatibleStream = new PageStream()
    let compatibleBinding: AgentConversationShellBinding | undefined
    const compatible = runtime.register(plugin, currentBinding => {
      compatibleBinding = currentBinding
      const subscription = {
        subscriptionId: 'subscription-compatible-replay',
        binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 2,
      }
      return {
        snapshot: async () => noRoom(currentBinding),
        subscribe: async () => ({
          result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
          handle: { subscription, pages: compatibleStream, unsubscribe: () => compatibleStream.close() },
        }),
        dispose() {},
      }
    })
    compatible.mount(mountContext(dom))
    await settle()
    const compatibleSubscription = {
      subscriptionId: 'subscription-compatible-replay',
      binding: { bindingId: compatibleBinding!.bindingId, ownerGeneration: compatibleBinding!.ownerGeneration },
      generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 2,
    }
    compatibleStream.push({
      subscription: compatibleSubscription, afterSequence: 0, phase: 'replay',
      updates: [1, 2].map(sequence => ({
        kind: 'snapshot-replaced' as const,
        sequence,
        snapshot: { ...noRoom(compatibleBinding!), snapshotSequence: sequence },
      })),
      nextAfterSequence: 2, hasMore: true,
    })
    compatibleStream.push({
      subscription: compatibleSubscription, afterSequence: 2, phase: 'live',
      updates: [{ kind: 'disposed', sequence: 3, reason: 'explicit' }],
      nextAfterSequence: 3, hasMore: false,
    })
    await waitForRuntimeState(dom, 'unavailable')
    compatible.dispose()

    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects Shell v3 message, reaction, and approval association drift plus terminal approval rewrites', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-v3-associations' })
    const participant = {
      participantId: 'agent-one', role: 'agent' as const, displayName: message('participant.agent-one', 'Agent One'),
      agentIdentity: { agentId: 'agent-one', revision: 'revision-one' },
    }
    for (const candidate of [
      'message-association', 'reaction-identity', 'reaction-disappears', 'reaction-position',
      'reaction-duplicate-actor-value', 'reaction-value-extra', 'reaction-semantic-noncanonical',
      'reaction-emoji-noncanonical', 'reaction-terminal-append', 'approval-association', 'approval-terminal',
    ] as const) {
      const stream = new PageStream()
      let binding: AgentConversationShellBinding | undefined
      const initialMessage = {
        kind: 'message' as const, itemId: 'message-one', messageId: 'message-one', sequence: 1, source: 'agent-loop' as const,
        author: participant,
        semantic: { purpose: 'member-self-introduction' as const, causation: { operationId: 'intro:one' }, participantId: 'agent-one', memberId: 'member-one', runId: 'run-one', binding: { bindingId: 'loop:binding:one', generation: 1 }, turn: 'turn:intro' },
        body: [{ kind: 'text' as const, text: message('message.intro', 'I help review changes.') }],
        reactions: [
          { reactionId: 'reaction-one', actorParticipantId: 'agent-one', value: { kind: 'semantic' as const, token: 'acknowledged' }, state: 'pending' as const },
          { reactionId: 'reaction-two', actorParticipantId: 'agent-one', value: { kind: 'emoji' as const, emoji: '👍' }, state: 'pending' as const },
        ],
        timestamp: '2026-08-31T00:00:00.000Z', deliveryState: 'delivered' as const, runState: 'idle' as const, ariaLive: 'polite' as const, actions: [],
      }
      const initialApproval = {
        kind: 'approval' as const, itemId: 'approval-one', sequence: 2, participantId: 'agent-one', memberId: 'member-one', runId: 'run-one',
        binding: { bindingId: 'loop:binding:one', generation: 1 }, turn: 'turn:approval', approvalId: 'approval:one', approvalKind: 'command' as const,
        rationale: message('approval.rationale', 'Run checks'), state: 'pending' as const,
        actions: [{ decision: 'approve' as const, command: { id: 'approve' } }],
      }
      const registration = runtime.register(plugin, current => {
        binding = current
        const subscription = { subscriptionId: `subscription-${candidate}`, binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration }, generation: 'snapshot-v3', afterSequence: 2, snapshotSequence: 2 }
        return {
          snapshot: async () => ({
            binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration }, generation: 'snapshot-v3', snapshotSequence: 2,
            selection: { kind: 'room', roomId: 'room-one', title: message('room.title', 'Review'), multiParticipant: false, participantPresentation: 'none', participants: [participant], activeRuns: [{ participantId: 'agent-one', memberId: 'member-one', runId: 'run-one', lifecycle: { phase: 'active' }, detailsUrl: { url: 'app://-/tasks/one', target: 'host' } }] },
            items: [initialMessage, initialApproval],
            composer: { availability: 'unavailable', placeholder: message('composer.placeholder', 'Message'), disabled: { value: true }, submit: { id: 'send' } }, headerActions: [],
          }) as never,
          subscribe: async () => ({ result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription }, handle: { subscription, pages: stream, unsubscribe: () => stream.close() } }),
          dispose() {},
        }
      })
      registration.mount(mountContext(dom, { roomId: 'room-one' }))
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull(), { timeout: 1_000, interval: 10 })
      const subscription = { subscriptionId: `subscription-${candidate}`, binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration }, generation: 'snapshot-v3', afterSequence: 2, snapshotSequence: 2 }
      const page = (afterSequence: number, sequence: number, item: unknown) => ({ subscription, afterSequence, phase: 'live' as const, updates: [{ kind: 'item-updated' as const, sequence, item }], nextAfterSequence: sequence, hasMore: false })
      if (candidate === 'approval-terminal') {
        stream.push(page(2, 3, { ...initialApproval, state: 'approved', actions: [] }) as never)
        await settle()
        stream.push(page(3, 4, { ...initialApproval, state: 'denied', actions: [] }) as never)
      } else if (candidate === 'message-association') {
        stream.push(page(2, 3, { ...initialMessage, semantic: { ...initialMessage.semantic, turn: 'turn-forged' } }) as never)
      } else if (candidate === 'reaction-identity') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [{ ...initialMessage.reactions[0], actorParticipantId: 'forged-actor' }] }) as never)
      } else if (candidate === 'reaction-disappears') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [initialMessage.reactions[0]] }) as never)
      } else if (candidate === 'reaction-position') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [initialMessage.reactions[1], initialMessage.reactions[0]] }) as never)
      } else if (candidate === 'reaction-duplicate-actor-value') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [...initialMessage.reactions, { ...initialMessage.reactions[0], reactionId: 'reaction-three' }] }) as never)
      } else if (candidate === 'reaction-value-extra') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [{ ...initialMessage.reactions[0], value: { ...initialMessage.reactions[0].value, html: '<b>unsafe</b>' } }, initialMessage.reactions[1]] }) as never)
      } else if (candidate === 'reaction-semantic-noncanonical') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [initialMessage.reactions[0], { ...initialMessage.reactions[1], value: { kind: 'semantic', token: 'Acknowledged!' } }] }) as never)
      } else if (candidate === 'reaction-emoji-noncanonical') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [initialMessage.reactions[0], { ...initialMessage.reactions[1], value: { kind: 'emoji', emoji: 'not-an-emoji' } }] }) as never)
      } else if (candidate === 'reaction-terminal-append') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [...initialMessage.reactions, { reactionId: 'reaction-three', actorParticipantId: 'agent-one', value: { kind: 'semantic', token: 'done' }, state: 'completed' }] }) as never)
      } else {
        stream.push(page(2, 3, { ...initialApproval, approvalKind: 'file-change', state: 'approved', actions: [] }) as never)
      }
      await waitForRuntimeState(dom, 'error')
      registration.dispose()
      await settle()
      dom.window.document.getElementById('page')!.replaceChildren()
    }
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects invalid initial Shell v3 author, self-introduction, approval identity, and action associations', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const agentOne = { participantId: 'agent-one', role: 'agent' as const, displayName: message('agent.one', 'Agent One'), agentIdentity: { agentId: 'agent-one', revision: 'one' } }
    const agentTwo = { participantId: 'agent-two', role: 'agent' as const, displayName: message('agent.two', 'Agent Two'), agentIdentity: { agentId: 'agent-two', revision: 'one' } }
    const human = { participantId: 'human-one', role: 'human' as const, displayName: message('human.one', 'Human One') }
    const messageItem = {
      kind: 'message' as const, itemId: 'message-one', messageId: 'message-one', sequence: 1, source: 'agent-loop' as const,
      author: agentOne,
      semantic: { purpose: 'member-self-introduction' as const, causation: { operationId: 'intro-one' }, participantId: 'agent-one', memberId: 'member-one', runId: 'run-one', binding: { bindingId: 'binding-one', generation: 1 }, turn: 'turn-one' },
      body: [{ kind: 'text' as const, text: message('intro.one', 'I review changes.') }], reactions: [],
      timestamp: '2026-08-31T00:00:00.000Z', deliveryState: 'delivered' as const, runState: 'idle' as const, ariaLive: 'polite' as const, actions: [],
    }
    const approval = (itemId: string, participantId: string, memberId: string, runId: string, actions = [{ decision: 'approve' as const, command: { id: `approve-${itemId}` } }]) => ({
      kind: 'approval' as const, itemId, sequence: itemId === 'approval-one' ? 1 : 2, participantId, memberId, runId,
      binding: { bindingId: 'binding-one', generation: 1 }, turn: 'turn-approval', approvalId: 'approval-shared', approvalKind: 'command' as const,
      state: 'pending' as const, actions,
    })
    const candidates = [
      [{ ...messageItem, author: { ...agentOne, displayName: message('forged', 'Forged') } }],
      [{ ...messageItem, author: human, semantic: { ...messageItem.semantic, participantId: 'human-one', memberId: 'human-member', runId: 'human-run' } }],
      [{ ...messageItem, semantic: { ...messageItem.semantic, participantId: 'agent-two', memberId: 'member-two', runId: 'run-two' } }],
      [{ ...messageItem, itemId: 'message:one' }],
      [{ ...messageItem, semantic: { ...messageItem.semantic, causation: { operationId: '' } } }],
      [{ ...messageItem, semantic: { ...messageItem.semantic, causation: { operationId: 'x'.repeat(513) } } }],
      [approval('approval-one', 'agent-one', 'member-one', 'run-one'), approval('approval-two', 'agent-two', 'member-two', 'run-two')],
      [approval('approval-one', 'agent-one', 'member-one', 'run-one', [
        { decision: 'approve' as const, command: { id: 'approve-one' } },
        { decision: 'approve' as const, command: { id: 'approve-two' } },
      ])],
    ]
    for (const [index, items] of candidates.entries()) {
      const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: `chatroom-${index}`, [CORDISX_PLUGIN_GENERATION]: `generation-invalid-${index}` })
      const registration = runtime.register(plugin, binding => ({
        snapshot: async () => ({
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration }, generation: 'snapshot-invalid', snapshotSequence: 2,
          selection: {
            kind: 'room', roomId: 'room-one', title: message('room.one', 'Room'), multiParticipant: true, participantPresentation: 'compact',
            participants: [agentOne, agentTwo, human],
            activeRuns: [
              { participantId: 'agent-one', memberId: 'member-one', runId: 'run-one', lifecycle: { phase: 'active' }, detailsUrl: { url: 'app://-/tasks/one', target: 'host' } },
              { participantId: 'agent-two', memberId: 'member-two', runId: 'run-two', lifecycle: { phase: 'active' }, detailsUrl: { url: 'app://-/tasks/two', target: 'host' } },
              { participantId: 'human-one', memberId: 'human-member', runId: 'human-run', lifecycle: { phase: 'active' }, detailsUrl: { url: 'app://-/tasks/human', target: 'host' } },
            ],
          },
          items, composer: { availability: 'unavailable', placeholder: message('composer', 'Message'), disabled: { value: true }, submit: { id: 'send' } }, headerActions: [],
        }) as never,
        subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }) as never,
        dispose() {},
      }))
      registration.mount(mountContext(dom, { roomId: 'room-one' }))
      await waitForRuntimeState(dom, 'error')
      registration.dispose()
      dom.window.document.getElementById('page')!.replaceChildren()
    }
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('strictly discriminates unavailable subscriptions and releases every non-accepted source', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })

    let disposed = 0
    const unavailable = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
      dispose: () => { disposed += 1 },
    }))
    unavailable.mount(mountContext(dom))
    await waitForRuntimeState(dom, 'unavailable')
    expect(disposed).toBe(1)
    unavailable.dispose()
    expect(disposed).toBe(1)

    dom.window.document.getElementById('page')!.replaceChildren()
    let rejectedHandleUnsubscribed = 0
    const malformed = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async () => ({
        result: { type: 'subscribe', status: 'denied', code: 'policy-denied' },
        handle: { unsubscribe: () => { rejectedHandleUnsubscribed += 1 } },
      }) as never,
      dispose: () => { disposed += 1 },
    }))
    malformed.mount(mountContext(dom))
    await waitForRuntimeState(dom, 'error')
    expect(rejectedHandleUnsubscribed).toBe(1)
    expect(disposed).toBe(2)
    malformed.dispose()
    expect(disposed).toBe(2)

    for (const [index, status] of ['bogus', 42, undefined].entries()) {
      dom.window.document.getElementById('page')!.replaceChildren()
      const unknownStatus = runtime.register(plugin, binding => ({
        snapshot: async () => noRoom(binding),
        subscribe: async () => ({
          result: {
            type: 'subscribe',
            ...(status === undefined ? {} : { status }),
            code: 'policy-denied',
          },
        }) as never,
        dispose: () => { disposed += 1 },
      }))
      unknownStatus.mount(mountContext(dom))
      await waitForRuntimeState(dom, 'error')
      expect(disposed).toBe(3 + index)
      unknownStatus.dispose()
      expect(disposed).toBe(3 + index)
    }

    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
