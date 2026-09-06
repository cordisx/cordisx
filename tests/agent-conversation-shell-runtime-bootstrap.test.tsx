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
  it('always gives a fresh Shell v9 Room composer a frozen bootstrap origin before a run exists', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let commandContext: CordisXCommandContext | undefined
    commands.register('chatroom', { id: 'send-v9', title: { key: 'send-v9', fallback: 'Send' } }, context => {
      commandContext = context
    })
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v9',
    })
    const stream = new PageStream()
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-v9',
          snapshotSequence: 0,
          selection: {
            kind: 'room',
            roomId: 'room-v9-fresh',
            title: message('room.v9', 'Fresh v9 room'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: [{ participantId: 'lead', role: 'agent', displayName: message('lead', 'Lead') }],
            activeRuns: [],
          },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send-v9' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v9',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                stream.close()
              },
            },
          }),
          dispose() {},
        }
      },
      undefined,
      9,
    )
    registration.mount(mountContext(dom, { roomId: 'room-v9-fresh' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(draft, 'bootstrap first delivery')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() =>
      expect(commandContext?.hostContext).toMatchObject({
        scope: 'composer-submit',
        origin: {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
          binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
          generation: binding!.ownerGeneration,
          commandId: 'send-v9',
          scope: 'composer-submit',
        },
      })
    )
    const origin = (commandContext?.hostContext as { readonly origin?: Record<string, unknown> }).origin
    expect(origin).toBeDefined()
    expect(origin).not.toHaveProperty('room')
    expect(Object.isFrozen(origin)).toBe(true)
    expect(Object.isFrozen(origin?.binding)).toBe(true)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('routes an opted-in Shell v9 composer through the mounted page-admission v2 adapter', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const legacyHandler = vi.fn()
    commands.register(
      'chatroom',
      { id: 'send-v9-page', title: { key: 'send-v9-page', fallback: 'Send' } },
      legacyHandler,
    )
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v9-page',
    })
    const stream = new PageStream()
    const registration = runtime.register(
      plugin,
      currentBinding => {
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: {
            bindingId: currentBinding.bindingId,
            ownerGeneration: currentBinding.ownerGeneration,
          },
          generation: 'snapshot-v9-page',
          snapshotSequence: 0,
          selection: { kind: 'no-room' },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send-v9-page' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v9-page',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: {
              type: 'subscribe' as const,
              status: 'accepted' as const,
              code: 'allowed' as const,
              subscription,
            },
            handle: {
              subscription,
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                stream.close()
              },
            },
          }),
          dispose() {},
        }
      },
      undefined,
      9,
      { composer: { mode: 'page-composer-v2' } },
    )
    const execute = vi.fn(async () => ({ status: 'accepted' as const, code: 'completed' as const }))
    registration.mount({
      ...mountContext(dom),
      pageComposer: { execute },
    })
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(draft, 'page admission delivery')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-request.v1.schema.json',
        contract: 'cordisx.agent-page-composer-command-request/v1',
        schemaVersion: 1,
        command: { id: 'send-v9-page' },
        submitPayload: 'page admission delivery',
      })
    )
    expect(legacyHandler).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(draft.value).toBe(''))
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('keeps an existing Shell v9 Room on its exact v1 target origin through command completion', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const scenarioOwner = { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 } as const
    let mounted: AgentRuntimeRouteScope | undefined
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'shell-v9-existing-room',
      connectionGeneration: () => 1,
      currentRoute: () => undefined,
      ownerForSession: sessionId =>
        ['cx-session.existing-lead', 'cx-session.existing-reviewer'].includes(sessionId) ? scenarioOwner : undefined,
      routeOwner: candidate =>
        candidate.pluginId === scenarioOwner.pluginId && candidate.generation === scenarioOwner.generation
          ? { source: 'file:///fixtures/chatroom.ts', pluginId: 'chatroom' }
          : undefined,
      permissionRoute: () => ({
        routeId: 'room-session-detail',
        path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
      }),
      authorize: async () => true,
      mountRoute: route => {
        mounted = route
        return () => {
          mounted = undefined
        }
      },
      changed: () => {},
    })
    let captured = false
    commands.register(
      'chatroom',
      { id: 'send-v9-existing', title: { key: 'send-v9-existing', fallback: 'Send' } },
      context => {
        const origin = (context.hostContext as { readonly origin?: AgentCommandOrigin }).origin
        if (origin === undefined) throw new Error('Shell v9 existing Room lost its exact target origin')
        expect(origin.room).toEqual({
          roomId: 'room-existing',
          participantId: 'leader',
          memberId: 'member-leader',
          runId: 'run-leader',
        })
        const capture = authority.captureAdmission(
          scenarioOwner,
          origin,
          'cx-session.existing-lead',
          1,
          'cx-message.existing-third',
        )
        expect(capture?.active()).toBe(true)
        capture?.commit()
        captured = true
      },
    )
    const runtime = new AgentConversationShellRegistry(
      commandService(commands),
      fakeI18n(),
      undefined,
      undefined,
      undefined,
      authority.conversationSource,
      owner => owner === 'chatroom' ? scenarioOwner : undefined,
    )
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'shell-v9-existing-generation',
    })
    const stream = new PageStream()
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'shell-v9-existing-snapshot',
          snapshotSequence: 0,
          selection: {
            kind: 'room',
            roomId: 'room-existing',
            title: message('room.existing', 'Existing Room'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: [{ participantId: 'leader', role: 'agent', displayName: message('leader', 'Lead') }],
            activeRuns: [{
              participantId: 'leader',
              memberId: 'member-leader',
              runId: 'run-leader',
              sessionId: 'cx-session.existing-lead',
              lifecycle: { phase: 'active' },
            }],
          },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send-v9-existing' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v9-existing',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                stream.close()
              },
            },
          }),
          dispose() {},
        }
      },
      undefined,
      9,
    )
    registration.mount(mountContext(dom, { roomId: 'room-existing' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(draft, '3')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() => expect(captured).toBe(true))
    const activated = await authority.client.activate({
      runId: 'scenario-existing-room-third-message',
      sourceMessageId: 'cx-message.existing-third',
      sourceSessionId: 'cx-session.existing-lead',
      targetSessionId: 'cx-session.existing-reviewer',
    })
    expect(activated.status).toBe('available')
    expect(mounted?.params.sessionId).toBe('cx-session.existing-reviewer')
    registration.dispose()
    expect(binding).toBeDefined()
    if (activated.status === 'available') {
      await expect(activated.handle.closed).resolves.toEqual({ code: 'route-replaced' })
    }
    runtime.dispose()
    commands.dispose()
    authority.dispose()
    await settle()
    dom.window.close()
  })

  it('Host-claims a matching v6 Room route continuation synchronously when the new binding mounts', () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let mountReturned = false
    const claims: Array<
      { readonly owner: string; readonly routeId: string; readonly roomId: string; readonly bindingId: string }
    > = []
    const sourceAuthority: PlaygroundScenarioConversationSourceAuthority = {
      execute: async (_origin, operation) => await operation(),
      fenceBinding: () => {},
      claimBootstrapRoute: input => {
        expect(mountReturned).toBe(false)
        claims.push({
          owner: input.owner.pluginId,
          routeId: input.binding.route.routeId,
          roomId: input.binding.route.roomId,
          bindingId: input.binding.binding.bindingId,
        })
      },
    }
    const runtime = new AgentConversationShellRegistry(
      commandService(commands),
      fakeI18n(),
      undefined,
      undefined,
      undefined,
      sourceAuthority,
      owner => owner === 'chatroom' ? { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 } : undefined,
    )
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v9-route-claim',
    })
    const registration = runtime.register(
      plugin,
      binding => {
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-v9-route-claim',
          snapshotSequence: 0,
          selection: {
            kind: 'room',
            roomId: 'room-after-submit',
            title: message('room.route', 'Route claim room'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: [],
            activeRuns: [],
          },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send-v9-route-claim' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v9-route-claim',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
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
              unsubscribe: async () => {},
            },
          }),
          dispose() {},
        }
      },
      undefined,
      9,
    )
    const unmount = registration.mount({
      ...mountContext(dom, { roomId: 'room-after-submit' }),
      routeDefinitionId: 'room',
    })
    mountReturned = true
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      owner: 'file:///fixtures/chatroom.ts:chatroom',
      routeId: 'room',
      roomId: 'room-after-submit',
      bindingId: expect.any(String),
    })
    unmount?.()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    dom.window.close()
  })

  it('keeps a fresh no-room Shell v9 composer command live for its first bootstrap target declaration', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let commandContext: CordisXCommandContext | undefined
    let commandOrigin: PlaygroundScenarioConversationOrigin | undefined
    const sourceAuthority: PlaygroundScenarioConversationSourceAuthority = {
      execute: async (origin, operation) => {
        commandOrigin = origin
        return await operation()
      },
      fenceBinding: () => {},
      claimBootstrapRoute: () => {},
    }
    commands.register('chatroom', { id: 'create-v9', title: { key: 'create-v9', fallback: 'Create' } }, context => {
      commandContext = context
    })
    const runtime = new AgentConversationShellRegistry(
      commandService(commands),
      fakeI18n(),
      undefined,
      undefined,
      undefined,
      sourceAuthority,
      owner =>
        owner === 'chatroom'
          ? { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 }
          : undefined,
    )
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v9-no-room',
    })
    const stream = new PageStream()
    const registration = runtime.register(
      plugin,
      binding => {
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-v9-no-room',
          snapshotSequence: 0,
          selection: { kind: 'no-room' },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'create-v9' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v9-no-room',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                stream.close()
              },
            },
          }),
          dispose() {},
        }
      },
      undefined,
      9,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(draft, 'first delivery creates the Room')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() =>
      expect(commandContext?.hostContext).toMatchObject({
        scope: 'composer-submit',
        origin: { commandId: 'create-v9' },
      })
    )
    await vi.waitFor(() => expect(commandOrigin).toBeDefined())
    expect(commandOrigin).toMatchObject({
      owner: { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 },
      runs: [],
      bootstrapOrigin: {
        commandId: 'create-v9',
        scope: 'composer-submit',
      },
    })
    expect(commandOrigin?.roomId).toBeUndefined()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
