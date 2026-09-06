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
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV7,
} from '@cordisx/protocol/agent-conversation-shell/v7'
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v2'
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
    Button: (
      { children, disabled, onClick, loading: _loading, theme: _theme, variant: _variant, ...props }:
        & Record<string, unknown>
        & { readonly children?: unknown; readonly disabled?: boolean; readonly onClick?: () => void },
    ) =>
      react.createElement('button', {
        ...props,
        type: 'button',
        disabled,
        onClick,
      }, children),
    Input: ({ onChange, ...props }: Record<string, unknown> & { readonly onChange?: (value: string) => void }) =>
      react.createElement('input', {
        ...props,
        onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
        onInput: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
      }),
    Textarea: (
      { onChange, autosize: _autosize, ...props }: Record<string, unknown> & {
        readonly onChange?: (value: string) => void
      },
    ) =>
      react.createElement('textarea', {
        ...props,
        onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
        onInput: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
      }),
  }
})
import {
  CORDISX_PAGE_SCHEMA_V3,
  type CordisXCommandContext,
  type CordisXPageMountContext,
} from '../packages/cli/src/contracts.js'
import {
  AgentConversationShellRegistry,
  CordisXAgentConversationShellService,
  projectAgentConversationShellSnapshotV4,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import {
  type PlaygroundScenarioConversationOrigin,
  type PlaygroundScenarioConversationSourceAuthority,
  PlaygroundScenarioSessionScopeAuthority,
} from '../packages/cli/src/renderer/playground-scenario-session-scope.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { CordisXPageService } from '../packages/cli/src/renderer/navigation.js'
import type { AgentRuntimeRouteScope } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import {
  CordisXAgentSessionRuntime,
  type CordisXPrivateAgentDriver,
} from '../packages/cli/src/renderer/agent-session-runtime.js'

class IdentitySessionDriver implements CordisXPrivateAgentDriver {
  private readonly replacements = new Set<() => void>()
  async create(input: { readonly sessionId: string }) {
    return {
      status: 'accepted' as const,
      detail: { kind: 'host' as const, ref: `deterministic-agent-session:${input.sessionId}` },
    }
  }
  async resume(input: { readonly sessionId: string }) {
    return {
      status: 'accepted' as const,
      detail: { kind: 'host' as const, ref: `deterministic-agent-session:${input.sessionId}` },
    }
  }
  async submit() {
    return 'accepted' as const
  }
  async discard() {
    return 'accepted' as const
  }
  async cancel() {
    return 'accepted' as const
  }
  onReplacement(listener: () => void): () => void {
    this.replacements.add(listener)
    return () => this.replacements.delete(listener)
  }
  replace(): void {
    for (const listener of this.replacements) listener()
  }
  dispose(): void {
    this.replacements.clear()
  }
}

class PageStream implements AsyncIterableIterator<AgentConversationShellPage> {
  private readonly pages: AgentConversationShellPage[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentConversationShellPage>) => void> = []
  private closed = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentConversationShellPage> {
    return this
  }

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
    executeConversationFor: (owner, reference, invocationKey, context) =>
      registry.execute(
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
  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', {
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
    })
  ) {
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
    controls: {
      select: () => {
        throw new Error('not used')
      },
      dispose() {},
    },
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
  it('fences Shell v3 Room settings updates to the exact binding, generation, room, and snapshot', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v3',
    })
    const stream = new PageStream()
    const requests: unknown[] = []
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(plugin, current => {
      binding = current
      const subscription = {
        subscriptionId: 'subscription-v3-settings',
        binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration },
        generation: 'snapshot-v3',
        afterSequence: 1,
        snapshotSequence: 1,
      }
      return {
        snapshot: async () =>
          ({
            ...room(current),
            generation: 'snapshot-v3',
            selection: {
              ...room(current).selection,
              description: { state: 'present', text: message('room.description', 'Current description') },
            },
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
    await vi.waitFor(
      () =>
        expect(dom.window.document.querySelector('.cxa-description-action')?.textContent).toBe('Current description'),
      { timeout: 1_000, interval: 10 },
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-description-action')!.click()
    await vi.waitFor(
      () => expect(dom.window.document.querySelector('.cxa-room-settings-form')).not.toBeNull(),
      { timeout: 1_000, interval: 10 },
    )
    const nameField = dom.window.document.querySelector<HTMLInputElement>(
      '.cxa-room-settings-form input[name="name"]',
    )!
    const descriptionField = dom.window.document.querySelector<HTMLTextAreaElement>(
      '.cxa-room-settings-form textarea[name="description"]',
    )!
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
    await vi.waitFor(
      () =>
        expect(
          (dom.window.document.querySelector('.cxa-room-settings-form button[type="submit"]') as
            | HTMLButtonElement
            | null)?.disabled,
        ).toBe(false),
      { timeout: 1_000, interval: 10 },
    )
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        '.cxa-room-settings-form button[type="submit"]',
      )!.click()
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 1_000, interval: 10 })
    expect(requests[0]).toMatchObject({
      binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
      generation: 'snapshot-v3',
      roomId: 'room-one',
      expectedSnapshotSequence: 1,
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
      resolve: vi.fn((candidate: { readonly agentId: string; readonly revision: string }) =>
        effectiveIdentityAvailable
          && candidate.agentId === 'lead'
          && candidate.revision === 'revision-one'
          ? {
            identity: candidate,
            name: 'Lead exact',
            introduction: 'Coordinates the room and delegates focused work.',
          }
          : undefined
      ),
      navigator: new HostAgentTaskDetailsNavigator({ navigateHost, navigateExternal: vi.fn() }),
      onSettings: settings,
    }
    const runtime = new AgentConversationShellRegistry(
      commandService(commands),
      fakeI18n(),
      undefined,
      undefined,
      identity,
    )
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v3-identity',
    })
    const lead = {
      participantId: 'participant-lead',
      role: 'agent' as const,
      displayName: message('participant.lead', 'Lead source'),
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
      agentIdentity: { agentId: 'lead', revision: 'revision-one' },
    }
    const human = {
      participantId: 'participant-human',
      role: 'human' as const,
      displayName: message('participant.human', 'You'),
    }
    const bindings: AgentConversationShellBinding[] = []
    const registration = runtime.register(plugin, binding => {
      bindings.push(binding)
      const stream = new PageStream()
      const mountOrdinal = bindings.length
      const generation = `snapshot-v3-identity-${mountOrdinal}`
      const lifecycle = mountOrdinal === 1 ? 'running' as const : 'waiting' as const
      const detailsUrl = mountOrdinal === 1 ? 'app://-/tasks/lead-history' : 'app://-/tasks/lead-current'
      const activeRuns = mountOrdinal === 3 ? [] : [{
        participantId: 'participant-lead',
        memberId: 'member-lead',
        runId: 'run-lead',
        lifecycle: { phase: lifecycle },
        detailsUrl: { url: detailsUrl, target: 'host' as const },
      }]
      const subscription = {
        subscriptionId: `subscription-identity-${mountOrdinal}`,
        binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
        generation,
        afterSequence: 3,
        snapshotSequence: 3,
      }
      return {
        snapshot: async () => ({
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation,
          snapshotSequence: 3,
          selection: {
            kind: 'room' as const,
            roomId: 'room-identity',
            title: message('room.identity', 'Identity room'),
            multiParticipant: true,
            participantPresentation: 'host-initials' as const,
            participants: [lead, human],
            activeRuns,
          },
          items: [{
            kind: 'message' as const,
            itemId: 'self-introduction',
            messageId: 'message-introduction',
            sequence: 1,
            author: lead,
            source: 'agent-loop' as const,
            semantic: {
              purpose: 'member-self-introduction' as const,
              causation: { operationId: 'operation-introduction' },
              participantId: 'participant-lead',
              memberId: 'member-lead',
              runId: 'run-lead',
              binding: { bindingId: 'loop-binding-lead', generation: 1 },
              turn: 'turn-introduction',
            },
            body: [{ kind: 'text' as const, text: message('message.introduction', 'I coordinate this room.') }],
            reactions: [],
            timestamp: '2026-08-31T00:00:00.000Z',
            deliveryState: 'delivered' as const,
            runState: 'idle' as const,
            ariaLive: 'polite' as const,
            actions: [],
          }, {
            kind: 'message' as const,
            itemId: 'human-message',
            messageId: 'message-human',
            sequence: 2,
            author: human,
            source: 'agent-loop' as const,
            semantic: { purpose: 'conversation' as const },
            body: [{ kind: 'text' as const, text: message('message.human', 'Please continue.') }],
            reactions: [],
            timestamp: '2026-08-31T00:00:01.000Z',
            deliveryState: 'delivered' as const,
            runState: 'idle' as const,
            ariaLive: 'off' as const,
            actions: [],
          }, {
            kind: 'message' as const,
            itemId: 'normal-reply',
            messageId: 'message-normal',
            sequence: 3,
            author: lead,
            source: 'agent-loop' as const,
            semantic: { purpose: 'conversation' as const, causation: { operationId: 'operation-normal' } },
            body: [{ kind: 'text' as const, text: message('message.normal', 'Continuing with the review.') }],
            reactions: [],
            timestamp: '2026-08-31T00:00:02.000Z',
            deliveryState: 'delivered' as const,
            runState: 'idle' as const,
            ariaLive: 'polite' as const,
            actions: [],
          }],
          composer: {
            availability: 'unavailable' as const,
            placeholder: message('composer.placeholder', 'Message'),
            disabled: { value: true },
            submit: { id: 'send' },
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

    const assertIdentityActions = async (
      expectedLifecycle: 'running' | 'waiting',
      expectedDetailsUrl: string,
    ): Promise<void> => {
      await vi.waitFor(
        () => expect(dom.window.document.querySelectorAll('.cx-agent-identity-avatar-button')).toHaveLength(2),
        { timeout: 1_000, interval: 10 },
      )
      const introduction = dom.window.document.querySelector<HTMLElement>('[data-entry-id="self-introduction"]')!
      const normal = dom.window.document.querySelector<HTMLElement>('[data-entry-id="normal-reply"]')!
      for (const entry of [introduction, normal]) {
        const trigger = entry.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!
        expect(trigger.tagName).toBe('BUTTON')
        expect(trigger.getAttribute('aria-label')).toBe('Open Lead source')
        expect(trigger.querySelector('.cxa-avatar[data-avatar-kind="generated"]')).not.toBeNull()
      }
      introduction.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!.click()
      await vi.waitFor(
        () => expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact'),
        { timeout: 1_000, interval: 10 },
      )
      const panel = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(panel.textContent).toContain('Coordinates the room and delegates focused work.')
      expect(panel.textContent).toContain('Identity room')
      expect(panel.textContent).toContain(`Agent task · ${expectedLifecycle}`)
      expect(panel.textContent).not.toContain(`Agent task · ${expectedLifecycle === 'running' ? 'waiting' : 'running'}`)
      expect(panel.closest('[data-host-conversation-inspector="true"]')).not.toBeNull()
      navigateHost.mockClear()
      dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!.click()
      await vi.waitFor(() => expect(navigateHost).toHaveBeenCalledWith(expectedDetailsUrl), {
        timeout: 1_000,
        interval: 10,
      })
      await vi.waitFor(() => expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull(), {
        timeout: 1_000,
        interval: 10,
      })
      normal.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!.click()
      await vi.waitFor(
        () => expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact'),
        { timeout: 1_000, interval: 10 },
      )
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
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.cxa-message')).toHaveLength(3), {
      timeout: 1_000,
      interval: 10,
    })
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
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-1',
    })
    const stream = new PageStream()
    let disposed = false
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async afterSequence => {
        const subscription = {
          subscriptionId: 'subscription-one',
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-1',
          afterSequence,
          snapshotSequence: afterSequence,
        }
        return {
          result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
          handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
        }
      },
      dispose: () => {
        disposed = true
      },
    }))
    registration.mount(mountContext(dom))
    await settle()
    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: 'cross-binding', ownerGeneration: 'g-cross' },
        generation: 'snapshot-1',
        afterSequence: 0,
        snapshotSequence: 0,
      },
      afterSequence: 0,
      phase: 'live',
      updates: [],
      nextAfterSequence: 0,
      hasMore: false,
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
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-1',
    })
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => ({
        ...noRoom(binding),
        headerActions: [{
          id: 'new-room',
          label: message('action.new-room', 'New room'),
          command: { id: 'create' },
          disabled: { value: false },
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-1',
    })
    for (const candidate of ['premature-live', 'sequence-gap', 'watermark-overshoot'] as const) {
      const stream = new PageStream()
      let binding: AgentConversationShellBinding | undefined
      const watermark = candidate === 'sequence-gap' ? 0 : 2
      const registration = runtime.register(plugin, currentBinding => {
        binding = currentBinding
        const subscription = {
          subscriptionId: `subscription-${candidate}`,
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-1',
          afterSequence: 0,
          snapshotSequence: watermark,
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
        generation: 'snapshot-1',
        afterSequence: 0,
        snapshotSequence: watermark,
      }
      stream.push(
        candidate === 'premature-live'
          ? {
            subscription,
            afterSequence: 0,
            phase: 'live',
            updates: [],
            nextAfterSequence: 0,
            hasMore: false,
          }
          : candidate === 'sequence-gap'
          ? {
            subscription,
            afterSequence: 0,
            phase: 'live',
            updates: [{ kind: 'disposed', sequence: 2, reason: 'explicit' }],
            nextAfterSequence: 2,
            hasMore: false,
          }
          : {
            subscription,
            afterSequence: 0,
            phase: 'replay',
            updates: [1, 2, 3].map(sequence => ({
              kind: 'snapshot-replaced' as const,
              sequence,
              snapshot: { ...noRoom(binding!), snapshotSequence: sequence },
            })),
            nextAfterSequence: 3,
            hasMore: true,
          },
      )
      await waitForRuntimeState(dom, 'error')
      if (candidate === 'sequence-gap') {
        expect(error).toHaveBeenCalledWith(
          '[cordisx] Agent conversation source failed',
          expect.objectContaining({
            message: 'subscription updates are not monotonic (expected 1, received 2, page after 0)',
          }),
        )
      }
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
        generation: 'snapshot-1',
        afterSequence: 0,
        snapshotSequence: 2,
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
      generation: 'snapshot-1',
      afterSequence: 0,
      snapshotSequence: 2,
    }
    compatibleStream.push({
      subscription: compatibleSubscription,
      afterSequence: 0,
      phase: 'replay',
      updates: [1, 2].map(sequence => ({
        kind: 'snapshot-replaced' as const,
        sequence,
        snapshot: { ...noRoom(compatibleBinding!), snapshotSequence: sequence },
      })),
      nextAfterSequence: 2,
      hasMore: true,
    })
    compatibleStream.push({
      subscription: compatibleSubscription,
      afterSequence: 2,
      phase: 'live',
      updates: [{ kind: 'disposed', sequence: 3, reason: 'explicit' }],
      nextAfterSequence: 3,
      hasMore: false,
    })
    await waitForRuntimeState(dom, 'unavailable')
    compatible.dispose()

    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
