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
  it('opens recovered Shell v4 AgentSetup identity details from members and avatars, then fences stale generations', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const driver = new IdentitySessionDriver()
    const definition = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json' as const,
      contract: 'cordisx.agent-definition/v1' as const,
      schemaVersion: 1 as const,
      identity: { agentId: 'lead', revision: 'session-revision-one' },
      name: 'Lead exact',
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
      promptSections: [{
        sectionId: 'introduction',
        kind: 'introduction' as const,
        text: 'Coordinates the Session-native room.',
      }],
      inherit: {
        promptSections: 'none' as const,
        rules: 'none' as const,
        skills: 'none' as const,
        tools: 'none' as const,
        mcpServers: 'none' as const,
        runtimeDefaults: 'none' as const,
      },
    }
    const sessionId = 'cx-session.identity-v4'
    const authority = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      initialSessions: [{
        id: sessionId,
        generation: 1,
        header: { id: sessionId, formatVersion: 1, createdAt: 1, isSeeded: false },
        events: [],
        setup: { definition: definition.identity, definitions: [definition] },
      }],
    })
    expect(authority.definitionPresentation(definition.identity)).toMatchObject({ name: 'Lead exact' })
    const navigateHost = vi.fn()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n(), undefined, undefined, {
      resolve: value => authority.definitionPresentation(value),
      navigator: new HostAgentTaskDetailsNavigator({ navigateHost, navigateExternal: vi.fn() }),
      onSettings: vi.fn(),
    })
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v4-identity',
    })
    const participant = {
      participantId: 'participant-lead',
      role: 'agent' as const,
      displayName: message('participant.lead', 'Lead source'),
      avatar: definition.avatar,
      agentIdentity: definition.identity,
    }
    const registration = runtime.register(
      plugin,
      binding => {
        const snapshot: AgentConversationShellSnapshotV4 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'session-generation-v4-identity',
          snapshotSequence: 1,
          selection: {
            kind: 'room',
            roomId: 'room-v4-identity',
            title: message('room.identity', 'Identity room'),
            multiParticipant: true,
            participantPresentation: 'host-initials',
            participants: [participant],
            activeRuns: [{
              participantId: participant.participantId,
              memberId: 'member-lead',
              runId: 'run-lead',
              sessionId,
              lifecycle: { phase: 'running' },
              details: { kind: 'host', ref: `deterministic-agent-session:${sessionId}` },
            }],
          },
          items: [{
            kind: 'message',
            itemId: 'message-entry',
            messageId: 'message-one',
            sequence: 1,
            author: participant,
            source: { kind: 'session-event', sessionId, eventSeq: 1 },
            semantic: { purpose: 'conversation' },
            body: [{ kind: 'text', text: message('message.one', 'Hello @Lead source') }],
            reactions: [],
            timestamp: '2026-09-03T00:00:00.000Z',
            deliveryState: 'delivered',
            runState: 'idle',
            ariaLive: 'off',
            actions: [],
          }],
          composer: {
            availability: 'unavailable',
            placeholder: message('composer', 'Message'),
            disabled: { value: true },
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v4-identity',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 1,
          snapshotSequence: 1,
        }
        const close = (code: 'unsubscribed') => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v4.schema.json' as const,
          contract: 'cordisx.agent-conversation-shell-subscription-close/v4' as const,
          schemaVersion: 4 as const,
          subscriptionId: subscription.subscriptionId,
          binding: subscription.binding,
          generation: subscription.generation,
          status: 'closed' as const,
          code,
        })
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>(() => {})
                },
              },
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => close('unsubscribed'),
            },
          }),
          dispose() {},
        }
      },
      undefined,
      4,
    )

    const firstUnmount = registration.mount(mountContext(dom, { roomId: 'room-v4-identity' }))
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('.cxa-header-icon-action[aria-label="Members"]')).not.toBeNull()
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-header-icon-action[aria-label="Members"]')!.click()
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector<HTMLButtonElement>('.cxa-member-button')?.disabled).toBe(false)
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-member-button')!.click()
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact')
    )
    expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Coordinates the Session-native room.',
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cx-conversation-inspector-icon-action')!.click()
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Close members"]')).not.toBeNull()
    )
    dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Close members"]')!.click()
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull())
    dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!.click()
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Lead exact')
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!.click()
    await vi.waitFor(() =>
      expect(navigateHost).toHaveBeenCalledWith('app://-/playground/simulator/tasks/cx-session.identity-v4')
    )
    if (typeof firstUnmount === 'function') firstUnmount()
    await settle()

    driver.replace()
    expect(authority.definitionPresentation(definition.identity)).toBeUndefined()
    const staleUnmount = registration.mount(mountContext(dom, { roomId: 'room-v4-identity' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector('.cxa-message-mention')).not.toBeNull())
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-message-mention')!.click()
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[data-host-conversation-member-search="true"] input')).not.toBeNull()
    )
    expect(
      dom.window.document.querySelector<HTMLInputElement>('[data-host-conversation-member-search="true"] input')?.value,
    ).toBe('Lead source')
    expect(dom.window.document.querySelector<HTMLButtonElement>('.cxa-member-button')?.disabled).toBe(true)
    if (typeof staleUnmount === 'function') staleUnmount()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await authority.dispose()
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
    commands.register('chatroom', {
      id: 'create-with-message',
      title: { key: 'create-with-message', fallback: 'Create with message' },
    }, context => {
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
            type: 'subscribe',
            status: 'accepted',
            code: 'allowed',
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
            unsubscribe: () => {
              unsubscribed += 1
              stream.close()
            },
          },
        }),
        dispose: () => {
          disposed += 1
        },
      }
      return source
    })

    const unmount = registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(issuedBinding).toBeDefined(), { timeout: 1_000, interval: 10 })
    expect(Object.isFrozen(issuedBinding)).toBe(true)
    expect(issuedBinding?.routeSelection).toEqual({ scope: 'room-or-new' })
    await vi.waitFor(
      () => expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull(),
      { timeout: 1_000, interval: 10 },
    )
    expect(dom.window.document.querySelectorAll('.cxa-chrome')).toHaveLength(1)
    expect(dom.window.document.querySelector('[data-agent-conversation-view="no-room"]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxa-title')?.textContent).toBe('New room')
    expect(dom.window.document.querySelectorAll('[role="log"]')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('.cxa-timeline-list > *')).toHaveLength(0)
    expect(dom.window.document.querySelectorAll('[data-agent-conversation-empty],.cxa-empty-mark,.cxa-empty-copy'))
      .toHaveLength(0)
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
    await vi.waitFor(() =>
      expect(commandContext?.hostContext).toMatchObject({
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
        generation: 'snapshot-1',
        afterSequence: 0,
        snapshotSequence: 0,
      },
      afterSequence: 0,
      phase: 'live',
      updates: [{ kind: 'snapshot-replaced', sequence: 1, snapshot: room(issuedBinding!) }],
      nextAfterSequence: 1,
      hasMore: false,
    })
    await vi.waitFor(
      () => expect(dom.window.document.querySelector('.cxa-title')?.textContent).toBe('Release review'),
      {
        timeout: 1_000,
        interval: 10,
      },
    )
    expect(
      dom.window.document.querySelector('[data-agent-conversation-view="room"]')?.getAttribute(
        'data-agent-conversation-room-id',
      ),
    ).toBe('room-one')
    expect(dom.window.document.querySelector('.cxa-participants')).toBeNull()
    expect(dom.window.document.querySelector('.cxa-description-action')?.textContent).toBe('Add a room description')
    expect(dom.window.document.querySelectorAll('[data-agent-conversation-scroll-owner="timeline"]')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('.cxrv-participant .cxa-avatar')).toHaveLength(1)
    expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')?.disabled).toBe(true)

    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
        generation: 'snapshot-1',
        afterSequence: 0,
        snapshotSequence: 0,
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
})
